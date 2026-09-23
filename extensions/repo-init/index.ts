/**
 * repo-init — `/init` command for Pi.
 *
 * Analyzes the repository at the current working directory and generates a
 * project-root AGENTS.md (opencode/Claude-Code style guidance file that Pi
 * auto-loads at startup).
 *
 * Flow (mirrors opencode's `/init` and Claude Code's `/init`):
 *   1. Pre-scan the repo (file tree + README/manifest/CI/existing rules) and
 *      build a compact project snapshot.
 *   2. Ask for confirmation before overwriting an existing AGENTS.md.
 *   3. Hand the snapshot to the agent via sendUserMessage and let it write
 *      AGENTS.md with its own exploration + judgment.
 *
 * The generated file follows the same "every line must earn its place"
 * principle used by opencode: would an agent likely miss this without help?
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const TARGET = "AGENTS.md";
const MAX_DEPTH = 4;
const MAX_TOP_ENTRIES = 80;
const MAX_SCAN_FILES = 400;
const SKIP_DIRS = new Set([
	"node_modules", ".git", ".svn", ".hg", "dist", "build", "out", "target",
	".venv", "venv", "__pycache__", ".next", ".nuxt", "coverage", ".cache",
	".idea", ".vscode", ".pytest_cache", ".mypy_cache", ".ruff_cache", "Pods",
]);
const README_HEAD_LINES = 30;
const MANIFEST_HEAD_LINES = 40;

interface ScanResult {
	tree: string[];
	readmes: string[];
	manifests: string[];
	existingRules: string[];
	warnings: string[];
}

function isManifestName(name: string): boolean {
	return /^(package\.json|pyproject\.toml|requirements\.txt|cargo\.toml|go\.mod|go\.sum|pom\.xml|build\.gradle|makefile|cmakelists\.txt|composer\.json|gemfile|mix\.exs|pubspec\.yaml|justfile|dockerfile|docker-compose\.ya?ml|tsconfig\.json|flake\.nix|vite\.config\.ts|webpack\.config\.js)$/i.test(
		name,
	);
}

function scanRepo(cwd: string): ScanResult {
	const out: ScanResult = { tree: [], readmes: [], manifests: [], existingRules: [], warnings: [] };
	let count = 0;

	const walk = (dir: string, depth: number, prefix: string) => {
		if (depth > MAX_DEPTH || count >= MAX_SCAN_FILES) return;
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			out.warnings.push(`unreadable dir: ${dir}`);
			return;
		}
		const dirs: string[] = [];
		const files: string[] = [];
		for (const e of entries) {
			if (SKIP_DIRS.has(e)) continue;
			try {
				const st = statSync(join(dir, e));
				if (st.isDirectory()) dirs.push(e);
				else if (st.isFile()) files.push(e);
			} catch {
				/* skip unreadable */
			}
		}
		dirs.sort();
		files.sort();

		if (depth === 0) {
			dirs.length = Math.min(dirs.length, MAX_TOP_ENTRIES);
			files.length = Math.min(files.length, MAX_TOP_ENTRIES);
		}

		for (const d of dirs) {
			if (depth > 0) out.tree.push(`${prefix}${d}/`);
			count++;
			if (count >= MAX_SCAN_FILES) return;
			walk(join(dir, d), depth + 1, `${prefix}  `);
		}
		for (const f of files) {
			out.tree.push(`${prefix}${f}`);
			count++;
			if (count >= MAX_SCAN_FILES) return;
			const full = join(dir, f);
			const name = f.toLowerCase();
			try {
				if (/^readme(\.|$)/.test(name)) {
					if (out.readmes.length < 2) {
						const head = readFileSync(full, "utf-8").split("\n").slice(0, README_HEAD_LINES).join("\n");
						out.readmes.push(`--- README (${depth === 0 ? f : `${prefix}${f}`}) ---\n${head}`);
					}
				} else if (isManifestName(name)) {
					if (out.manifests.length < 12) {
						const head = readFileSync(full, "utf-8").split("\n").slice(0, MANIFEST_HEAD_LINES).join("\n");
						out.manifests.push(`--- ${depth === 0 ? f : `${prefix}${f}`} ---\n${head}`);
					}
				}
			} catch {
				/* binary or unreadable */
			}
		}
	};

	for (const f of ["AGENTS.md", "AGENTS.override.md", "CLAUDE.md", ".cursor/rules.mdc", ".claude/settings.json"]) {
		if (existsSync(join(cwd, f))) out.existingRules.push(f);
	}

	walk(cwd, 0, "");
	if (out.tree.length === 0) out.warnings.push("no readable files (empty repo or scan limits?)");
	return out;
}

