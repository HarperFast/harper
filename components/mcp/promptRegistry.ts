/**
 * MCP prompt registry — framework for `prompts/list` and `prompts/get` per MCP
 * §server/prompts (rev 2025-06-18). Mirrors `toolRegistry.ts`.
 *
 * Prompts are **author-declared** content (#1349 §3.5): Harper has no template /
 * canned-message primitive to derive them from, so a component author publishes
 * them via `static mcpPrompts` on a Resource (see `registerCustomMcpPrompts` in
 * `tools/application.ts`), each with a `render(args)` that returns the messages.
 * Unlike tools, prompts carry no per-user RBAC visibility — they're generic
 * templates, listed to everyone on their profile.
 */
import { encodeCursor } from './pagination.ts';
import type { McpProfile } from './transport.ts';
import type { AuthedUser } from './toolRegistry.ts';

export interface PromptArgument {
	name: string;
	description?: string;
	required?: boolean;
	/**
	 * Author-declared candidate values for `completion/complete` on this argument
	 * (#1349 §3.2). Prompts have no schema to derive candidates from, so completion
	 * is opt-in: omit for no completions.
	 */
	values?: ReadonlyArray<string>;
}

export interface PromptContent {
	type: 'text' | 'image' | 'audio' | 'resource';
	text?: string;
	data?: string;
	mimeType?: string;
}

export interface PromptMessage {
	role: 'user' | 'assistant';
	content: PromptContent;
}

/** Public shape sent to clients on `prompts/list`. */
export interface PromptDescriptor {
	name: string;
	title?: string;
	description?: string;
	arguments?: PromptArgument[];
}

/** Result of `prompts/get` — the rendered conversation. */
export interface PromptGetResult {
	description?: string;
	messages: PromptMessage[];
}

export interface PromptRenderContext {
	user: AuthedUser;
	profile: McpProfile;
	sessionId: string;
}

/**
 * Internal prompt definition. `render` and `profile` are not sent to the
 * client; only the public `PromptDescriptor` fields are.
 */
export interface PromptDef extends PromptDescriptor {
	profile: McpProfile;
	render: (args: Record<string, string>, context: PromptRenderContext) => PromptGetResult | Promise<PromptGetResult>;
}

const DEFAULT_LIMIT = 200;

const registry = new Map<string, PromptDef>();

export function addPrompt(def: PromptDef): void {
	if (!def?.name) throw new Error('addPrompt: name is required');
	if (typeof def.render !== 'function') throw new Error(`addPrompt: prompt '${def.name}' requires a render function`);
	registry.set(def.name, def);
}

export function removePrompt(name: string): boolean {
	return registry.delete(name);
}

export function getPrompt(name: string): PromptDef | undefined {
	return registry.get(name);
}

/** Snapshot every prompt registered for a profile (for atomic-rebuild restore). */
export function snapshotProfilePrompts(profile: McpProfile): PromptDef[] {
	const out: PromptDef[] = [];
	for (const def of registry.values()) {
		if (def.profile === profile) out.push(def);
	}
	return out;
}

/** Remove every prompt registered for a profile (rebuild on component refresh). */
export function clearProfilePrompts(profile: McpProfile): void {
	for (const [name, def] of registry) {
		if (def.profile === profile) registry.delete(name);
	}
}

/** Test seam: drop all registrations. */
export function _resetPromptRegistryForTest(): void {
	registry.clear();
}

export interface ListPromptsResult {
	prompts: PromptDescriptor[];
	nextCursor?: string;
}

/**
 * List prompts for a profile, paginated by opaque cursor offset like the other
 * list methods. `offset` is the decoded cursor (the transport rejects malformed
 * cursors with `-32602` first). Sorted by name for stable cursor offsets.
 */
export function listPrompts(profile: McpProfile, offset?: number, limit?: number): ListPromptsResult {
	const all: PromptDescriptor[] = [];
	for (const def of registry.values()) {
		if (def.profile !== profile) continue;
		all.push({
			name: def.name,
			...(def.title ? { title: def.title } : {}),
			...(def.description ? { description: def.description } : {}),
			// Project to the spec PromptArgument shape — `values` is an internal field
			// (completion candidates) and must not leak into the prompts/list response.
			...(def.arguments
				? {
						arguments: def.arguments.map((a) => ({
							name: a.name,
							...(a.description ? { description: a.description } : {}),
							...(a.required ? { required: a.required } : {}),
						})),
					}
				: {}),
		});
	}
	all.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	const start = offset ?? 0;
	const max = limit && limit > 0 ? limit : DEFAULT_LIMIT;
	const slice = all.slice(start, start + max);
	const next = start + slice.length;
	return {
		prompts: slice,
		nextCursor: next < all.length ? encodeCursor(next) : undefined,
	};
}

/**
 * Complete a prompt argument (`ref/prompt`) from the argument's author-declared
 * `values` (#1349 §3.2), prefix-matched (case-insensitive) and capped at 100.
 * Empty when the prompt/argument is unknown or declares no candidate values.
 */
export function completePromptArgument(
	profile: McpProfile,
	promptName: string | undefined,
	argName: string,
	value: string
): { values: string[]; total: number; hasMore: boolean } {
	const empty = { values: [], total: 0, hasMore: false };
	if (!promptName) return empty;
	const prompt = registry.get(promptName);
	if (!prompt || prompt.profile !== profile) return empty;
	const arg = prompt.arguments?.find((a) => a.name === argName);
	if (!arg?.values || arg.values.length === 0) return empty;
	const partial = (value ?? '').toLowerCase();
	const filtered = arg.values.filter((v) => v.toLowerCase().startsWith(partial)).sort();
	const capped = filtered.slice(0, 100);
	return { values: capped, total: filtered.length, hasMore: filtered.length > capped.length };
}

/** Count of prompts registered for a profile — used to suppress no-op list_changed. */
export function countProfilePrompts(profile: McpProfile): number {
	let n = 0;
	for (const def of registry.values()) if (def.profile === profile) n++;
	return n;
}
