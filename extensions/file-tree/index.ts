/**
 * file-tree — on-demand left-side file tree with external vim open.
 *
 * `/file` opens a temporary left-anchored overlay listing the project tree.
 * It is NOT a persistent sidebar: it appears only while open and disappears on
 * `q` / `Esc`, or after you pick a file.
 *
 * Navigation:
 *   j / ↓      move down
 *   k / ↑      move up
 *   l / →      expand a directory
 *   h / ←      collapse a directory (or jump to its parent when collapsed)
 *   Enter      directory -> toggle expand; file -> close and open in vim
 *   .          toggle hidden (dot) files
 *   q / Esc    close the tree
 *
 * Opening a file runs the external editor (vim, falling back to vi) using the
 * same tui.stop() -> spawn -> tui.start() pattern as plan-switch's /plan-edit,
 * so the TUI is restored and control returns to pi once vim exits.
 *
 * The command is `/file` (not `/tree`) because pi already ships a built-in
 * `/tree` command for session-tree navigation.
 */

import { readdirSync, type Dirent } from "node:fs";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const SKIP_DIRS = new Set(["node_modules", ".git"]);
const MAX_PER_DIR = 1000;
const PANEL_WIDTH = 38;

type Action = { type: "open-file"; path: string } | { type: "close" };

interface Node {
	path: string;
	name: string;
	isDir: boolean;
	depth: number;
}

/** Build the flattened list of visible nodes, expanding directories in `expanded`. */
function listNodes(
	cwd: string,
	relDir: string,
	depth: number,
	expanded: Set<string>,
	showHidden: boolean,
): Node[] {
	const absDir = relDir ? join(cwd, relDir) : cwd;
	let entries: Dirent[];
	try {
		entries = readdirSync(absDir, { withFileTypes: true });
	} catch {
		return [];
	}

	const visible = (name: string) => showHidden || !name.startsWith(".");
	const dirs = entries
		.filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name) && visible(e.name))
		.sort((a, b) => a.name.localeCompare(b.name));
	const files = entries
		.filter((e) => e.isFile() && visible(e.name))
		.sort((a, b) => a.name.localeCompare(b.name));

	const nodes: Node[] = [];
	for (const d of dirs.slice(0, MAX_PER_DIR)) {
		const rel = relDir ? `${relDir}/${d.name}` : d.name;
		nodes.push({ path: rel, name: d.name, isDir: true, depth });
		if (expanded.has(rel)) {
			nodes.push(...listNodes(cwd, rel, depth + 1, expanded, showHidden));
		}
	}
	for (const f of files.slice(0, MAX_PER_DIR)) {
		const rel = relDir ? `${relDir}/${f.name}` : f.name;
		nodes.push({ path: rel, name: f.name, isDir: false, depth });
	}
	return nodes;
}

/** Pick vim, falling back to vi. */
function pickEditor(): string {
	try {
		const r = spawnSync("which", ["vim"], { encoding: "utf8" });
		if (r.status === 0 && r.stdout.trim()) return "vim";
	} catch {
		/* ignore */
	}
	return "vi";
}

/**
 * Open `rel` in the external editor. Suspends the TUI so the editor owns the
 * terminal, then restores it when the editor exits (control returns to pi).
 */
async function openInVim(ctx: ExtensionCommandContext, cwd: string, rel: string): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("Opening an external editor requires the interactive TUI.", "warning");
		return;
	}
	const target = resolve(cwd, rel);
	const editor = pickEditor();
	await ctx.ui.custom<null>((tui, _theme, _keybindings, done) => {
		tui.stop();
		process.stdout.write("\x1b[2J\x1b[H");
		spawnSync(editor, [target], { stdio: "inherit", env: process.env });
		tui.start();
		tui.requestRender(true);
		done(null);
		return { render: () => [], invalidate: () => {} };
	});
}

interface FileTreeOptions {
	cwd: string;
	theme: Theme;
	onRender: () => void;
	done: (action: Action) => void;
}

class FileTree {
	private readonly cwd: string;
	private readonly theme: Theme;
	private readonly onRender: () => void;
	private readonly done: (action: Action) => void;
	private readonly maxVisible: number;

	private nodes: Node[] = [];
	private sel = 0;
	private expanded = new Set<string>();
	private showHidden = false;

	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(opts: FileTreeOptions) {
		this.cwd = opts.cwd;
		this.theme = opts.theme;
		this.onRender = opts.onRender;
		this.done = opts.done;
		const rows = process.stdout.rows ?? 24;
		this.maxVisible = Math.max(6, Math.floor(rows * 0.8) - 3);
		this.rebuild();
	}

