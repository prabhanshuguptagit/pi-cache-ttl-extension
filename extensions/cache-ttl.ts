/**
 * Footer with a countdown to prompt-cache expiry, shown next to the cache hit rate.
 *
 * The cached prefix is only reusable for the provider's TTL after the last
 * request; past that the whole prompt is re-billed at input rates.
 *
 * Replaces the built-in footer, because extension statuses render on their own
 * line and this belongs beside the other cache numbers. The layout mirrors
 * pi's own footer; `(auto)` is read from settings and so misses a runtime
 * `/settings` toggle.
 */

import { readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const LONG_TTL_MS: Record<string, number> = {
	anthropic: 60 * 60 * 1000,
	openai: 24 * 60 * 60 * 1000,
};

function ttlMs(ctx: ExtensionContext): number {
	if (process.env.PI_CACHE_RETENTION !== "long") return DEFAULT_TTL_MS;
	const api = ctx.model?.api ?? "";
	return LONG_TTL_MS[api.startsWith("openai") ? "openai" : "anthropic"];
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function formatRemaining(remainingMs: number): string {
	const seconds = Math.ceil(remainingMs / 1000);
	if (seconds >= 5400) return `${Math.round(seconds / 3600)}h`;
	if (seconds >= 90) return `${Math.round(seconds / 60)}m`;
	return `${seconds}s`;
}

function formatCwd(cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (!home) return cwd;
	const rel = relative(resolve(home), resolve(cwd));
	if (rel === "") return "~";
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return cwd;
	return `~${sep}${rel}`;
}

function autoCompactEnabled(cwd: string): boolean {
	for (const path of [
		join(cwd, CONFIG_DIR_NAME, "settings.json"),
		join(process.env.HOME ?? "", `.${CONFIG_DIR_NAME}`, "agent", "settings.json"),
	]) {
		try {
			const enabled = JSON.parse(readFileSync(path, "utf8"))?.compaction?.enabled;
			if (typeof enabled === "boolean") return enabled;
		} catch {}
	}
	return true;
}

export default function (pi: ExtensionAPI) {
	let lastRequestAt: number | undefined;
	let cacheReported = false;
	let running = false;
	let timer: ReturnType<typeof setInterval> | undefined;

	const seed = (ctx: ExtensionContext) => {
		for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			lastRequestAt = entry.message.timestamp;
			cacheReported = entry.message.usage.cacheRead + entry.message.usage.cacheWrite > 0;
			return;
		}
	};

	const cacheField = (ctx: ExtensionContext): { text: string; color: "dim" | "warning" | "error" } | undefined => {
		if (running || lastRequestAt === undefined || !cacheReported) return undefined;
		const remaining = lastRequestAt + ttlMs(ctx) - Date.now();
		if (remaining <= 0) return { text: "cold", color: "error" };
		return { text: formatRemaining(remaining), color: remaining < 60_000 ? "warning" : "dim" };
	};

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		seed(ctx);

		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
			let painted: string | undefined;

			timer ??= setInterval(() => {
				const current = cacheField(ctx)?.text;
				if (current === painted) return;
				painted = current;
				tui.requestRender();
			}, 1000);
			timer.unref?.();

			return {
				dispose: () => {
					unsubscribe();
					if (timer) clearInterval(timer);
					timer = undefined;
				},
				invalidate() {},
				render(width: number): string[] {
					const dim = (text: string) => theme.fg("dim", text);

					let pwd = formatCwd(ctx.sessionManager.getCwd());
					const branch = footerData.getGitBranch();
					if (branch) pwd = `${pwd} (${branch})`;
					const name = ctx.sessionManager.getSessionName();
					if (name) pwd = `${pwd} • ${name}`;

					const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
					let hitRate: number | undefined;
					for (const entry of ctx.sessionManager.getEntries()) {
						const usage =
							entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "toolResult")
								? entry.message.usage
								: (entry.type === "compaction" || entry.type === "branch_summary") && entry.usage
									? entry.usage
									: undefined;
						if (!usage) continue;
						totals.input += usage.input;
						totals.output += usage.output;
						totals.cacheRead += usage.cacheRead;
						totals.cacheWrite += usage.cacheWrite;
						totals.cost += usage.cost.total;
						if (entry.type === "message" && entry.message.role === "assistant") {
							const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
							hitRate = prompt > 0 ? (usage.cacheRead / prompt) * 100 : undefined;
						}
					}

					const parts: string[] = [];
					if (totals.input) parts.push(dim(`↑${formatTokens(totals.input)}`));
					if (totals.output) parts.push(dim(`↓${formatTokens(totals.output)}`));
					if (totals.cacheRead) parts.push(dim(`R${formatTokens(totals.cacheRead)}`));
					if (totals.cacheWrite) parts.push(dim(`W${formatTokens(totals.cacheWrite)}`));
					if ((totals.cacheRead > 0 || totals.cacheWrite > 0) && hitRate !== undefined) {
						parts.push(dim(`CH${hitRate.toFixed(1)}%`));
					}

					const cache = cacheField(ctx);
					if (cache) parts.push(theme.fg(cache.color, `cache ${cache.text}`));

					const subscription = ctx.model
						? ctx.model.provider === "kimi-coding" ||
							(ctx.modelRegistry.isUsingOAuth(ctx.model) &&
								ctx.modelRegistry.getProvider(ctx.model.provider)?.auth.oauth?.isSubscription === true)
						: false;
					if (totals.cost || subscription) {
						parts.push(dim(`$${totals.cost.toFixed(3)}${subscription ? " (sub)" : ""}`));
					}

					const usage = ctx.getContextUsage();
					const window = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
					const percent = usage?.percent ?? null;
					const auto = autoCompactEnabled(ctx.cwd) ? " (auto)" : "";
					const contextText = `${percent === null ? "?" : percent.toFixed(1)}%/${formatTokens(window)}${auto}`;
					parts.push(
						theme.fg(percent === null ? "dim" : percent > 90 ? "error" : percent > 70 ? "warning" : "dim", contextText),
					);

					let left = parts.join(" ");
					if (visibleWidth(left) > width) left = truncateToWidth(left, width, "...");

					const model = ctx.model?.id ?? "no-model";
					const thinking = ctx.thinkingLevel || "off";
					let right = !ctx.model?.reasoning
						? model
						: thinking === "off"
							? `${model} • thinking off`
							: `${model} • ${thinking}`;
					if (footerData.getAvailableProviderCount() > 1 && ctx.model) {
						const withProvider = `(${ctx.model.provider}) ${right}`;
						if (visibleWidth(left) + 2 + visibleWidth(withProvider) <= width) right = withProvider;
					}

					const space = width - visibleWidth(left) - visibleWidth(right);
					const statsLine =
						space >= 2
							? left + " ".repeat(space) + dim(right)
							: truncateToWidth(left + "  " + dim(right), width, "");

					const lines = [truncateToWidth(dim(pwd), width, dim("...")), statsLine];

					const statuses = Array.from(footerData.getExtensionStatuses().entries())
						.sort(([a], [b]) => a.localeCompare(b))
						.map(([, text]) => text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim());
					if (statuses.length > 0) lines.push(truncateToWidth(statuses.join(" "), width, dim("...")));

					return lines;
				},
			};
		});
	});

	pi.on("agent_start", async () => {
		running = true;
	});

	pi.on("message_end", async (event) => {
		if (event.message.role !== "assistant") return;
		lastRequestAt = Date.now();
		cacheReported ||= event.message.usage.cacheRead + event.message.usage.cacheWrite > 0;
	});

	pi.on("agent_settled", async () => {
		running = false;
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setFooter(undefined);
	});
}
