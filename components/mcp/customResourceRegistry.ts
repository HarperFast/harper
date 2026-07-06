/**
 * MCP custom-resource registry — component-author content resources (#1609).
 * Mirrors `toolRegistry.ts` / `promptRegistry.ts`.
 *
 * The discovered resource surface (`resources.ts`) exposes Resource *descriptors*
 * and `harper://` metadata; it has no way to serve author-defined content (a docs
 * page, a rendered report) under an author-chosen URI. Authors publish such
 * content via `static mcpResources` on a Resource (see
 * `registerCustomMcpResources` in `tools/application.ts`): each entry declares a
 * fixed `uri` or an RFC-6570-style `uriTemplate` (`{name}` matches one path
 * segment, `{+name}` matches across segments) and a `read` that returns `text`
 * or `blob` content per MCP §server/resources (rev 2025-06-18).
 *
 * Like custom tools (#622), RBAC is delegated to the Resource: entries are
 * listed to every session on the profile — including anonymous/unauthenticated
 * sessions where the deployment allows them (the public-docs case #1609 is
 * built around) — and the author's method enforces any access control it
 * needs at read time.
 */
import type { McpProfile } from './transport.ts';
import type { AuthedUser } from './toolRegistry.ts';

/** Context passed to a custom resource `read` (subset of a tool call's context). */
export interface ResourceReadContext {
	user: AuthedUser;
	profile: McpProfile;
	sessionId?: string;
}

/** What an author `read` may return; a bare string means text content. */
export interface CustomResourceContent {
	text?: string;
	/** Base64-encoded binary content. */
	blob?: string;
	mimeType?: string;
}
export type CustomResourceReadResult = string | CustomResourceContent | object;

export interface CustomResourceDef {
	/** Fixed URI — exactly one of `uri` / `uriTemplate` is set. */
	uri?: string;
	/** URI template with `{name}` / `{+name}` placeholders. */
	uriTemplate?: string;
	name: string;
	title?: string;
	description?: string;
	mimeType?: string;
	profile: McpProfile;
	/** Author-declared completion candidates per template parameter (#1349 §3.2). */
	completions?: Readonly<Record<string, ReadonlyArray<string>>>;
	read: (
		params: Record<string, string>,
		context: ResourceReadContext
	) => CustomResourceReadResult | Promise<CustomResourceReadResult>;
}

interface CompiledDef {
	def: CustomResourceDef;
	/** Present for template entries only. */
	regex?: RegExp;
	paramNames?: string[];
}

const registry = new Map<McpProfile, CompiledDef[]>();

/**
 * Compile a URI template into a matcher. `{name}` matches a single path
 * segment (`[^/]+`); `{+name}` matches across segments (`.+`), mirroring
 * RFC 6570 level-2 reserved expansion, which is how MCP clients construct
 * URIs from templates. Throws on malformed templates so registration can
 * warn-and-skip the entry.
 */
export function compileUriTemplate(template: string): { regex: RegExp; paramNames: string[] } {
	const paramNames: string[] = [];
	let pattern = '';
	let index = 0;
	while (index < template.length) {
		const open = template.indexOf('{', index);
		if (open === -1) {
			pattern += escapeRegex(template.slice(index));
			break;
		}
		pattern += escapeRegex(template.slice(index, open));
		const close = template.indexOf('}', open);
		if (close === -1) throw new Error(`unterminated '{' in uriTemplate: ${template}`);
		let name = template.slice(open + 1, close);
		const reserved = name.startsWith('+');
		if (reserved) name = name.slice(1);
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
			throw new Error(`invalid template parameter '{${template.slice(open + 1, close)}}' in uriTemplate: ${template}`);
		}
		if (paramNames.includes(name)) {
			// a repeated name would silently overwrite the earlier captured value
			throw new Error(`duplicate template parameter '{${name}}' in uriTemplate: ${template}`);
		}
		paramNames.push(name);
		pattern += reserved ? '(.+)' : '([^/]+)';
		index = close + 1;
	}
	if (paramNames.length === 0) throw new Error(`uriTemplate has no parameters (use \`uri\` instead): ${template}`);
	return { regex: new RegExp(`^${pattern}$`), paramNames };
}

