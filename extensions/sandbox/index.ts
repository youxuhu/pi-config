/**
 * sandbox — permission gate for writes outside the project root.
 *
 * Runs in BUILD mode only (plan mode is already read-only via plan-switch and
 * the sandbox learns the current role over the pi event bus). While in build
 * mode and in "ask" mode, any `write`/`edit` whose target resolves OUTSIDE the
 * session cwd requires user approval:
 *
 *   - Allow once   : allow this single call
 *   - Always allow : remember the exact resolved path (persisted) and allow
 *   - Deny         : block the call
 *
 * A mode selector decides whether approval is needed at all:
 *   - ask    : gate outside-root writes (default)
 *   - bypass : no approval, fully permissive ("不需要审批")
 *
 * Config is persisted to ~/.pi/agent/sandbox.json:
 *   { "mode": "ask" | "bypass", "allowedPaths": ["/abs/path", ...] }
 *
 * Commands: /sandbox [ask | bypass | status | clear]
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const CONFIG_PATH = join(homedir(), ".pi", "agent", "sandbox.json");
/** Tools that modify a file named by `input.path`. */
const WRITE_TOOLS = new Set(["write", "edit"]);

type Mode = "ask" | "bypass";

interface SandboxConfig {
	mode: Mode;
	allowedPaths: string[];
}

function loadConfig(): SandboxConfig {
	try {
		if (existsSync(CONFIG_PATH)) {
			const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<SandboxConfig>;
			const mode: Mode = raw.mode === "bypass" ? "bypass" : "ask";
			const allowedPaths = Array.isArray(raw.allowedPaths)
				? raw.allowedPaths.filter((p): p is string => typeof p === "string")
				: [];
			return { mode, allowedPaths };
		}
	} catch {
		/* fall through to defaults */
	}
	return { mode: "ask", allowedPaths: [] };
}

function saveConfig(cfg: SandboxConfig): void {
	try {
		writeFileSync(CONFIG_PATH, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
	} catch {
		/* best-effort persistence */
	}
}

function expandHome(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return join(homedir(), p.slice(2));
	return p;
}

function isInside(root: string, target: string): boolean {
	const r = resolve(root);
	const t = resolve(target);
	return t === r || t.startsWith(r + sep);
}

export default function sandbox(pi: ExtensionAPI) {
	const cfg = loadConfig();
	const allowed = new Set<string>(cfg.allowedPaths.map((p) => resolve(expandHome(p))));
	let mode: Mode = cfg.mode;
	// Default to build so that, if plan-switch is absent, out-of-root writes are
	// still gated (fail safe).
	let role: "build" | "plan" = "build";
	let currentCtx: ExtensionContext | undefined;

	const persist = () => saveConfig({ mode, allowedPaths: [...allowed] });

	const updateStatus = () => {
		if (!currentCtx) return;
		const label = mode === "bypass" ? "sandbox:bypass" : "sandbox:ask";
		currentCtx.ui.setStatus(
			"sandbox",
			currentCtx.ui.theme.fg(mode === "bypass" ? "warning" : "success", label),
		);
	};

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
		role = "build";
		updateStatus();
	});

	pi.on("session_shutdown", async () => {
		currentCtx = undefined;
	});

	// plan-switch broadcasts the active role so the sandbox only gates in build mode.
	pi.events.on("plan-switch:role", (data) => {
		const r = (data as { role?: string } | undefined)?.role;
		if (r === "plan" || r === "build") role = r;
		updateStatus();
	});

	pi.on("tool_call", async (event, ctx) => {
		if (role !== "build") return undefined; // plan mode has its own read-only guard
		if (mode === "bypass") return undefined; // no-approval mode: fully permissive
		if (!WRITE_TOOLS.has(event.toolName)) return undefined;

		const raw = (event.input as { path?: unknown } | undefined)?.path;
		if (typeof raw !== "string" || raw.length === 0) return undefined;

		const target = resolve(ctx.cwd, expandHome(raw));
		if (isInside(ctx.cwd, target)) return undefined; // inside project root → allowed
		if (allowed.has(target)) return undefined; // previously "Always allow"

		if (!ctx.hasUI) {
			return {
				block: true,
				reason: `Sandbox: write outside the project root requires approval (no UI available): ${target}`,
			};
		}

		const title =
			`⚠️ 沙盒：写入项目根目录以外\n\n  ${target}\n\n` +
			`项目根：${resolve(ctx.cwd)}\n\n是否允许？`;
		const choice = await ctx.ui.select(title, ["Allow once", "Always allow", "Deny"]);

		if (choice === "Always allow") {
			allowed.add(target);
			persist();
			return undefined;
		}
		if (choice === "Allow once") return undefined;
		return {
			block: true,
			reason: `Sandbox: user denied write outside the project root: ${target}`,
		};
	});

	pi.registerCommand("sandbox", {
		description: "Sandbox mode for out-of-root writes: /sandbox [ask|bypass|status|clear]",
		handler: async (args, ctx) => {
			currentCtx = ctx;
			const arg = args.trim().toLowerCase();

			const setMode = (m: Mode) => {
				mode = m;
				persist();
				updateStatus();
				ctx.ui.notify(`Sandbox mode: ${m}`, "info");
			};

			if (arg === "ask") return setMode("ask");
			if (arg === "bypass") return setMode("bypass");
			if (arg === "clear") {
				allowed.clear();
				persist();
				ctx.ui.notify("Sandbox allowlist cleared.", "info");
				return;
			}
			if (arg === "status") {
				ctx.ui.notify(`Sandbox mode: ${mode} · allowlist: ${allowed.size} path(s)`, "info");
				return;
			}
			if (arg) {
				ctx.ui.notify(`Unknown arg '${arg}'. Use: ask | bypass | status | clear`, "warning");
				return;
			}

			const choice = await ctx.ui.select("Sandbox mode（项目根以外的写入）", [
				"需要审批 (ask)",
				"不需要审批 (bypass)",
			]);
			if (choice === "需要审批 (ask)") setMode("ask");
			else if (choice === "不需要审批 (bypass)") setMode("bypass");
		},
	});
}
