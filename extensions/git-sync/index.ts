/**
 * git-sync — background git sync for the ~/.pi/agent config repo.
 *
 * Startup (session_start, also fires on /reload): kicks off an ASYNC `git
 * fetch` (never blocks startup). When it finishes and the remote is ahead,
 * the user is asked once whether to sync now; if they accept and the worktree
 * is clean, a fast-forward pull is applied (new/changed extensions take
 * effect on the next /reload or launch). Nothing is ever auto-pulled.
 *
 * Shutdown (session_shutdown): pushes ONLY already-existing commits (never
 * creates one); silent and best-effort.
 *
 * /git-sync: manual cycle — fetch, commit dirty worktree (explicit user
 * action), push, then ff-only pull if behind.
 */

import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const AGENT_DIR = join(homedir(), ".pi", "agent");
const BRANCH = "main";
const FETCH_TIMEOUT_MS = 8_000;
const GIT_TIMEOUT_MS = 6_000;
const PUSH_TIMEOUT_MS = 12_000;

interface GitResult {
	ok: boolean;
	stdout: string;
	stderr: string;
}

function git(args: string[], timeoutMs: number): GitResult {
	const r = spawnSync("git", args, { cwd: AGENT_DIR, encoding: "utf8", timeout: timeoutMs });
	if (r.error) return { ok: false, stdout: r.stdout ?? "", stderr: String((r.error as Error).message) };
	return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function hasRepoAndRemote(): boolean {
	if (git(["rev-parse", "--is-inside-work-tree"], 3_000).stdout.trim() !== "true") return false;
	return git(["remote", "get-url", "origin"], 3_000).ok;
}

function isDirty(): boolean {
	return git(["status", "--porcelain"], GIT_TIMEOUT_MS).stdout.trim().length > 0;
}

function aheadBehind(): { ahead: number; behind: number } | undefined {
	const r = git(["rev-list", "--left-right", "--count", `HEAD...origin/${BRANCH}`], GIT_TIMEOUT_MS);
	const m = /^(\d+)\s+(\d+)/m.exec(r.stdout);
	if (!r.ok || !m) return undefined;
	return { ahead: Number(m[1]), behind: Number(m[2]) };
}

/** Async fetch — runs in the background so startup is never blocked. */
function fetchAsync(): Promise<boolean> {
	return new Promise((resolveDone) => {
		const child = spawn("git", ["fetch", "origin"], { cwd: AGENT_DIR, stdio: "ignore" });
		const timer = setTimeout(() => {
			child.kill();
			resolveDone(false);
		}, FETCH_TIMEOUT_MS);
		child.on("exit", (code) => {
			clearTimeout(timer);
			resolveDone(code === 0);
		});
		child.on("error", () => {
			clearTimeout(timer);
			resolveDone(false);
		});
	});
}

function pushExisting(ctx: ExtensionContext | undefined, verbose: boolean): void {
	const ab = aheadBehind();
	if (!ab || ab.ahead === 0) {
		if (verbose) ctx?.ui.notify("git-sync: no local commits to push.", "info");
		return;
	}
	const p = git(["push"], PUSH_TIMEOUT_MS);
	if (verbose) {
		if (p.ok) ctx?.ui.notify(`git-sync: pushed ${ab.ahead} commit(s).`, "info");
		else ctx?.ui.notify(`git-sync: push failed (retry next session) — ${p.stderr.trim().slice(0, 200)}`, "warning");
	}
}

async function promptAndSync(ctx: ExtensionContext, behind: number): Promise<void> {
	if (!ctx.hasUI) return; // non-interactive: leave sync to /git-sync
	try {
		const yes = await ctx.ui.confirm(
			"Sync pi config?",
			`origin/${BRANCH} has ${behind} new commit(s) (updated extensions/config). Pull now? (ff-only, clean worktree required)`,
		);
		if (!yes) {
			ctx.ui.notify("git-sync: skipped — run /git-sync anytime to sync.", "info");
			return;
		}
	} catch {
		return; // dialog unavailable
	}
	if (isDirty()) {
		ctx.ui.notify("git-sync: local files modified — commit first (/git-sync), then pull.", "warning");
		return;
	}
	const pull = git(["pull", "--ff-only", "origin", BRANCH], PUSH_TIMEOUT_MS);
	if (pull.ok) {
		ctx.ui.notify(
			`git-sync: pulled ${behind} commit(s). Run /reload (or restart) to apply updated extensions.`,
			"info",
		);
	} else {
		ctx.ui.notify(`git-sync: pull failed — ${pull.stderr.trim().slice(0, 200)}`, "warning");
	}
}

export default function gitSync(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		try {
			if (!hasRepoAndRemote()) return;
			// Fire-and-forget: fetch runs in the background; the handler returns
			// immediately so startup is never blocked. The user prompt happens
			// asynchronously once the fetch lands.
			void (async () => {
				const ok = await fetchAsync();
				if (!ok) return; // offline / proxy down: silently skip
				const ab = aheadBehind();
				if (!ab) return;
				if (ab.ahead > 0) git(["push"], PUSH_TIMEOUT_MS); // silent best-effort
				if (ab.behind > 0) await promptAndSync(ctx, ab.behind);
			})();
		} catch {
			/* never block startup */
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		try {
			if (!hasRepoAndRemote()) return;
			pushExisting(ctx, false); // push-only, never commits
		} catch {
			/* never block shutdown */
		}
	});

	pi.registerCommand("git-sync", {
		description: "Sync ~/.pi/agent: commit local changes (if any), push, then pull (ff-only)",
		handler: async (_args, ctx) => {
			if (!hasRepoAndRemote()) {
				ctx.ui.notify("git-sync: ~/.pi/agent is not a git repo with an 'origin' remote.", "warning");
				return;
			}
			const fetched = await fetchAsync();
			if (!fetched) ctx.ui.notify("git-sync: fetch failed (offline?) — working with local state.", "warning");
			if (isDirty()) {
				git(["add", "-A"], GIT_TIMEOUT_MS);
				const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
				const c = git(["commit", "-m", `auto-sync: extensions/config @ ${stamp}`], GIT_TIMEOUT_MS);
				if (!c.ok) {
					ctx.ui.notify(`git-sync: commit failed — ${c.stderr.trim().slice(0, 200)}`, "warning");
					return;
				}
				ctx.ui.notify("git-sync: local changes committed.", "info");
			}
			pushExisting(ctx, true);
			const ab = aheadBehind();
			if (ab && ab.behind > 0) {
				if (isDirty()) {
					ctx.ui.notify("git-sync: remote is ahead but worktree is dirty — commit first, then pull.", "warning");
					return;
				}
				const pull = git(["pull", "--ff-only", "origin", BRANCH], PUSH_TIMEOUT_MS);
				if (pull.ok) ctx.ui.notify(`git-sync: pulled ${ab.behind} commit(s). /reload to apply.`, "info");
				else ctx.ui.notify(`git-sync: pull failed — ${pull.stderr.trim().slice(0, 200)}`, "warning");
			} else if (ab && ab.ahead === 0 && ab.behind === 0) {
				ctx.ui.notify("git-sync: already up to date with origin/main.", "info");
			}
		},
	});
}
