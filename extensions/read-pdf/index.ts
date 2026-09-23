/**
 * read-pdf — let multimodal models read PDF files.
 *
 * Registers a `read_pdf` tool that renders PDF pages to PNG images (via
 * macOS PDFKit through a small embedded Swift script — zero external
 * dependencies) and returns them as image blocks, which multimodal models
 * consume natively. Also intercepts built-in `read` calls targeting .pdf
 * files and redirects the model to this tool.
 *
 * Rendering: macOS uses the system Swift + PDFKit (zero dependencies);
 * Linux/Windows uses poppler's pdftoppm (Debian/WSL: apt install poppler-utils,
 * Arch: pacman -S poppler).
 *
 * Params: path (required), firstPage (1-based, default 1), maxPages (default 8, cap 20).
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext, ImageContent, TextContent } from "@earendil-works/pi-coding-agent";

const DEFAULT_MAX_PAGES = 8;
const HARD_MAX_PAGES = 20;
const SCALE = 2.0; // 2x page rect ≈ 144 dpi, readable and token-reasonable

/** Renders pages [firstPage, firstPage+maxPages) of `pdfPath` into `outDir` as PNG (macOS: PDFKit via Swift). */
const SWIFT_SOURCE = `
import Foundation
import PDFKit
import AppKit

let a = CommandLine.arguments
guard a.count >= 3 else { FileHandle.standardError.write("usage: swift - <pdf> <outDir> [scale] [maxPages] [firstPage]".data(using: .utf8)!); exit(2) }
let scale = a.count > 3 ? Double(a[3]) ?? 2.0 : 2.0
let maxPages = a.count > 4 ? Int(a[4]) ?? 8 : 8
let firstPage = a.count > 5 ? Int(a[5]) ?? 1 : 1
guard let doc = PDFDocument(url: URL(fileURLWithPath: a[1])) else {
    FileHandle.standardError.write("cannot open pdf".data(using: .utf8)!); exit(1)
}
let count = doc.pageCount
let start = max(0, min(count - 1, firstPage - 1))
let end = min(count, start + maxPages)
for i in start..<end {
    guard let page = doc.page(at: i) else { continue }
    let bounds = page.bounds(for: .mediaBox)
    let size = CGSize(width: max(1, bounds.width * scale), height: max(1, bounds.height * scale))
    let img = page.thumbnail(of: size, for: .mediaBox)
    guard let tiff = img.tiffRepresentation,
          let rep = NSBitmapImageRep(data: tiff),
          let png = rep.representation(using: .png, properties: [:]) else { continue }
    try? png.write(to: URL(fileURLWithPath: a[2]).appendingPathComponent(String(format: "page-%03d.png", i + 1)))
}
print("PAGES \\(count)")
`;

function expandHome(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return join(homedir(), p.slice(2));
	return p;
}

interface RenderResult {
	pages: number; // total page count in the PDF
	files: string[]; // rendered PNG paths
}

/** macOS: render via embedded Swift + PDFKit. */
function renderWithSwift(pdfPath: string, outDir: string, firstPage: number, maxPages: number): RenderResult {
	const r = spawnSync("swift", ["-", pdfPath, outDir, `${SCALE}`, `${maxPages}`, `${firstPage}`], {
		input: SWIFT_SOURCE,
		encoding: "utf8",
		timeout: 120_000,
	});
	if (r.error) throw new Error(`swift failed to run: ${r.error.message}`);
	if (r.status !== 0) {
		throw new Error(
			`PDF rendering failed (exit ${r.status}): ${(r.stderr || r.stdout || "").trim().slice(0, 400)}`,
		);
	}
	const m = /PAGES (\d+)/.exec(r.stdout ?? "");
	const files: string[] = [];
	for (let i = firstPage; i < firstPage + maxPages; i++) {
		const f = join(outDir, `page-${String(i).padStart(3, "0")}.png`);
		if (existsSync(f)) files.push(f);
	}
	return { pages: m ? Number(m[1]) : files.length, files };
}

/** Linux/Windows: render via poppler's pdftoppm; total pages via pdfinfo. */
function renderWithPdftoppm(pdfPath: string, outDir: string, firstPage: number, maxPages: number): RenderResult {
	const last = firstPage + maxPages - 1;
	const r = spawnSync(
		"pdftoppm",
		["-png", "-r", "144", "-f", String(firstPage), "-l", String(last), pdfPath, join(outDir, "page")],
		{ encoding: "utf8", timeout: 120_000 },
	);
	if (r.error && (r.error as { code?: string }).code === "ENOENT") {
		throw new Error("pdftoppm not found. Install poppler (Debian/WSL: sudo apt install poppler-utils; Arch: sudo pacman -S poppler).");
	}
	if (r.error) throw new Error(`pdftoppm failed to run: ${r.error.message}`);
	if (r.status !== 0) {
		throw new Error(`PDF rendering failed (exit ${r.status}): ${(r.stderr || "").trim().slice(0, 400)}`);
	}
	// pdftoppm pads page numbers to the width of `last`; normalize to page-%03d.png.
	const files: string[] = [];
	for (let i = firstPage; i <= last; i++) {
		const padded = String(i).padStart(3, "0");
		const target = join(outDir, `page-${padded}.png`);
		if (existsSync(target)) {
			files.push(target);
			continue;
		}
		const raw = join(outDir, `page-${String(i)}.png`);
		if (existsSync(raw)) {
			renameSync(raw, target);
			files.push(target);
		}
	}
	if (files.length === 0) throw new Error("pdftoppm produced no pages (range beyond document?)");
	const info = spawnSync("pdfinfo", [pdfPath], { encoding: "utf8", timeout: 30_000 });
	const pm = /Pages:\s+(\d+)/.exec(info.stdout ?? "");
	return { pages: pm ? Number(pm[1]) : files.length, files };
}

