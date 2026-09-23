/**
 * git-sync — auto-sync for the ~/.pi/agent config repo.
 *
 * - session_start (also fires on /reload): fetch; push local commits if ahead;
 *   fast-forward pull if behind and the worktree is clean. Never merges.
 * - session_shutdown: NO auto-commit. Only push commits that already exist
 *   (ahead > 0); if there is no commit to push, do nothing. Uncommitted changes
 *   are left untouched for the user (commit via /git-sync or manually).
 * - /git-sync: fetch → commit local changes (if any) and push → ff-only pull.
 *
 * Everything is best-effort with short timeouts so startup/exit never hang.
 */

import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const AGENT_DIR = join(homedir(), ".pi", "agent");
const FAST_TIMEOUT_MS = 6_000; // fetch/status during startup
const PUSH_TIMEOUT_MS = 12_000; // push at startup, shutdown and via /git-sync
const BRANCH = "main";

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
	return git(["status", "--porcelain"], FAST_TIMEOUT_MS).stdout.trim().length > 0;
}

function aheadBehind(): { ahead: number; behind: number } | undefined {
	const r = git(["rev-list", "--left-right", "--count", `HEAD...origin/${BRANCH}`], FAST_TIMEOUT_MS);
	const m = /^(\d+)\s+(\d+)/m.exec(r.stdout);
	if (!r.ok || !m) return undefined;
	return { ahead: Number(m[1]), behind: Number(m[2]) };
}

/** Push only commits that already exist. Never creates a commit. Returns true if pushed. */
function pushExisting(ctx: ExtensionContext | undefined, verbose: boolean): boolean {
	const ab = aheadBehind();
	if (!ab || ab.ahead === 0) {
		if (verbose) ctx?.ui.notify("git-sync: no local commits to push.", "info");
		return false;
	}
	const p = git(["push"], PUSH_TIMEOUT_MS);
	if (verbose) {
		if (p.ok) ctx?.ui.notify(`git-sync: pushed ${ab.ahead} commit(s).`, "info");
		else ctx?.ui.notify(`git-sync: push failed (will retry next session) — ${p.stderr.trim().slice(0, 200)}`, "warning");
	}
	return p.ok;
}

/** Commit dirty worktree (used only by the manual /git-sync command). */
function commitDirty(ctx: ExtensionContext): boolean {
	if (!isDirty()) {
		ctx.ui.notify("git-sync: worktree clean, nothing to commit.", "info");
		return false;
	}
	git(["add", "-A"], FAST_TIMEOUT_MS);
	const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
	const c = git(["commit", "-m", `auto-sync: extensions/config @ ${stamp}`], FAST_TIMEOUT_MS);
	if (!c.ok) {
		ctx.ui.notify(`git-sync: commit failed — ${c.stderr.trim().slice(0, 200)}`, "warning");
		return false;
	}
	return true;
}

function syncOnStart(ctx: ExtensionContext): void {
	if (!hasRepoAndRemote()) return;
	// Fetch may fail offline — that just means nothing to sync.
	if (!git(["fetch", "origin"], FAST_TIMEOUT_MS).ok) return;
	const ab = aheadBehind();
	if (!ab) return;

	if (ab.ahead > 0) pushExisting(ctx, true); // push pre-existing local commits
	const after = aheadBehind() ?? ab;
	if (after.behind > 0) {
		if (isDirty()) {
			ctx.ui.notify(
				"git-sync: remote has new commits but local files are modified — pull skipped, commit or /git-sync first.",
				"warning",
			);
			return;
		}
		const pull = git(["pull", "--ff-only", "origin", BRANCH], PUSH_TIMEOUT_MS);
		if (pull.ok) {
			ctx.ui.notify(
				`git-sync: pulled ${after.behind} commit(s) from origin/${BRANCH}. New/changed extensions take effect on next /reload or launch.`,
				"info",
			);
		} else {
			ctx.ui.notify(`git-sync: pull failed — ${pull.stderr.trim().slice(0, 200)}`, "warning");
		}
	}
}

export default function gitSync(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		try {
			syncOnStart(ctx);
		} catch {
			/* never block startup */
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		try {
			if (!hasRepoAndRemote()) return;
			// Push ONLY already-existing commits; no commit created, nothing else.
			pushExisting(ctx, false);
		} catch {
			/* never block shutdown */
		}
	});

	pi.registerCommand("git-sync", {
		description: "Manually sync ~/.pi/agent: commit local changes (if any), push, then pull (ff-only)",
		handler: async (_args, ctx) => {
			if (!hasRepoAndRemote()) {
				ctx.ui.notify("git-sync: ~/.pi/agent is not a git repo with an 'origin' remote.", "warning");
				return;
			}
			git(["fetch", "origin"], FAST_TIMEOUT_MS);
			const ab = aheadBehind();
			commitDirty(ctx); // explicit user action: commit is allowed here
			pushExisting(ctx, true);
			const after = aheadBehind();
			if (after && after.behind > 0) {
				const pull = git(["pull", "--ff-only", "origin", BRANCH], PUSH_TIMEOUT_MS);
				if (pull.ok) ctx.ui.notify(`git-sync: pulled ${after.behind} commit(s). /reload to apply.`, "info");
				else ctx.ui.notify(`git-sync: pull failed — ${pull.stderr.trim().slice(0, 200)}`, "warning");
			} else if (ab && ab.ahead === 0 && ab.behind === 0 && !isDirty()) {
				ctx.ui.notify("git-sync: already up to date with origin/main.", "info");
			}
		},
	});
}
