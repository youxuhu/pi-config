/**
 * llm-speed — output tok/s in the footer stats line.
 *
 * The stats line (`↑in ↓out R… CH… $… x%/1.0M`) is part of the BUILT-IN footer,
 * and setStatus can only reach its third line (extension statuses). So this
 * extension replaces the footer via ctx.ui.setFooter() and faithfully mirrors
 * the three built-in lines (see dist/modes/interactive/components/footer.js),
 * inserting a colored speed segment into line 2.
 *
 * Speed: output tokens / generation time. message_start records t0; the FIRST
 * message_update re-records t0 (excluding time-to-first-token); message_end
 * computes usage.output / elapsed. One value per LLM response, latest wins.
 *
 * Bands: <100 error(红) · 100–200 dim(灰) · 200–300 accent(蓝) · ≥300 success(绿).
 *
 * Approximations vs built-in footer (data not accessible from extensions):
 *   - "(auto)" compact marker shown unconditionally (auto-compact is default-on)
 *   - "xp" experimental badge omitted
 *   - "(sub)" only approximated for provider === "kimi-coding"
 *
 * Commands: /speed (show latest) · /speed on | off (mount custom / restore built-in).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const NOTIFY_MAX_LINES = 4;

type Theme = Parameters<Parameters<ExtensionContext["ui"]["setFooter"]>[0]>[1];

interface UsageLike {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { total: number };
}

function fmtTokens(n: number): string {
	return n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`;
}

function fmtCwd(cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE || "";
	if (!home || !cwd.startsWith(home)) return cwd;
	const rel = cwd.slice(home.length);
	return rel === "" ? "~" : `~${rel}`;
}

function speedColor(speed: number, theme: Theme): string {
	const label = `${Math.round(speed)} t/s`;
	if (speed < 100) return theme.fg("error", label);
	if (speed < 200) return theme.fg("dim", label);
	if (speed < 300) return theme.fg("accent", label);
	return theme.fg("success", label);
}

export default function llmSpeed(pi: ExtensionAPI) {
	let t0: number | undefined;
	let latestSpeed: number | undefined;
	let requestRender: (() => void) | undefined;
	let enabled = true;

	const computeSpeed = (ctx: ExtensionContext, usage: UsageLike): void => {
		if (ctx.mode !== "tui") return;
		if (t0 === undefined || usage.output <= 0) return;
		const elapsedSec = (performance.now() - t0) / 1000;
		t0 = undefined;
		if (elapsedSec <= 0) return;
		latestSpeed = usage.output / elapsedSec;
		requestRender?.();
	};

	const buildStatsLine = (ctx: ExtensionContext, theme: Theme, footerData: unknown, width: number): string => {
		// Cumulative usage across ALL session entries (mirrors built-in footer).
		let input = 0;
		let output = 0;
		let cacheRead = 0;
		let cacheWrite = 0;
		let cost = 0;
		let latestCacheHitRate: number | undefined;
		for (const entry of ctx.sessionManager.getEntries() as Array<Record<string, any>>) {
			if (entry.type === "message" && entry.message?.role === "assistant") {
				const u = entry.message.usage as UsageLike | undefined;
				if (!u) continue;
				input += u.input;
				output += u.output;
				cacheRead += u.cacheRead;
				cacheWrite += u.cacheWrite;
				cost += u.cost.total;
				const promptTokens = u.input + u.cacheRead + u.cacheWrite;
				latestCacheHitRate = promptTokens > 0 ? (u.cacheRead / promptTokens) * 100 : undefined;
			} else if (entry.type === "message" && entry.message?.role === "toolResult" && entry.message.usage) {
				const u = entry.message.usage as UsageLike;
				input += u.input;
				output += u.output;
				cacheRead += u.cacheRead;
				cacheWrite += u.cacheWrite;
				cost += u.cost.total;
			} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
				const u = entry.usage as UsageLike;
				input += u.input;
				output += u.output;
				cacheRead += u.cacheRead;
				cacheWrite += u.cacheWrite;
				cost += u.cost.total;
			}
		}

		// Context usage (compaction-aware).
		const contextUsage = ctx.getContextUsage() as { percent: number | null; contextWindow?: number } | undefined;
		const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
		const contextPercentValue = contextUsage?.percent ?? 0;
		const contextPercent = contextUsage?.percent !== null && contextUsage?.percent !== undefined ? contextPercentValue.toFixed(1) : "?";

		const parts: string[] = [];
		if (input) parts.push(`↑${fmtTokens(input)}`);
		if (output) parts.push(`↓${fmtTokens(output)}`);
		if (cacheRead) parts.push(`R${fmtTokens(cacheRead)}`);
		if (cacheWrite) parts.push(`W${fmtTokens(cacheWrite)}`);
		if ((cacheRead > 0 || cacheWrite > 0) && latestCacheHitRate !== undefined) {
			parts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
		}
		const usingSubscription = ctx.model?.provider === "kimi-coding"; // approximation, see header
		if (cost || usingSubscription) parts.push(`$${cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
		// The speed segment — the reason this footer exists.
		if (latestSpeed !== undefined) parts.push(speedColor(latestSpeed, theme));
		// "(auto)" marker: built-in shows it only when auto-compact is enabled;
		// that flag is not accessible, and auto-compact is on by default.
		const contextDisplay = `${contextPercent}%/${fmtTokens(contextWindow)} (auto)`;
		if (contextPercentValue > 90) parts.push(theme.fg("error", contextDisplay));
		else if (contextPercentValue > 70) parts.push(theme.fg("warning", contextDisplay));
		else parts.push(contextDisplay);

		let statsLeft = parts.join(" ");
		let statsLeftWidth = visibleWidth(statsLeft);
		if (statsLeftWidth > width) {
			statsLeft = truncateToWidth(statsLeft, width, "...");
			statsLeftWidth = visibleWidth(statsLeft);
		}

		// Right side: model id + thinking level + provider prefix (if room).
		const modelName = ctx.model?.id || "no-model";
		let rightSide = modelName;
		if (ctx.model?.reasoning) {
			const level = ctx.thinkingLevel || "off";
			rightSide = level === "off" ? `${modelName} • thinking off` : `${modelName} • ${level}`;
		}
		const fd = footerData as { getAvailableProviderCount?: () => number } | undefined;
		if (ctx.model && typeof fd?.getAvailableProviderCount === "function" && fd.getAvailableProviderCount() > 1) {
			const withProvider = `(${ctx.model.provider}) ${rightSide}`;
			if (statsLeftWidth + 2 + visibleWidth(withProvider) <= width) rightSide = withProvider;
		}
		const rightSideWidth = visibleWidth(rightSide);
		if (statsLeftWidth + 2 + rightSideWidth <= width) {
			const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
			statsLeft = statsLeft + padding + rightSide;
		} else {
			const availableForRight = width - statsLeftWidth - 2;
			if (availableForRight > 0) {
				const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
				const padding = " ".repeat(Math.max(0, width - statsLeftWidth - visibleWidth(truncatedRight)));
				statsLeft = statsLeft + padding + truncatedRight;
			}
		}
		return statsLeft;
	};

	const mountFooter = (ctx: ExtensionContext): void => {
		ctx.ui.setFooter((tui, theme, footerData) => {
			requestRender = () => tui.requestRender();
			const unsub = footerData.onBranchChange(() => tui.requestRender());
			return {
				dispose: () => {
					unsub();
					if (requestRender) requestRender = undefined;
				},
				invalidate() {},
				render(width: number): string[] {
					try {
						// Line 1: pwd (branch) • session name
						let pwd = fmtCwd(ctx.sessionManager.getCwd());
						const branch = footerData.getGitBranch();
						if (branch) pwd = `${pwd} (${branch})`;
						const sessionName = ctx.sessionManager.getSessionName();
						if (sessionName) pwd = `${pwd} • ${sessionName}`;
						const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));

						// Line 2: stats + speed, model right-aligned. Same dim treatment as
						// built-in: dim left part and remainder separately (inner ANSI resets).
						const statsLine = buildStatsLine(ctx, theme, footerData, width);
						const statsLeftWidth = Math.min(visibleWidth(statsLine), width);
						const dimmedStats = theme.fg("dim", statsLine.slice(0, statsLeftWidth));
						const remainder = statsLine.slice(statsLeftWidth);
						const line2 = dimmedStats + theme.fg("dim", remainder);

						// Line 3: extension statuses (plan / sandbox / git …), alphabetical.
						const lines = [pwdLine, line2];
						const statuses = footerData.getExtensionStatuses();
						if (statuses.size > 0) {
							const statusLine = Array.from(statuses.entries())
								.sort(([a], [b]) => a.localeCompare(b))
								// Mirror built-in sanitize: only [\r\n\t]. Stripping other control chars
						// (e.g. \x1b) would shred ANSI escapes into literal “[38;2…m” text.
						.map(([, text]) => text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim())
								.join(" ");
							lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
						}
						return lines;
					} catch {
						return [theme.fg("dim", "footer error (llm-speed)")];
					}
				},
			};
		});
	};

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode === "tui" && enabled) mountFooter(ctx);
	});

	pi.on("message_start", async (event, ctx) => {
		if (ctx.mode !== "tui") return;
		if (event.message.role === "assistant") t0 = performance.now();
	});

	pi.on("message_update", async (event, ctx) => {
		if (ctx.mode !== "tui") return;
		// First streamed chunk: restart the clock to exclude time-to-first-token.
		if (event.message.role === "assistant" && t0 === undefined) t0 = performance.now();
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const usage = (event.message as { usage?: UsageLike }).usage;
		if (!usage) return;
		computeSpeed(ctx, usage);
	});

	pi.registerCommand("speed", {
		description: "LLM output speed: /speed (latest) · /speed on|off (custom footer on/off)",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "off") {
				enabled = false;
				ctx.ui.setFooter(undefined);
				ctx.ui.notify("Built-in footer restored.", "info");
				return;
			}
			if (arg === "on") {
				enabled = true;
				if (ctx.mode === "tui") mountFooter(ctx);
				ctx.ui.notify("llm-speed footer mounted.", "info");
				return;
			}
			if (latestSpeed === undefined) {
				ctx.ui.notify("No LLM response measured yet.", "info");
				return;
			}
			const lines = [
				`最近输出速度：${Math.round(latestSpeed)} tok/s`,
				`档位：<100 红 · 100-200 灰 · 200-300 蓝 · ≥300 绿`,
			];
			ctx.ui.notify(lines.slice(0, NOTIFY_MAX_LINES).join("\n"), "info");
		},
	});
}