function renderPages(pdfPath: string, outDir: string, firstPage: number, maxPages: number): RenderResult {
	if (process.platform === "darwin") return renderWithSwift(pdfPath, outDir, firstPage, maxPages);
	return renderWithPdftoppm(pdfPath, outDir, firstPage, maxPages);
}

export default function readPdf(pi: ExtensionAPI) {
	pi.registerTool({
		name: "read_pdf",
		label: "Read PDF",
		promptSnippet: "read_pdf — render PDF pages as images for multimodal reading",
		promptGuidelines: [
			"Use read_pdf for ANY .pdf file the user asks to read, review, or analyze — the built-in read tool cannot read PDFs.",
		],
		description:
			"Read a PDF file by rendering its pages to images for a multimodal model. " +
			"Use this for ANY .pdf file the user asks to read, review, or analyze — the built-in read tool cannot handle PDFs. " +
			"Returns page images plus the total page count; use firstPage/maxPages to window through long documents.",
		parameters: Type.Object({
			path: Type.String({ description: "Path to the .pdf file (absolute, ~/..., or relative to cwd)" }),
			firstPage: Type.Optional(Type.Number({ description: "1-based first page to render (default 1)" })),
			maxPages: Type.Optional(
				Type.Number({
					description: `Max pages to render (default ${DEFAULT_MAX_PAGES}, hard cap ${HARD_MAX_PAGES})`,
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const raw = expandHome(params.path);
			const target = resolve(ctx.cwd, raw);
			if (!existsSync(target)) {
				return { content: [{ type: "text", text: `File not found: ${target}` }], isError: true, details: {} };
			}
			if (!target.toLowerCase().endsWith(".pdf")) {
				return { content: [{ type: "text", text: `Not a PDF file: ${target}` }], isError: true, details: {} };
			}
			const firstPage = Math.max(1, Math.floor(params.firstPage ?? 1));
			const maxPages = Math.min(HARD_MAX_PAGES, Math.max(1, Math.floor(params.maxPages ?? DEFAULT_MAX_PAGES)));

			// Temp dir keyed by file path + mtime so re-reads of the same untouched
			// file reuse the rendered pages within the session.
			let key = target;
			try {
				key = `${target}:${Math.floor(statSync(target).mtimeMs)}`;
			} catch {
				/* stat failed — fall back to path-only key */
			}
			const outDir = join(
				process.env.TMPDIR || "/tmp",
				`pi-read-pdf-${createHash("sha1").update(key).digest("hex").slice(0, 12)}`,
			);
			const reuse =
				existsSync(outDir) && existsSync(join(outDir, `page-${String(firstPage).padStart(3, "0")}.png`));
			if (!reuse) {
				rmSync(outDir, { recursive: true, force: true });
				mkdirSync(outDir, { recursive: true });
			}

			let result: RenderResult;
			try {
				result = renderPages(target, outDir, firstPage, maxPages);
			} catch (err) {
				return {
					content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
					isError: true,
					details: {},
				};
			}

			if (result.files.length === 0) {
				return {
					content: [{ type: "text", text: `No pages rendered (firstPage ${firstPage} beyond document?)` }],
					isError: true,
					details: {},
				};
			}

			const last = firstPage + result.files.length - 1;
			const note =
				`PDF: ${target}\nTotal pages: ${result.pages}. Showing pages ${firstPage}-${last} as images.` +
				(result.pages > last ? ` More pages remain — call again with firstPage=${last + 1}.` : "");
			const content: Array<TextContent | ImageContent> = [{ type: "text", text: note }];
			for (const f of result.files) {
				content.push({
					type: "image",
					data: readFileSync(f).toString("base64"),
					mimeType: "image/png",
				});
			}
			return { content, details: { pages: result.pages, rendered: result.files.length } };
		},
	});

	// The built-in read tool mangles PDFs (binary text). Redirect the model here.
	pi.on("tool_call", (event) => {
		if (event.toolName !== "read") return undefined;
		const p = (event.input as { path?: unknown } | undefined)?.path;
		if (typeof p === "string" && p.toLowerCase().endsWith(".pdf")) {
			return {
				block: true,
				reason:
					"PDF files cannot be read as text. Call read_pdf instead, e.g. " +
					`{"tool":"read_pdf","input":{"path":${JSON.stringify(p)}}} — ` +
					"it renders the pages as images your multimodal capabilities can read.",
			};
		}
		return undefined;
	});
}
