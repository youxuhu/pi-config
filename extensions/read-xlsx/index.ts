/**
 * read-xlsx — let the model read Excel files (.xlsx/.xlsm/.xls).
 *
 * Registers a `read_xlsx` tool that converts sheets to markdown tables via the
 * SheetJS `xlsx` package (pure JS — no system dependencies) and also redirects
 * built-in `read` calls targeting Excel files to this tool.
 *
 * Dependency (per machine): npm i --prefix ~/.pi/agent xlsx
 * (~/.pi/agent/node_modules is on the resolution path for extensions and is
 * gitignored, so each machine installs it once.)
 *
 * Params: path (required), sheet (name; default first sheet), maxRows (default 50).
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const DEFAULT_MAX_ROWS = 50;
const HARD_MAX_ROWS = 500;
const MAX_COLS = 30;

const EXCEL_EXTS = new Set([".xlsx", ".xlsm", ".xls"]);

function expandHome(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return join(homedir(), p.slice(2));
	return p;
}

function markdownTable(rows: string[][], maxRows: number): { table: string; totalRows: number; totalCols: number } {
	const totalRows = rows.length;
	const totalCols = rows.reduce((m, r) => Math.max(m, r.length), 0);
	const cols = Math.min(totalCols, MAX_COLS);
	const body = rows.slice(0, maxRows).map((r) => {
		const cells: string[] = [];
		for (let c = 0; c < cols; c++) {
			const v = r[c] === undefined || r[c] === null ? "" : String(r[c]);
			cells.push(v.replace(/\r?\n/g, "⏎").replace(/\|/g, "\\|").slice(0, 80));
		}
		return `| ${cells.join(" | ")} |`;
	});
	if (body.length > 0) body.splice(1, 0, `| ${Array(cols).fill("---").join(" | ")} |`);
	return { table: body.join("\n"), totalRows, totalCols };
}

export default function readXlsx(pi: ExtensionAPI) {
	pi.registerTool({
		name: "read_xlsx",
		label: "Read Excel",
		promptSnippet: "read_xlsx — convert Excel sheets (.xlsx/.xls) to markdown tables",
		promptGuidelines: [
			"Use read_xlsx for ANY .xlsx/.xlsm/.xls file the user asks to read, review, or analyze — the built-in read tool cannot read Excel files.",
		],
		description:
			"Read an Excel file by converting a sheet to a markdown table. " +
			"Use for ANY .xlsx/.xlsm/.xls the user asks to read — the built-in read tool cannot handle Excel. " +
			"Returns the sheet list, the table (row-capped) and total row/col counts.",
		parameters: Type.Object({
			path: Type.String({ description: "Path to the Excel file (absolute, ~/..., or relative to cwd)" }),
			sheet: Type.Optional(Type.String({ description: "Sheet name; default is the first sheet" })),
			maxRows: Type.Optional(
				Type.Number({ description: `Max data rows to return (default ${DEFAULT_MAX_ROWS}, hard cap ${HARD_MAX_ROWS})` }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const target = resolve(ctx.cwd, expandHome(params.path));
			if (!existsSync(target)) {
				return { content: [{ type: "text", text: `File not found: ${target}` }], isError: true, details: {} };
			}
			if (!EXCEL_EXTS.has(target.slice(target.lastIndexOf(".")).toLowerCase())) {
				return { content: [{ type: "text", text: `Not an Excel file: ${target}` }], isError: true, details: {} };
			}

			let XLSX: typeof import("xlsx");
			try {
				// eslint-disable-next-line @typescript-eslint/no-require-imports
				XLSX = require("xlsx");
			} catch {
				return {
					content: [
						{
							type: "text",
							text: 'The "xlsx" package is not installed. Run once per machine:\n  npm i --prefix ~/.pi/agent xlsx',
						},
					],
					isError: true,
					details: {},
				};
			}

			try {
				const wb = XLSX.read(readFileSync(target), { type: "buffer", cellDates: true });
				const names = wb.SheetNames;
				const chosen = params.sheet ? names.find((n) => n.toLowerCase() === params.sheet!.toLowerCase()) : names[0];
				if (!chosen) {
					return {
						content: [{ type: "text", text: `Sheet "${params.sheet}" not found. Available: ${names.join(", ")}` }],
						isError: true,
						details: {},
					};
				}
				const maxRows = Math.min(HARD_MAX_ROWS, Math.max(1, Math.floor(params.maxRows ?? DEFAULT_MAX_ROWS)));
				const rows = (XLSX.utils.sheet_to_json(wb.Sheets[chosen!], { header: 1, defval: "", blankrows: false }) as unknown[][])
					.map((r) => r.map((c) => (c instanceof Date ? c.toISOString().slice(0, 10) : c)))
					.map((r) => r.map((c) => (c === null || c === undefined ? "" : String(c))));
				if (rows.length === 0) {
					return {
						content: [{ type: "text", text: `Sheet "${chosen}" is empty. Sheets: ${names.join(", ")}` }],
						isError: false,
						details: {},
					};
				}
				const { table, totalRows, totalCols } = markdownTable(rows, maxRows);
				const note =
					`Excel: ${target}\nSheets: ${names.join(", ")} · showing "${chosen}"\n` +
					(totalRows > maxRows
						? `${maxRows} of ${totalRows} rows shown (row 1 treated as header), ${totalCols} column(s). Re-call with sheet/next range as needed.`
						: `${totalRows} rows, ${totalCols} column(s).`);
				return {
					content: [{ type: "text", text: `${note}\n\n${table}` }],
					details: { sheets: names, rows: totalRows, cols: totalCols },
				};
			} catch (err) {
				return {
					content: [{ type: "text", text: `Failed to parse Excel: ${err instanceof Error ? err.message : String(err)}` }],
					isError: true,
					details: {},
				};
			}
		},
	});

	// The built-in read tool mangles Excel (binary zip). Redirect the model here.
	pi.on("tool_call", (event) => {
		if (event.toolName !== "read") return undefined;
		const p = (event.input as { path?: unknown } | undefined)?.path;
		if (typeof p === "string" && EXCEL_EXTS.has(p.slice(p.lastIndexOf(".")).toLowerCase())) {
			return {
				block: true,
				reason:
					"Excel files cannot be read as text. Call read_xlsx instead, e.g. " +
					`{"tool":"read_xlsx","input":{"path":${JSON.stringify(p)}}} — it converts the sheet to a markdown table.`,
			};
		}
		return undefined;
	});
}
