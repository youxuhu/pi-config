/**
 * git-status — git segment in the footer status area + `/git` passthrough.
 *
 * Display: `ctx.ui.setStatus("git", …)` appends to the built-in footer next to
 * other extensions' statuses. Format from `git status --porcelain=v1 -b`:
 *   clean   → ⎇ main                 (accent)
 *   dirty   → ⎇ main +1 ~2 !3 ↑1 ↓2 (warning; +staged ~modified !untracked)
 *   not a repo → segment cleared; timeout/error → dim ⎇ ?
 *
 * Command: `/git add .` runs git directly (argv split on whitespace; a leading
 * literal "git" token is tolerated and dropped). `/git` with no args runs
 * `status -sb`. Output is shown via notify (truncated when long); every run
 * refreshes the status segment.
 *
 * Refresh triggers: session_start, agent_settled, tool_execution_end (only
 * write/edit/bash), and /git — throttled to one git spawn per 500ms with a
 * trailing refresh.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const REFRESH_TOOLS = new Set(["write", "edit", "bash"]);
const THROTTLE_MS = 500;
const STATUS_TIMEOUT_MS = 5000;
const COMMAND_TIMEOUT_MS = 15000;
/** Max notify lines before truncation. */
const NOTIFY_MAX_LINES = 20;

interface GitInfo {
	isRepo: boolean;
	branch: string;
	staged: number;
	unstaged: number;
	untracked: number;
	ahead: number;
	behind: number;
}

function parsePorcelain(out: string): GitInfo {
	const info: GitInfo = { isRepo: true, branch: "", staged: 0, unstaged: 0, untracked: 0, ahead: 0, behind: 0 };
	for (const line of out.split("\n")) {
		if (line.startsWith("## ")) {
			// e.g. "## main...origin/main [ahead 1, behind 2]"
			const head = line.slice(3);
			const dot = head.indexOf("...");
			info.branch = dot === -1 ? head.replace(/ \[.*$/, "") : head.slice(0, dot);
			const m = /\[ahead (\d+)(?:, behind (\d+))?|behind (\d+)/.exec(head);
			if (m) {
				info.ahead = Number(m[1] ?? 0);
				info.behind = Number(m[2] ?? m[3] ?? 0);
			}
			continue;
		}
		if (line.length < 2) continue;
		const x = line[0]!; // staged column
		const y = line[1]!; // worktree column
		if (x === "?" && y === "?") info.untracked++;
		else {
			if (x !== " " && x !== "?") info.staged++;
			if (y !== " " && y !== "?") info.unstaged++;
		}
	}
	return info;
}

export default function gitStatus(pi: ExtensionAPI) {
	let currentCtx: ExtensionContext | undefined;
	let lastRunAt = 0;
	let trailingTimer: ReturnType<typeof setTimeout> | undefined;

	const parseArgs = (raw: string): string[] => {
		const argv = raw.trim().split(/\s+/).filter(Boolean);
		if (argv.length > 0 && argv[0] === "git") argv.shift(); // tolerate `/git git add .`
		return argv;
	};

	const renderSegment = (info: GitInfo): string => {
		const theme = currentCtx!.ui.theme;		if (!info.branch) return theme.fg("dim", "⎇ ?");
		const counts: string[] = [];
		if (info.staged > 0) counts.push(`+${info.staged}`);
		if (info.unstaged > 0) counts.push(`~${info.unstaged}`);
		if (info.untracked > 0) counts.push(`!${info.untracked}`);
		if (info.ahead > 0) counts.push(`↑${info.ahead}`);
		if (info.behind > 0) counts.push(`↓${info.behind}`);
		const label = `⎇ ${info.branch}${counts.length > 0 ? ` ${counts.join(" ")}` : ""}`;
		return counts.length > 0 ? theme.fg("warning", label) : theme.fg("accent", label);
	};

	/** Cached ctx can be invalidated by the runner (session end/reload); any ui
	 *  access then throws via assertActive. Treat that as “ctx dead” and drop it. */
	const safeSetStatus = (value: string | undefined): void => {
		const ctx = currentCtx;
		if (!ctx) return;
		try {
			ctx.ui.setStatus("git", value);
		} catch {
			currentCtx = undefined;
		}
	};

	const refresh = async (): Promise<void> => {
		const ctx = currentCtx;
		if (!ctx) return;
		lastRunAt = Date.now();
		let res: Awaited<ReturnType<typeof pi.exec>>;
		try {
			res = await pi.exec(
				"git",
				["--no-pager", "-C", ctx.cwd, "status", "--porcelain=v1", "-b"],
				{ timeout: STATUS_TIMEOUT_MS },
			);
		} catch {
			currentCtx = undefined;
			return;
		}
		try {
			if (!res || res.code !== 0) {
				// Chinese-locale git reports “不是 Git 仓库”; match both languages.
				const notRepo = !res || /not a git repo|不是 ?[Gg]it ?仓库/i.test(res.stderr ?? "");
				safeSetStatus(notRepo ? undefined : ctx.ui.theme.fg("dim", "⎇ ?"));
				return;
			}
			safeSetStatus(renderSegment(parsePorcelain(res.stdout ?? "")));
		} catch {
			// ctx invalidated between exec and ui access — drop silently
			currentCtx = undefined;
		}
	};

	const refreshThrottled = (): void => {
		if (trailingTimer) {
			clearTimeout(trailingTimer);
			trailingTimer = undefined;
		}
		const wait = lastRunAt + THROTTLE_MS - Date.now();
		if (wait <= 0) {
			void refresh();
			return;
		}
		trailingTimer = setTimeout(() => {
			trailingTimer = undefined;
			void refresh();
		}, wait);
	};

	const notifyOutput = (text: string, kind: "info" | "warning"): void => {
		const ctx = currentCtx;
		if (!ctx) return;
		const lines = text.replace(/\n+$/, "").split("\n").filter(Boolean);
		if (lines.length === 0) return;
		const body = lines.length > NOTIFY_MAX_LINES
			? `${lines.slice(0, NOTIFY_MAX_LINES).join("\n")}\n… (共 ${lines.length} 行，已截断)`
			: lines.join("\n");
		try {
			ctx.ui.notify(body, kind);
		} catch {
			currentCtx = undefined;
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
		refreshThrottled();
	});

	pi.on("session_shutdown", async () => {
		if (trailingTimer) {
			clearTimeout(trailingTimer);
			trailingTimer = undefined;
		}
		try {
			currentCtx?.ui.setStatus("git", undefined);
		} catch {
			// ctx already invalidated (e.g. pi -p teardown) — nothing to clear
		}
		currentCtx = undefined;
	});

	pi.on("agent_settled", async () => {
		refreshThrottled();
	});

	pi.on("tool_execution_end", async (event) => {
		if (REFRESH_TOOLS.has(event.toolName)) refreshThrottled();
	});

	pi.registerCommand("git", {
		description: "Run a git command in the project root: /git add . (no args → git status -sb)",
		handler: async (args, ctx) => {
			currentCtx = ctx;
			const argv = parseArgs(args);
			if (argv.length === 0) argv.push("status", "-sb");

			const res = await pi.exec("git", argv, { timeout: COMMAND_TIMEOUT_MS });
			if (!res || res.killed) {
				ctx.ui.notify("git command timed out.", "warning");
			} else if (res.code !== 0) {
				notifyOutput(res.stderr?.trim() || `git exited with code ${res.code}`, "warning");
			} else {
				notifyOutput(res.stdout?.trim() || "(no output)", "info");
			}
			refreshThrottled();
		},
	});
}