function escapeRegex(literal: string): string {
	return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Register a custom resource. Template entries are compiled here; a bad template throws. */
export function addCustomResource(def: CustomResourceDef): void {
	const compiled: CompiledDef = { def };
	if (def.uriTemplate) {
		const { regex, paramNames } = compileUriTemplate(def.uriTemplate);
		compiled.regex = regex;
		compiled.paramNames = paramNames;
	}
	let list = registry.get(def.profile);
	if (!list) {
		list = [];
		registry.set(def.profile, list);
	}
	list.push(compiled);
}

export function clearProfileCustomResources(profile: McpProfile): void {
	registry.delete(profile);
}

/** Snapshot for restore-on-failure during re-registration (see registerApplicationTools). */
export function snapshotProfileCustomResources(profile: McpProfile): CustomResourceDef[] {
	return (registry.get(profile) ?? []).map((c) => c.def);
}

/** Fixed-URI entries, shaped for `resources/list`. */
export function listCustomResources(
	profile: McpProfile
): Array<{ uri: string; name: string; title?: string; description?: string; mimeType?: string }> {
	const out: Array<{ uri: string; name: string; title?: string; description?: string; mimeType?: string }> = [];
	for (const { def } of registry.get(profile) ?? []) {
		if (!def.uri) continue;
		out.push({
			uri: def.uri,
			name: def.name,
			...(def.title ? { title: def.title } : {}),
			...(def.description ? { description: def.description } : {}),
			...(def.mimeType ? { mimeType: def.mimeType } : {}),
		});
	}
	return out;
}

/** Template entries, shaped for `resources/templates/list`. */
export function listCustomResourceTemplates(
	profile: McpProfile
): Array<{ uriTemplate: string; name: string; title?: string; description?: string; mimeType?: string }> {
	const out: Array<{ uriTemplate: string; name: string; title?: string; description?: string; mimeType?: string }> = [];
	for (const { def } of registry.get(profile) ?? []) {
		if (!def.uriTemplate) continue;
		out.push({
			uriTemplate: def.uriTemplate,
			name: def.name,
			...(def.title ? { title: def.title } : {}),
			...(def.description ? { description: def.description } : {}),
			...(def.mimeType ? { mimeType: def.mimeType } : {}),
		});
	}
	return out;
}

/**
 * Match a `resources/read` URI against the profile's custom entries: fixed URIs
 * first (exact string match), then templates in registration order. Registered
 * custom URIs take precedence over the discovered surface, so this runs before
 * the `harper://` / app-resource dispatch in `readResource`.
 */
export function matchCustomResource(
	profile: McpProfile,
	uri: string
): { def: CustomResourceDef; params: Record<string, string> } | undefined {
	const list = registry.get(profile);
	if (!list) return undefined;
	for (const { def } of list) {
		if (def.uri === uri) return { def, params: {} };
	}
	for (const { def, regex, paramNames } of list) {
		if (!regex || !paramNames) continue;
		const match = regex.exec(uri);
		if (!match) continue;
		const params: Record<string, string> = {};
		for (let i = 0; i < paramNames.length; i++) {
			params[paramNames[i]] = decodeURIComponentSafe(match[i + 1]);
		}
		return { def, params };
	}
	return undefined;
}

/** Author-declared completion candidates for a template parameter, if any. */
export function customResourceCompletionValues(
	profile: McpProfile,
	uriTemplate: string,
	argName: string
): string[] | undefined {
	for (const { def } of registry.get(profile) ?? []) {
		if (def.uriTemplate !== uriTemplate) continue;
		const values = def.completions?.[argName];
		return values ? [...values] : undefined;
	}
	return undefined;
}

// Clients may or may not percent-encode template expansions; a stray '%' must
// not turn a read into a URIError.
function decodeURIComponentSafe(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}
