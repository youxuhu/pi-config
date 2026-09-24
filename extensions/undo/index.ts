/**
 * undo — opencode-style /undo for pi.
 *
 * Snapshots files just before the write/edit tools modify them (bucketed per
 * turn) and /undo restores the most recent turn's changes: previous content is
 * written back, files that did not exist are deleted.
 *
 * Scope & limits:
 *   - Tracks `write` and `edit` tool calls only; bash/ast_grep edits are NOT
 *     snapshot (documented limitation).
 *   - In-memory, per session: max 50 files / 20 MB; oldest turns are dropped.
 *   - /undo restores blindly — a later manual edit to the same file will be
 *     overwritten by the restore.
 */

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const MAX_ENTRIES = 50;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const WRITE_TOOLS = new Set(["write", "edit"]);

interface Snapshot {
	path: string; // absolute path
	/** Previous content; null = file did not exist before the tool ran. */
	data: Buffer | null;
	bytes: number;
}

export default function undo(pi: ExtensionAPI) {
	/** Turn buckets, oldest first. Each bucket = snapshots of one turn. */
	let buckets: Snapshot[][] = [];
	let totalEntries = 0;
	let totalBytes = 0;
	let current: Snapshot[] | undefined;

	pi.on("turn_start", async () => {
		current = undefined; // lazily created on first snapshot of the turn
	});

	pi.on("tool_call", (event) => {
		if (!WRITE_TOOLS.has(event.toolName)) return undefined;
		const p = (event.input as { path?: unknown } | undefined)?.path;
		if (typeof p !== "string" || p.length === 0) return undefined;

		let target: string;
		try {
			target = resolve(p.startsWith("~") ? join2(homedir(), p.slice(1)) : p);
		} catch {
			return undefined;
		}

		let snap: Snapshot;
		try {
			const data = readFileSync(target); // throws if missing
			snap = { path: target, data, bytes: data.length };
		} catch {
			snap = { path: target, data: null, bytes: 0 };
		}

		if (!current) {
			current = [];
			buckets.push(current);
		}
		current.push(snap);
		totalEntries++;
		totalBytes += snap.bytes;

		// Drop oldest buckets when over budget.
		while (buckets.length > 1 && (totalEntries > MAX_ENTRIES || totalBytes > MAX_TOTAL_BYTES)) {
			const oldest = buckets[0]!;
			if (buckets === undefined || oldest === current) break;
			for (const s of oldest) {
				totalEntries--;
				totalBytes -= s.bytes;
			}
			buckets.shift();
		}
		return undefined;
	});

	pi.registerCommand("undo", {
		description: "Undo the last turn's file changes made via write/edit (opencode-style)",
		handler: async (_args, ctx) => {
			// Skip empty trailing buckets (turns that only read).
			while (buckets.length > 0 && buckets[buckets.length - 1]!.length === 0) buckets.pop();
			const bucket = buckets.pop();
			current = undefined;
			if (!bucket || bucket.length === 0) {
				ctx.ui.notify("undo: nothing to undo.", "info");
				return;
			}
			const restored: string[] = [];
			try {
				for (const snap of [...bucket].reverse()) {
					if (snap.data === null) {
						// File was created by the agent — remove it.
						rmSync(snap.path, { force: true });
						restored.push(`deleted ${snap.path}`);
					} else {
						mkdirSync(dirname(snap.path), { recursive: true });
						writeFileSync(snap.path, snap.data);
						restored.push(`restored ${snap.path}`);
					}
					totalEntries--;
					totalBytes -= snap.bytes;
				}
				ctx.ui.notify(`undo: ${bucket.length} file(s) reverted.\n${restored.join("\n")}`, "info");
			} catch (err) {
				ctx.ui.notify(`undo: restore failed — ${err instanceof Error ? err.message : String(err)}`, "warning");
			}
		},
	});
}

/** join without importing node:path twice (kept local for clarity). */
function join2(a: string, b: string): string {
	return a.endsWith("/") ? a + b : a + "/" + b;
}