	private rebuild(): void {
		this.nodes = listNodes(this.cwd, "", 0, this.expanded, this.showHidden);
		if (this.sel >= this.nodes.length) this.sel = Math.max(0, this.nodes.length - 1);
		this.invalidate();
	}

	private move(delta: number): void {
		const next = this.sel + delta;
		if (next < 0 || next >= this.nodes.length) return;
		this.sel = next;
		this.invalidate();
	}

	private expand(): void {
		const n = this.nodes[this.sel];
		if (!n || !n.isDir) return;
		if (!this.expanded.has(n.path)) this.expanded.add(n.path);
		this.rebuild();
	}

	private collapse(): void {
		const n = this.nodes[this.sel];
		if (!n) return;
		if (n.isDir && this.expanded.has(n.path)) {
			this.expanded.delete(n.path);
			this.rebuild();
			return;
		}
		const slash = n.path.lastIndexOf("/");
		if (slash < 0) return;
		const parent = n.path.slice(0, slash);
		const idx = this.nodes.findIndex((x) => x.path === parent);
		if (idx >= 0) {
			this.sel = idx;
			this.invalidate();
		}
	}

	private activate(): void {
		const n = this.nodes[this.sel];
		if (!n) return;
		if (n.isDir) {
			if (this.expanded.has(n.path)) this.expanded.delete(n.path);
			else this.expanded.add(n.path);
			this.rebuild();
			return;
		}
		this.done({ type: "open-file", path: n.path });
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.down) || data === "j") this.move(1);
		else if (matchesKey(data, Key.up) || data === "k") this.move(-1);
		else if (matchesKey(data, Key.right) || data === "l") this.expand();
		else if (matchesKey(data, Key.left) || data === "h") this.collapse();
		else if (matchesKey(data, Key.enter)) this.activate();
		else if (matchesKey(data, Key.escape) || data === "q") {
			this.done({ type: "close" });
			return;
		} else if (data === ".") {
			this.showHidden = !this.showHidden;
			this.rebuild();
		} else {
			return;
		}
		this.onRender();
	}

	render(width: number): string[] {
		const w = Math.max(12, width);
		if (this.cachedLines && this.cachedWidth === w) return this.cachedLines;

		const theme = this.theme;
		const out: string[] = [];
		out.push(truncateToWidth(theme.fg("accent", theme.bold(`FILES  ${basename(this.cwd)}`)), w));

		const total = this.nodes.length;
		let start = 0;
		if (total > this.maxVisible) {
			start = Math.max(0, Math.min(this.sel - Math.floor(this.maxVisible / 2), total - this.maxVisible));
		}
		const end = Math.min(total, start + this.maxVisible);

		for (let i = start; i < end; i++) {
			const n = this.nodes[i]!;
			const indent = "  ".repeat(n.depth);
			const marker = n.isDir ? (this.expanded.has(n.path) ? "▾ " : "▸ ") : "  ";
			let text = `${indent}${marker}${n.name}${n.isDir ? "/" : ""}`;
			text = truncateToWidth(text, Math.max(1, w - 1));
			let line = ` ${text}`;
			const pad = w - visibleWidth(line);
			if (pad > 0) line += " ".repeat(pad);
			if (i === this.sel) line = theme.bg("selectedBg", theme.fg("accent", line));
			out.push(line);
		}
		if (total === 0) out.push(theme.fg("dim", truncateToWidth("  (empty)", w)));
		out.push(truncateToWidth(theme.fg("dim", " j/k  ⏎vim  h/l fold  . hidden  q close"), w));

		this.cachedLines = out;
		this.cachedWidth = w;
		return out;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

export default function fileTree(pi: ExtensionAPI) {
	pi.registerCommand("file", {
		description: "Open a left-side file tree (Enter opens the file in vim)",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("The file tree requires the interactive TUI.", "warning");
				return;
			}
			const action = await ctx.ui.custom<Action>(
				(tui, theme, _keybindings, done) =>
					new FileTree({ cwd: ctx.cwd, theme, onRender: () => tui.requestRender(), done }),
				{
					overlay: true,
					overlayOptions: {
						anchor: "left-center",
						width: PANEL_WIDTH,
						maxHeight: "90%",
						visible: (termWidth: number) => termWidth >= 60,
					},
				},
			);
			// Directory navigation happens inside the component; only a file
			// activation needs the external editor. Closing returns to pi and
			// leaves the tree closed.
			if (action?.type === "open-file") {
				await openInVim(ctx, ctx.cwd, action.path);
			}
		},
	});
}