function buildPrompt(cwd: string, scan: ScanResult): string {
	const parts: string[] = [];
	parts.push(
		`Analyze this codebase and create a concise AGENTS.md at the project root (${join(cwd, TARGET)}).`,
		"",
		"Rules for the file:",
		"- Every line must earn its place: would an agent likely miss this without help? If not, leave it out.",
		"- Prefer facts over filler: real commands, real paths, real conventions. No generic boilerplate, no motivational text.",
		"- Aim for ~60-150 lines. Compact is a feature.",
		"- Include, when they exist and are project-specific:",
		"  1. Build / lint / test / typecheck commands, especially how to run a single test.",
		"  2. Code style and conventions: imports, formatting, typing, naming, error handling, commit conventions.",
		"  3. Architecture in a few bullets: main components, entry points, data flow, key directories.",
		"  4. Anything an agent would repeatedly get wrong here (gotchas, generated code, symlinks, test fixtures, env requirements).",
		"  5. If this is a research/academic repo (LaTeX papers, scripts, experiments), describe how to compile/run and where outputs live.",
		"- Do NOT copy README verbatim; extract only what steers future agents.",
		"- If an existing AGENTS.md/CLAUDE.md already has good content, keep and improve it rather than discarding.",
		"",
		"Project snapshot (auto-scanned, may be incomplete — verify by reading files yourself):",
		"",
		"### File tree",
		scan.tree.length ? scan.tree.join("\n") : "(empty)",
	);
	if (scan.readmes.length) {
		parts.push("", "### README excerpts", ...scan.readmes);
	}
	if (scan.manifests.length) {
		parts.push("", "### Key manifests", ...scan.manifests);
	}
	if (scan.existingRules.length) {
		parts.push("", "### Existing rule files (read and reconcile)", scan.existingRules.join("\n"));
	}
	if (scan.warnings.length) {
		parts.push("", "### Scan notes", scan.warnings.join("\n"));
	}
	parts.push(
		"",
		"When done, write the final AGENTS.md with the write tool and briefly summarize what you put in it.",
	);
	return parts.join("\n");
}

export default function repoInit(pi: ExtensionAPI) {
	const handleInit = async (ctx: ExtensionCommandContext) => {
		const cwd = ctx.cwd;
		const target = join(cwd, TARGET);

		if (existsSync(target)) {
			if (!ctx.hasUI) {
				ctx.ui.notify(`${TARGET} already exists. Remove it first, or edit it manually.`, "warning");
				return;
			}
			const ok = await ctx.ui.confirm(
				"Regenerate AGENTS.md?",
				`${target} already exists. Generate a fresh draft and let the agent reconcile it with the existing content?`,
			);
			if (!ok) {
				ctx.ui.notify("Cancelled. Existing AGENTS.md untouched.", "info");
				return;
			}
		}

		ctx.ui.notify(`Scanning ${cwd} ...`, "info");
		let scan: ScanResult;
		try {
			scan = scanRepo(cwd);
		} catch (e) {
			ctx.ui.notify(`Scan failed: ${(e as Error).message}`, "error");
			return;
		}

		// Empty repo (no readable files; e.g. a fresh `git init` that only holds
		// .git / node_modules etc.) — nothing to analyze, so just drop a blank
		// AGENTS.md instead of running the full scan-and-draft handoff.
		if (scan.tree.length === 0) {
			try {
				writeFileSync(target, "");
			} catch (e) {
				ctx.ui.notify(`Failed to create ${TARGET}: ${(e as Error).message}`, "error");
				return;
			}
			ctx.ui.notify(`Empty folder — created a blank ${TARGET}.`, "info");
			return;
		}

		const prompt = buildPrompt(cwd, scan);
		ctx.ui.notify(`Handing the project snapshot to the agent to draft ${TARGET} ...`, "info");
		await ctx.sendUserMessage(prompt);
	};

	pi.registerCommand("init", {
		description: "Analyze the repo and generate AGENTS.md",
		handler: handleInit,
	});
	pi.registerCommand("repoinit", {
		description: "Analyze the repo and generate AGENTS.md (alias)",
		handler: handleInit,
	});
}
