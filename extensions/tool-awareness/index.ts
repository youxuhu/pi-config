/**
 * tool-awareness — make extension-registered tools visible to the model.
 *
 * pi only lists tools with a promptSnippet in the system prompt's "Available
 * tools" section; tools without one (or tools the model tends to overlook)
 * stay invisible to weaker models. This extension appends a compact list of
 * every extension-registered, currently-active tool to the system prompt each
 * run, so newly added plugins are automatically discoverable.
 *
 * Runs chained after plan-switch's role injection (which prepends role
 * instructions); plan and build roles both get the list.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_DESC_LENGTH = 110;

export default function toolAwareness(pi: ExtensionAPI) {
	pi.on("before_agent_start", (event) => {
		const active = new Set(pi.getActiveTools());
		const lines = pi
			.getAllTools()
			.filter(
				(t) =>
					t.sourceInfo?.source !== "builtin" &&
					t.sourceInfo?.source !== "sdk" &&
					active.has(t.name),
			)
			.map((t) => {
				const desc = (t.description || "").split("\n")[0]?.trim().slice(0, MAX_DESC_LENGTH) ?? "";
				return `- ${t.name}${desc ? ` — ${desc}` : ""}`;
			});
		if (lines.length === 0) return undefined;
		return {
			systemPrompt:
				event.systemPrompt +
				"\n\n## EXTENSION TOOLS (registered by local plugins — prefer them when relevant)\n" +
				lines.join("\n"),
		};
	});
}
