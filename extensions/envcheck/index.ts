/**
 * envcheck — one-shot environment report for multi-machine pi setups.
 *
 * /envcheck verifies, per machine:
 *   - config repo: ~/.pi/agent git remote + connectivity + uncommitted changes
 *   - auth: ~/.pi/agent/auth.json present (else providers will be unauthenticated)
 *   - npm packages: settings.json `packages` vs what is installed under npm/
 *   - read-xlsx dependency: ~/.pi/agent/node_modules/xlsx
 *   - read-pdf renderer: Swift+PDFKit (macOS) or pdftoppm/pdfinfo (Linux/Windows)
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const AGENT_DIR = join(homedir(), ".pi", "agent");

function sh(cmd: string, args: string[], cwd: string, timeoutMs: number): { ok: boolean; out: string } {
	const r = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: timeoutMs });
	if (r.error) return { ok: false, out: String((r.error as Error).message) };
	return { ok: r.status === 0, out: (r.stdout ?? "").trim() };
}

function which(bin: string): boolean {
	return spawnSync("which", [bin], { encoding: "utf8", timeout: 3_000 }).status === 0;
}

function mark(ok: boolean): string {
	return ok ? "✅" : "❌";
}

export default function envcheck(pi: ExtensionAPI) {
	pi.registerCommand("envcheck", {
		description: "Check this machine's pi environment (config repo, auth, npm packages, pdf/xlsx deps)",
		handler: async (_args, ctx) => {
			const lines: string[] = ["environment check — ~/.pi/agent"];

			// 1) Config repo + connectivity
			const isRepo = sh("git", ["rev-parse", "--is-inside-work-tree"], AGENT_DIR, 3_000).out === "true";
			if (!isRepo) {
				lines.push(`${mark(false)} git: ~/.pi/agent is not a git repo (sync unavailable)`);
			} else {
				const remote = sh("git", ["remote", "get-url", "origin"], AGENT_DIR, 3_000);
				lines.push(`${mark(remote.ok)} git remote: ${remote.ok ? remote.out : "origin not configured"}`);
				if (remote.ok) {
					const ls = sh("git", ["ls-remote", "origin", "-h", "refs/heads/main"], AGENT_DIR, 10_000);
					lines.push(`${mark(ls.ok)} GitHub connectivity: ${ls.ok ? "ok" : "unreachable (proxy/network?)"}`);
				}
				const dirty = sh("git", ["status", "--porcelain"], AGENT_DIR, 3_000).out;
				lines.push(`${mark(dirty === "")} local changes: ${dirty === "" ? "clean" : `${dirty.split("\n").length} file(s) uncommitted — /git-sync`}`);
			}

			// 2) auth
			const hasAuth = existsSync(join(AGENT_DIR, "auth.json"));
			lines.push(`${mark(hasAuth)} auth.json: ${hasAuth ? "present" : "missing — providers unauthenticated, re-login or scp from another machine"}`);

			// 3) npm packages vs settings.json
			try {
				const settings = JSON.parse(readFileSync(join(AGENT_DIR, "settings.json"), "utf8")) as { packages?: string[] };
				const pkgs = settings.packages ?? [];
				for (const p of pkgs) {
					if (!p.startsWith("npm:")) continue;
					const name = p.slice(4);
					const installed = existsSync(join(AGENT_DIR, "npm", "node_modules", name));
					lines.push(`${mark(installed)} npm package: ${name}${installed ? "" : " — missing, run: pi update --extensions"}`);
				}
			} catch {
				lines.push(`${mark(false)} settings.json: unreadable`);
			}

			// 4) read-xlsx dependency
			const xlsx = existsSync(join(AGENT_DIR, "node_modules", "xlsx", "package.json"));
			lines.push(`${mark(xlsx)} xlsx (read-xlsx dep): ${xlsx ? "installed" : "missing — npm i --prefix ~/.pi/agent xlsx"}`);

			// 5) read-pdf renderer per platform
			if (process.platform === "darwin") {
				const swift = which("swift");
				lines.push(`${mark(swift)} read-pdf renderer: swift ${swift ? "ok" : "missing (unusual on macOS)"}`);
			} else {
				const pdftoppm = which("pdftoppm");
				const pdfinfo = which("pdfinfo");
				lines.push(
					`${mark(pdftoppm && pdfinfo)} read-pdf renderer: poppler ${pdftoppm && pdfinfo ? "ok" : "missing — apt install poppler-utils | pacman -S poppler"}`,
				);
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
