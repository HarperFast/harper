/**
 * Application-profile tool generation. Walks Harper's `Resources` registry
 * and registers verb tools (`get_*`, `search_*`, `create_*`, `update_*`,
 * `delete_*`) for each exported Resource that:
 *   1. Has a `'mcp'` exportType not explicitly set to `false`.
 *   2. Implements the corresponding verb on its prototype.
 *
 * Tool dispatch delegates to the static `Resource.get/post/put/delete/search`
 * methods, which wrap `transactional()` internally. That means
 * `allowRead/allowCreate/allowUpdate/allowDelete` per-record predicates run
 * unchanged, and restricted-attribute writes are rejected at runtime by
 * `Table.allowUpdate` even when the input schema permits them — defense in
 * depth.
 */
import { createHash } from 'node:crypto';
import * as env from '../../../utility/environment/environmentManager.ts';
import { CONFIG_PARAMS } from '../../../utility/hdbTerms.ts';
import harperLogger from '../../../utility/logging/harper_logger.ts';
import {
	addTool,
	clearProfileTools,
	snapshotProfileTools,
	type AuthedUser,
	type ToolCallContext,
	type ToolResult,
} from '../toolRegistry.ts';
import {
	addPrompt,
	clearProfilePrompts,
	snapshotProfilePrompts,
	type PromptDef,
	type PromptGetResult,
} from '../promptRegistry.ts';
import { notifyPromptsListChanged } from '../listChanged.ts';
import { decodeCursor, encodeCursor } from '../pagination.ts';
import {
	type AttributePermissionEntry,
	type HarperAttribute,
	deriveCreateSchema,
	deriveCreateOutputSchema,
	deriveDeleteSchema,
	deriveDeleteOutputSchema,
	deriveGetSchema,
	deriveGetOutputSchema,
	derivePatchOutputSchema,
	deriveSearchSchema,
	deriveUpdateSchema,
	deriveUpdateOutputSchema,
} from './schemas/derive.ts';

type ExportTypes = Record<string, boolean> | undefined;

interface ResourceRegistryEntry {
	Resource: ResourceClassLike;
	path: string;
	exportTypes?: ExportTypes;
	hasSubPaths?: boolean;
	relativeURL?: string;
}

interface ResourceClassLike {
	prototype?: Record<string, unknown>;
	databaseName?: string;
	tableName?: string;
	primaryKey?: string;
	attributes?: HarperAttribute[];
	description?: string;
	hidden?: boolean;
	properties?: Record<string, unknown>;
	outputSchemas?: { [verb: string]: object };
	mcp?: { annotations?: { [verb: string]: ToolAnnotationsLike } };
	get?: (target: unknown, request: unknown, data?: unknown) => unknown;
	put?: (target: unknown, data: unknown, request: unknown) => unknown;
	post?: (target: unknown, data: unknown, request: unknown) => unknown;
	patch?: (target: unknown, data: unknown, request: unknown) => unknown;
	delete?: (target: unknown, request: unknown, data?: unknown) => unknown;
	search?: (target: unknown, request: unknown) => unknown;
	loadAsInstance?: boolean;
	/**
	 * Component-author opt-in: expose non-verb instance methods as MCP tools.
	 * Each entry maps an instance-method name to an MCP tool descriptor.
	 * RBAC stays as whatever the Resource's method itself enforces; the MCP
	 * layer does not invent new ACLs for these.
	 *
	 * The mapped method is invoked as `method(args, context)`, where `context`
	 * exposes `{ user, profile, sessionId, signal?, progress?, serverRequest? }`
	 * — the per-call MCP context. `progress` (emit `notifications/progress`),
	 * `signal` (aborts on `notifications/cancelled`), and `serverRequest`
	 * (`sampling/createMessage`, `elicitation/create`, `roots/list`) are present
	 * ONLY when the call streams (client sent `_meta.progressToken` +
	 * `Accept: text/event-stream`), so guard them: `context.progress?.(…)`.
	 * Methods that declare only `(args)` keep working — the extra arg is ignored.
	 */
	mcpTools?: ReadonlyArray<{
		name: string;
		method: string;
		description?: string;
		inputSchema?: object;
		annotations?: ToolAnnotationsLike;
	}>;
	/**
	 * Component-author opt-in: publish MCP prompts (#1349 §3.5). Each entry is a
	 * named, optionally-argumented prompt whose `render(args)` returns the
	 * messages delivered by `prompts/get`. Prompt content is author-declared —
	 * Harper has no template primitive to derive it from.
	 */
	mcpPrompts?: ReadonlyArray<{
		name: string;
		title?: string;
		description?: string;
		arguments?: ReadonlyArray<{
			name: string;
			description?: string;
			required?: boolean;
			values?: ReadonlyArray<string>;
		}>;
		render: (args: Record<string, string>) => PromptGetResult | Promise<PromptGetResult>;
	}>;
}

interface ToolAnnotationsLike {
	readOnlyHint?: boolean;
	destructiveHint?: boolean;
	idempotentHint?: boolean;
	openWorldHint?: boolean;
}

type ResourcesRegistry = Map<string, ResourceRegistryEntry>;
type RequestTargetCtor = new () => Record<string, unknown> & {
	conditions?: unknown[];
	operator?: string;
	limit?: number;
	offset?: number;
	select?: string[];
	id?: unknown;
	isCollection?: boolean;
};

// Test seams: avoid Harper's eager graph init in unit tests.
let _resourcesOverride: ResourcesRegistry | undefined;
let _requestTargetCtorOverride: RequestTargetCtor | undefined;
export function _setResourcesForTest(r: ResourcesRegistry | undefined): void {
	_resourcesOverride = r;
}
export function _setRequestTargetForTest(ctor: RequestTargetCtor | undefined): void {
	_requestTargetCtorOverride = ctor;
}

function loadResources(): ResourcesRegistry | undefined {
	if (_resourcesOverride) return _resourcesOverride;
	try {
		return require('../../../resources/Resources').resources as ResourcesRegistry;
	} catch (err) {
		harperLogger.trace(`MCP application tools: Resources registry unavailable (${(err as Error).message})`);
		return undefined;
	}
}

function loadRequestTarget(): RequestTargetCtor | undefined {
	if (_requestTargetCtorOverride) return _requestTargetCtorOverride;
	try {
		return require('../../../resources/RequestTarget').RequestTarget as RequestTargetCtor;
	} catch {
		// Tests that don't use the real RequestTarget can supply a fake.
		return undefined;
	}
}

const DEFAULT_SEARCH_LIMIT = 100;
const MAX_SEARCH_LIMIT = 1000;

function searchLimitFor(_profile: 'application'): number {
	const v = env.get(CONFIG_PARAMS.MCP_APPLICATION_MAXTOOLS); // existing knob; treat as a sane upper bound
	if (typeof v === 'number' && v > 0) return Math.min(v, MAX_SEARCH_LIMIT);
	return DEFAULT_SEARCH_LIMIT;
}

/**
 * Sanitize a Resource path into a valid MCP tool-name segment.
 * MCP tool names must be JSON-encodable identifiers; `/` and `.` are the
 * common offenders. Anything else non-identifier-friendly gets dropped.
 */
function sanitizePath(path: string): string {
	return path.replace(/[/.]/g, '_').replace(/[^a-zA-Z0-9_]/g, '');
}

/**
 * Resolve a unique tool-name suffix for this Resource. Default is the
 * sanitized path; on collision we prefix with the database name; on second
 * collision we add a short hash. The collision recovery is deterministic
 * so two boots produce the same tool names.
 */
function uniqueSuffix(path: string, databaseName: string | undefined, claimed: Set<string>): string {
	const base = sanitizePath(path);
	if (!claimed.has(base)) return base;
	if (databaseName) {
		const dbPrefixed = `${sanitizePath(databaseName)}_${base}`;
		if (!claimed.has(dbPrefixed)) return dbPrefixed;
	}
	// Final fallback: append a short stable hash of the full path.
	const hash = createHash('sha256').update(path).digest('hex').slice(0, 6);
	return `${base}_${hash}`;
}

function getUserTablePermissions(
	user: AuthedUser,
	databaseName: string | undefined,
	tableName: string | undefined
): {
	read?: boolean;
	insert?: boolean;
	update?: boolean;
	delete?: boolean;
	describe?: boolean;
	attribute_permissions?: AttributePermissionEntry[];
} | null {
	if (user?.role?.permission?.super_user === true) {
		return { read: true, insert: true, update: true, delete: true, describe: true };
	}
	if (!databaseName || !tableName) return null;
	const dbPerm = user?.role?.permission?.[databaseName];
	if (!dbPerm || typeof dbPerm !== 'object' || Array.isArray(dbPerm)) return null;
	const tablePerm = (dbPerm as { tables?: Record<string, unknown> }).tables?.[tableName];
	if (!tablePerm || typeof tablePerm !== 'object') return null;
	return tablePerm as ReturnType<typeof getUserTablePermissions>;
}

function buildContext(user: AuthedUser): { user: AuthedUser; authorize: true; checkPermission: object } {
	return {
		user,
		authorize: true,
		checkPermission: user?.role?.permission ?? {},
	};
}

function makeTarget(): InstanceType<RequestTargetCtor> {
	const Ctor = loadRequestTarget();
	if (!Ctor) {
		// Fallback target shape — exposes the writable fields Resource methods
		// read. Real production runs always have RequestTarget available.
		return {} as InstanceType<RequestTargetCtor>;
	}
	return new Ctor();
}

// A write handler's resolved value is a "structured envelope" when it's a
// non-null object (a record or a custom outputSchemas-shaped payload) — it
// should pass through to structuredContent as-is rather than being wrapped in a
// derived `{ id }`/`{ deleted }` shape, which would corrupt custom Resource
// responses and their author-declared output schemas (#1324).
function isStructuredEnvelope(data: unknown): data is object {
	return typeof data === 'object' && data !== null;
}

function wrapResult(data: unknown): ToolResult {
	const text = typeof data === 'string' ? data : JSON.stringify(data ?? null);
	const result: ToolResult = { content: [{ type: 'text', text }] };
	if (data !== null && typeof data === 'object') {
		result.structuredContent = data as object;
	}
	return result;
}

function wrapError(toolName: string, err: unknown): ToolResult {
	const e = err as { message?: string; http_resp_msg?: string };
	const message = e?.http_resp_msg ?? e?.message ?? `${toolName} failed`;
	harperLogger.trace(`MCP ${toolName} threw: ${(err as Error).stack ?? message}`);
	return {
		isError: true,
		content: [
			{
				type: 'text',
				text: JSON.stringify({ kind: 'harper_error', tool: toolName, message }),
			},
		],
	};
}

// ─── Verb-specific handler factories ───────────────────────────────────────

function makeGetHandler(toolName: string, ResourceClass: ResourceClassLike) {
	return async function (args: unknown, context: { user: AuthedUser }): Promise<ToolResult> {
		const a = (args ?? {}) as Record<string, unknown>;
		try {
			const target = makeTarget();
			target.id = a.id;
			if (Array.isArray(a.get_attributes)) target.select = a.get_attributes as string[];
			const data = await ResourceClass.get!(target, buildContext(context.user));
			return wrapResult(data);
		} catch (err) {
			return wrapError(toolName, err);
		}
	};
}

function makeSearchHandler(toolName: string, ResourceClass: ResourceClassLike) {
	return async function (args: unknown, context: { user: AuthedUser }): Promise<ToolResult> {
		const a = (args ?? {}) as Record<string, unknown>;
		try {
			const target = makeTarget();
			if (Array.isArray(a.conditions)) target.conditions = a.conditions as unknown[];
			if (typeof a.operator === 'string') target.operator = a.operator;
			if (Array.isArray(a.get_attributes)) target.select = a.get_attributes as string[];
			const requestedLimit = typeof a.limit === 'number' && a.limit > 0 ? Math.floor(a.limit) : DEFAULT_SEARCH_LIMIT;
			const limit = Math.min(requestedLimit, searchLimitFor('application'));
			// Reuse the shared cursor serialization, but unlike the MCP list-method
			// protocol (which rejects a bad cursor with -32602), this is a tool
			// *argument*: an unusable cursor falls back to offset 0 (best effort)
			// rather than failing the search call.
			const offset = decodeCursor(typeof a.cursor === 'string' ? a.cursor : '') ?? 0;
			// Fetch one extra to know if there's a next page without a second round-trip.
			target.limit = limit + 1;
			target.offset = offset;
			const rawData = await ResourceClass.search!(target, buildContext(context.user));
			const rows: unknown[] = await collectRows(rawData);
			const hasMore = rows.length > limit;
			const page = hasMore ? rows.slice(0, limit) : rows;
			const result: { rows: unknown[]; nextCursor?: string } = { rows: page };
			if (hasMore) result.nextCursor = encodeCursor(offset + limit);
			return wrapResult(result);
		} catch (err) {
			return wrapError(toolName, err);
		}
	};
}

async function collectRows(rawData: unknown): Promise<unknown[]> {
	if (rawData == null) return [];
	if (Array.isArray(rawData)) return rawData;
	// AsyncIterable
	if (typeof (rawData as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function') {
		const out: unknown[] = [];
		for await (const row of rawData as AsyncIterable<unknown>) out.push(row);
		return out;
	}
	// Sync iterable
	if (typeof (rawData as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function') {
		return Array.from(rawData as Iterable<unknown>);
	}
	// Single value
	return [rawData];
}

function makeCreateHandler(toolName: string, ResourceClass: ResourceClassLike) {
	return async function (args: unknown, context: { user: AuthedUser }): Promise<ToolResult> {
		const a = (args ?? {}) as Record<string, unknown>;
		try {
			const target = makeTarget();
			// Mark the target as a collection so `Resource.post` resolves the table
			// (not a single record) and routes to `create()` — without this, the
			// base `post` throws `missingMethod` ("does not have a post method")
			// because a record-scoped resource has no insert path (#1317).
			target.isCollection = true;
			const data = await ResourceClass.post!(target, a, buildContext(context.user));
			// Standard table create resolves to the new record's primary key (a
			// scalar). Wrap it as `{ id }` so the result carries `structuredContent`
			// matching `deriveCreateOutputSchema`; strict SDK clients reject a bare
			// scalar against a declared outputSchema with -32600. A custom Resource
			// that returns a structured record/envelope (typically with a
			// `static outputSchemas.create` override) is passed through unchanged (#1324).
			return wrapResult(isStructuredEnvelope(data) ? data : { id: data });
		} catch (err) {
			return wrapError(toolName, err);
		}
	};
}

function makeUpdateHandler(toolName: string, ResourceClass: ResourceClassLike, verb: 'put' | 'patch') {
	return async function (args: unknown, context: { user: AuthedUser }): Promise<ToolResult> {
		const a = (args ?? {}) as Record<string, unknown>;
		const { id, ...rest } = a;
		try {
			const target = makeTarget();
			target.id = id;
			// Call the verb method *on* ResourceClass so `this` stays bound to the
			// class — detaching it (`const fn = ResourceClass.put`) makes the static
			// Resource dispatcher read `this.directURLMapping` off undefined and throw.
			const ctx = buildContext(context.user);
			const data = await (verb === 'put'
				? ResourceClass.put!(target, rest, ctx)
				: ResourceClass.patch!(target, rest, ctx));
			// Table.put/patch resolve to undefined; surface a `{ ok: true }`
			// acknowledgement so the result has structuredContent matching
			// derive{Update,Patch}OutputSchema. A custom Resource that returns a
			// structured envelope (with a static outputSchemas override) passes
			// through unchanged (#1324).
			return wrapResult(isStructuredEnvelope(data) ? data : { ok: true });
		} catch (err) {
			return wrapError(toolName, err);
		}
	};
}

function makeDeleteHandler(toolName: string, ResourceClass: ResourceClassLike) {
	return async function (args: unknown, context: { user: AuthedUser }): Promise<ToolResult> {
		const a = (args ?? {}) as Record<string, unknown>;
		try {
			const target = makeTarget();
			target.id = a.id;
			const data = await ResourceClass.delete!(target, buildContext(context.user));
			// Table.delete resolves to a boolean; wrap it as `{ deleted }` so the
			// result carries structuredContent matching deriveDeleteOutputSchema. A
			// custom Resource that returns a structured envelope (typically with a
			// `static outputSchemas.delete` override) is passed through unchanged (#1324).
			return wrapResult(isStructuredEnvelope(data) ? data : { deleted: Boolean(data) });
		} catch (err) {
			return wrapError(toolName, err);
		}
	};
}

// ─── Verb-presence introspection ───────────────────────────────────────────

interface VerbAvailability {
	get: boolean;
	search: boolean;
	create: boolean;
	updatePut: boolean;
	updatePatch: boolean;
	delete: boolean;
}

function detectVerbs(ResourceClass: ResourceClassLike): VerbAvailability {
	const p = ResourceClass.prototype as Record<string, unknown> | undefined;
	if (!p || typeof p !== 'object') {
		return { get: false, search: false, create: false, updatePut: false, updatePatch: false, delete: false };
	}
	return {
		get: typeof p.get === 'function',
		search: typeof p.search === 'function',
		// Resource.post defaults to no-op on the base class, but `update()` is the
		// implicit override per the openApi pattern. Treat either as "has create".
		create: typeof p.post === 'function' || typeof p.update === 'function',
		updatePut: typeof p.put === 'function',
		updatePatch: typeof p.patch === 'function',
		delete: typeof p.delete === 'function',
	};
}

// ─── Visibility predicate ──────────────────────────────────────────────────

function makeVisibleTo(
	databaseName: string | undefined,
	tableName: string | undefined,
	mode: 'read' | 'insert' | 'update' | 'delete'
) {
	return function visibleTo(user: AuthedUser): boolean {
		// Super-user sees everything.
		if (user?.role?.permission?.super_user === true) return true;
		// Non-table Resources have no static permission gate — runtime allow*
		// predicates enforce. Conservative default: don't list them for
		// non-super users; they can still call via tools/call if they know
		// the tool name (pass-through is documented behavior).
		if (!databaseName || !tableName) return false;
		const perm = getUserTablePermissions(user, databaseName, tableName);
		if (!perm) return false;
		if (mode === 'read') return perm.read === true || perm.describe === true;
		return perm[mode] === true;
	};
}

// ─── Registration ──────────────────────────────────────────────────────────

interface ResourceContext {
	path: string;
	suffix: string;
	ResourceClass: ResourceClassLike;
	databaseName: string | undefined;
	tableName: string | undefined;
	attributes: HarperAttribute[];
	verbs: VerbAvailability;
}

function shouldEnumerate(entry: ResourceRegistryEntry): boolean {
	const types = entry.exportTypes;
	if (!types) return true; // no per-protocol controls → all enabled
	return types.mcp !== false;
}

/**
 * Per-tool registration; reads attribute_permissions for the registering
 * call's hypothetical "schema-time" user — but since we register at boot
 * (one user-agnostic surface), schemas reflect the *table's* attribute
 * list. The `attribute_permissions` filter on input schemas only applies
 * for users with restricted permissions; at registration time we treat
 * the schema as "all attributes". Runtime enforcement is the real gate.
 */
type Verb = 'get' | 'search' | 'create' | 'update' | 'patch' | 'delete';

/**
 * Per-verb sentence templates. Replaces the prior mechanical
 * `"${verb} on resource '/X'"` output with prose grounded in the actual verb.
 */
const VERB_SENTENCES: Record<Verb, (ctx: { tableName?: string; primaryKey?: string; path: string }) => string> = {
	get: ({ tableName, primaryKey, path }) => `Fetches a single ${tableName ?? path} record by ${primaryKey ?? 'id'}.`,
	search: ({ tableName, path }) => `Searches ${tableName ?? path} records by attribute conditions.`,
	create: ({ tableName, path }) => `Creates a new ${tableName ?? path} record.`,
	update: ({ tableName, primaryKey, path }) =>
		`Replaces a ${tableName ?? path} record by ${primaryKey ?? 'id'} (PUT semantics).`,
	patch: ({ tableName, primaryKey, path }) =>
		`Partially updates a ${tableName ?? path} record by ${primaryKey ?? 'id'}.`,
	delete: ({ tableName, primaryKey, path }) => `Deletes a ${tableName ?? path} record by ${primaryKey ?? 'id'}.`,
};

interface VerbDescriptionContext {
	tableDoc?: string;
	tableName?: string;
	primaryKey?: string;
	path: string;
}

/**
 * Map each verb to the Resource RBAC method that gates it at runtime.
 * Harper exposes four predicates — allowRead / allowCreate / allowUpdate /
 * allowDelete — so multiple verbs share the same method (get + search both
 * gate on allowRead; update + patch both gate on allowUpdate).
 */
const VERB_TO_RBAC_METHOD: Record<Verb, string> = {
	get: 'allowRead',
	search: 'allowRead',
	create: 'allowCreate',
	update: 'allowUpdate',
	patch: 'allowUpdate',
	delete: 'allowDelete',
};

/**
 * Compose the per-verb tool description. When the Resource carries a
 * `static description` (or a `Table.description` from the GraphQL parser),
 * prefix it; then the verb-specific sentence; then the runtime-RBAC note.
 */
function verbDescription(verb: Verb, ctx: VerbDescriptionContext): string {
	const prefix = ctx.tableDoc ? `${ctx.tableDoc}\n\n` : '';
	const sentence = VERB_SENTENCES[verb](ctx);
	const allowMethod = VERB_TO_RBAC_METHOD[verb];
	return `${prefix}${sentence} Runtime RBAC (${allowMethod}) enforces per-record access at call time.`;
}

/**
 * Merge per-verb annotation overrides from `ResourceClass.mcp.annotations[verb]`
 * over the defaults. Used for narrow MCP-only knobs that don't fit JSON Schema
 * (e.g. `idempotentHint` overrides per verb).
 */
function mergeAnnotations(
	verb: Verb,
	defaults: ToolAnnotationsLike,
	ResourceClass: ResourceClassLike
): ToolAnnotationsLike {
	const override = ResourceClass.mcp?.annotations?.[verb];
	return override ? { ...defaults, ...override } : defaults;
}

/**
 * Operations a Resource may opt into via `static mcp.annotations.<verb>.idempotentHint`.
 * Default-empty: under MCP semantics `idempotentHint: true` means same observable
 * outcome on repeat call; we under-annotate before mis-annotate. `update_*` (PUT
 * semantics) is the only built-in default; `patch_*`/`delete_*` annotations are
 * deferred until repeat-call behavior is verified end-to-end.
 */
function registerVerbTools(ctx: ResourceContext): number {
	let count = 0;
	const { suffix, ResourceClass, attributes, verbs, tableName, databaseName, path } = ctx;
	const tableDoc = ResourceClass.description;
	const primaryKey = ResourceClass.primaryKey;
	const ctxForVerb: VerbDescriptionContext = { tableDoc, tableName, primaryKey, path };

	const overrideOutput = (verb: Verb): object | undefined => ResourceClass.outputSchemas?.[verb];

	if (verbs.get) {
		const name = `get_${suffix}`;
		addTool({
			name,
			description: verbDescription('get', ctxForVerb),
			inputSchema: deriveGetSchema(attributes, undefined),
			outputSchema: overrideOutput('get') ?? deriveGetOutputSchema(attributes, undefined),
			profile: 'application',
			annotations: mergeAnnotations('get', { readOnlyHint: true }, ResourceClass),
			visibleTo: makeVisibleTo(databaseName, tableName, 'read'),
			handler: makeGetHandler(name, ResourceClass),
		});
		count++;
	}
	if (verbs.search) {
		const name = `search_${suffix}`;
		// search_* deliberately omits outputSchema — envelope shape (records vs
		// data, cursor vs nextCursor) is tracked in the sibling envelope issue.
		addTool({
			name,
			description: verbDescription('search', ctxForVerb),
			inputSchema: deriveSearchSchema(attributes, undefined),
			profile: 'application',
			annotations: mergeAnnotations('search', { readOnlyHint: true }, ResourceClass),
			visibleTo: makeVisibleTo(databaseName, tableName, 'read'),
			handler: makeSearchHandler(name, ResourceClass),
		});
		count++;
	}
	if (verbs.create) {
		const name = `create_${suffix}`;
		addTool({
			name,
			description: verbDescription('create', ctxForVerb),
			inputSchema: deriveCreateSchema(attributes, undefined),
			outputSchema: overrideOutput('create') ?? deriveCreateOutputSchema(attributes, undefined),
			profile: 'application',
			annotations: mergeAnnotations('create', {}, ResourceClass),
			visibleTo: makeVisibleTo(databaseName, tableName, 'insert'),
			handler: makeCreateHandler(name, ResourceClass),
		});
		count++;
	}
	if (verbs.updatePut) {
		const name = `update_${suffix}`;
		addTool({
			name,
			description: verbDescription('update', ctxForVerb),
			inputSchema: deriveUpdateSchema(attributes, undefined),
			outputSchema: overrideOutput('update') ?? deriveUpdateOutputSchema(attributes, undefined),
			profile: 'application',
			// PUT semantics: replacing with the same payload yields the same state,
			// so the observable outcome on repeat call is identical.
			annotations: mergeAnnotations('update', { idempotentHint: true }, ResourceClass),
			visibleTo: makeVisibleTo(databaseName, tableName, 'update'),
			handler: makeUpdateHandler(name, ResourceClass, 'put'),
		});
		count++;
	} else if (verbs.updatePatch) {
		const name = `patch_${suffix}`;
		addTool({
			name,
			description: verbDescription('patch', ctxForVerb),
			inputSchema: deriveUpdateSchema(attributes, undefined),
			outputSchema: overrideOutput('patch') ?? derivePatchOutputSchema(attributes, undefined),
			profile: 'application',
			// patch_* idempotency depends on partial-update semantics; default
			// omitted, opt-in via static mcp.annotations.patch.idempotentHint.
			annotations: mergeAnnotations('patch', {}, ResourceClass),
			visibleTo: makeVisibleTo(databaseName, tableName, 'update'),
			handler: makeUpdateHandler(name, ResourceClass, 'patch'),
		});
		count++;
	}
	if (verbs.delete) {
		const name = `delete_${suffix}`;
		// `Table.delete` returns Promise<boolean>; `makeDeleteHandler` wraps it as
		// `{ deleted }` so the result carries structuredContent matching the
		// `{ deleted: boolean }` outputSchema. Authors can override the shape via
		// `static outputSchemas.delete`.
		addTool({
			name,
			description: verbDescription('delete', ctxForVerb),
			inputSchema: deriveDeleteSchema(attributes, undefined),
			outputSchema: overrideOutput('delete') ?? deriveDeleteOutputSchema(attributes),
			profile: 'application',
			// delete_* idempotency depends on delete-of-deleted behavior; default
			// omits idempotentHint until verified end-to-end.
			annotations: mergeAnnotations('delete', { destructiveHint: true }, ResourceClass),
			visibleTo: makeVisibleTo(databaseName, tableName, 'delete'),
			handler: makeDeleteHandler(name, ResourceClass),
		});
		count++;
	}
	return count;
}

/**
 * #622 — Component-author opt-in. Walk `ResourceClass.mcpTools` and register
 * each entry as a standalone MCP tool that invokes the named instance method.
 *
 * Each invocation constructs an instance with `(undefined, context)` and
 * calls `instance[method](args)`. This mirrors what a custom user-defined
 * Harper Resource expects when its methods are reached outside of a REST
 * request — they receive arguments and rely on internal Harper calls to
 * enforce any RBAC they need.
 *
 * No `visibleTo` filter beyond "is the user authenticated" — per the design,
 * the Resource is responsible for its own ACLs. An LLM that calls a tool
 * it shouldn't gets the Resource's natural error back as `isError: true`.
 */
// Dedup keys for warn-once telemetry on missing description / inputSchema.
// Keyed by `${path}:${name}`. Survives across `registerApplicationTools()`
// re-invocations so re-registering the same Resource doesn't re-spam the log.
// Test seam below resets these.
const _warnedMissingDesc = new Set<string>();
const _warnedMissingInput = new Set<string>();

export function _resetCustomToolWarningsForTest(): void {
	_warnedMissingDesc.clear();
	_warnedMissingInput.clear();
}

function registerCustomMcpTools(ResourceClass: ResourceClassLike, path: string): number {
	const tools = ResourceClass.mcpTools;
	if (!Array.isArray(tools) || tools.length === 0) return 0;
	let count = 0;
	for (const def of tools) {
		if (!def?.name || !def?.method) {
			harperLogger.warn(
				`MCP application profile: skipping invalid mcpTools entry on '${path}' (missing name or method): ${JSON.stringify(def)}`
			);
			continue;
		}
		const methodName = def.method;
		if (typeof (ResourceClass.prototype as Record<string, unknown>)?.[methodName] !== 'function') {
			harperLogger.warn(
				`MCP application profile: '${path}' declares mcpTool '${def.name}' for method '${methodName}', but no such instance method exists on the prototype`
			);
			continue;
		}
		// Nudge component authors toward shipping description + inputSchema. Both
		// materially affect LLM tool selection: description tells the model WHICH
		// tool to pick; inputSchema tells it HOW to fill the arguments. Falling
		// back to a generic description + `additionalProperties: true` makes the
		// tool callable but hard to invoke correctly.
		const dedupKey = `${path}:${def.name}`;
		let description = def.description;
		if (!description) {
			if (!_warnedMissingDesc.has(dedupKey)) {
				_warnedMissingDesc.add(dedupKey);
				harperLogger.warn(
					`MCP application: Resource '${path}' exposes mcpTool '${def.name}' without a description. ` +
						`LLM tool selection degrades without one; add { description: '...' } to the mcpTools entry.`
				);
			}
			description = `Custom MCP tool exposed by Resource '${path}' (method '${methodName}'). RBAC is enforced by the Resource itself.`;
		}
		let inputSchema = def.inputSchema;
		if (!inputSchema) {
			if (!_warnedMissingInput.has(dedupKey)) {
				_warnedMissingInput.add(dedupKey);
				harperLogger.warn(
					`MCP application: Resource '${path}' exposes mcpTool '${def.name}' without an inputSchema. ` +
						`LLM cannot construct typed arguments; add { inputSchema: { type: 'object', properties: {...}, required: [...] } } to the mcpTools entry.`
				);
			}
			inputSchema = { type: 'object', additionalProperties: true };
		}
		addTool({
			name: def.name,
			description,
			inputSchema,
			profile: 'application',
			...(def.annotations ? { annotations: def.annotations } : {}),
			// Per the design: custom-tool RBAC is delegated to the Resource. No
			// visibleTo filter beyond "the user is authenticated" — the runtime
			// rejects unauthorized calls naturally.
			visibleTo: () => true,
			handler: makeCustomMethodHandler(def.name, ResourceClass, methodName),
		});
		count++;
	}
	return count;
}

/**
 * #1349 §3.5 — Component-author opt-in. Walk `ResourceClass.mcpPrompts` and
 * register each as an MCP prompt. Prompt content is author-declared via the
 * entry's `render(args)`; the registry adapts it to the `(args, context)`
 * signature. Invalid entries (missing name or render) are skipped with a warn.
 */
function registerCustomMcpPrompts(ResourceClass: ResourceClassLike, path: string): number {
	const prompts = ResourceClass.mcpPrompts;
	if (!Array.isArray(prompts) || prompts.length === 0) return 0;
	let count = 0;
	for (const def of prompts) {
		if (!def?.name || typeof def.render !== 'function') {
			harperLogger.warn(
				`MCP application profile: skipping invalid mcpPrompts entry on '${path}' (needs name + render): ${JSON.stringify(def)}`
			);
			continue;
		}
		const prompt: PromptDef = {
			name: def.name,
			profile: 'application',
			...(def.title ? { title: def.title } : {}),
			...(def.description ? { description: def.description } : {}),
			...(def.arguments ? { arguments: def.arguments.map((a) => ({ ...a })) } : {}),
			render: (args) => def.render(args),
		};
		addPrompt(prompt);
		count++;
	}
	return count;
}

function makeCustomMethodHandler(toolName: string, ResourceClass: ResourceClassLike, methodName: string) {
	return async function (args: unknown, context: ToolCallContext): Promise<ToolResult> {
		try {
			// Instantiate per call. Component authors define custom methods on
			// the instance side; the Harper context carries the user so any
			// internal Resource calls the method makes pick up RBAC naturally.
			const Ctor = ResourceClass as unknown as new (id: unknown, ctx: unknown) => Record<string, unknown>;
			const instance = new Ctor(undefined, buildContext(context.user));
			const method = instance[methodName] as ((a: unknown, ctx: unknown) => unknown) | undefined;
			if (typeof method !== 'function') {
				throw new Error(`method '${methodName}' is not a function on the constructed Resource`);
			}
			// Forward the per-call MCP context as a curated second arg so author tools can
			// emit progress, observe cancellation, and issue server→client requests
			// (#1349 §3.3/§3.4/§3.7). progress/signal/serverRequest are only populated on a
			// streaming call, so authors must guard them (`context.progress?.(…)`). A method
			// that only declares `(args)` ignores the extra positional arg (back-compat).
			const mcpContext: ToolCallContext = {
				user: context.user,
				profile: context.profile,
				sessionId: context.sessionId,
				signal: context.signal,
				progress: context.progress,
				serverRequest: context.serverRequest,
			};
			const data = await method.call(instance, args ?? {}, mcpContext);
			return wrapResult(data ?? { ok: true });
		} catch (err) {
			return wrapError(toolName, err);
		}
	};
}

/**
 * Idempotent registration — walk the Resources Map, register verb tools
 * for each entry that passes the exportTypes + verb-presence filters.
 * Re-invocation overwrites prior tool entries (Map.set semantics).
 */
// True once the application profile has registered its tools at least once.
// Gates `refreshApplicationTools` so schema-change rebuilds only happen when the
// application profile is actually enabled.
let applicationToolsRegistered = false;

/**
 * Rebuild the application tool registry from the CURRENT schema graph. Tools are
 * derived from exported `@table` Resources, which may register AFTER the MCP
 * component loads (component load order isn't guaranteed). Re-running on every
 * schema change keeps `tools/list` in sync — without it, a table created after
 * boot would never surface a `create_`/`get_` tool (#1317). No-op until the
 * application profile has been registered once.
 */
export function refreshApplicationTools(): void {
	if (applicationToolsRegistered) registerApplicationTools();
}

/** Test seam: reset the registered flag so suites can re-exercise registration. */
export function _resetApplicationToolsRegisteredForTest(): void {
	applicationToolsRegistered = false;
}

export function registerApplicationTools(): void {
	const resources = loadResources();
	if (!resources) {
		harperLogger.warn('MCP application profile: Resources registry not available; no tools registered');
		return;
	}
	applicationToolsRegistered = true;
	// Atomic idempotent rebuild: drop any application tools from a prior pass so a
	// removed/renamed table doesn't leave a stale tool behind. Snapshot the prior
	// set first so a throw mid-loop (e.g. a malformed custom tool on a @table)
	// restores it rather than leaving `tools/list` empty until the next schema
	// change. Registration is synchronous, so no reader observes the gap.
	const previousTools = snapshotProfileTools('application');
	const previousPrompts = snapshotProfilePrompts('application');
	const previousPromptNames = previousPrompts
		.map((p) => p.name)
		.sort()
		.join(' ');
	clearProfileTools('application');
	clearProfilePrompts('application');
	try {
		buildApplicationTools(resources);
	} catch (err) {
		clearProfileTools('application');
		clearProfilePrompts('application');
		for (const def of previousTools) addTool(def);
		for (const def of previousPrompts) addPrompt(def);
		throw err;
	}
	// Tell connected sessions if the prompt set actually changed (added/removed),
	// fulfilling the advertised prompts.listChanged capability without no-op spam.
	const currentPromptNames = snapshotProfilePrompts('application')
		.map((p) => p.name)
		.sort()
		.join(' ');
	if (currentPromptNames !== previousPromptNames) {
		notifyPromptsListChanged('application');
	}
}

function buildApplicationTools(resources: ResourcesRegistry): void {
	const claimedSuffixes = new Set<string>();
	let toolsRegistered = 0;
	let resourcesConsidered = 0;
	for (const [path, entry] of resources) {
		resourcesConsidered++;
		if (!shouldEnumerate(entry)) continue;
		const ResourceClass = entry.Resource;
		// @hidden type-level: suppress the Resource from MCP tool listing entirely.
		// Data remains accessible via direct query/RBAC; only descriptive surfaces drop it.
		if (ResourceClass?.hidden === true) {
			harperLogger.trace(`MCP application: '/${path}' suppressed from tool listing (@hidden)`);
			continue;
		}
		const verbs = detectVerbs(ResourceClass);
		const hasVerbs = verbs.get || verbs.search || verbs.create || verbs.updatePut || verbs.updatePatch || verbs.delete;
		const hasCustomTools = Array.isArray(ResourceClass?.mcpTools) && ResourceClass.mcpTools.length > 0;
		const hasCustomPrompts = Array.isArray(ResourceClass?.mcpPrompts) && ResourceClass.mcpPrompts.length > 0;
		if (!hasVerbs && !hasCustomTools && !hasCustomPrompts) continue;
		const databaseName = ResourceClass?.databaseName;
		const tableName = ResourceClass?.tableName;
		const suffix = uniqueSuffix(path, databaseName, claimedSuffixes);
		claimedSuffixes.add(suffix);
		const attributes = (ResourceClass?.attributes ?? []) as HarperAttribute[];
		if (hasVerbs) {
			toolsRegistered += registerVerbTools({
				path,
				suffix,
				ResourceClass,
				databaseName,
				tableName,
				attributes,
				verbs,
			});
		}
		toolsRegistered += registerCustomMcpTools(ResourceClass, path);
		registerCustomMcpPrompts(ResourceClass, path);
	}
	harperLogger.info(
		`MCP application profile: considered ${resourcesConsidered} resource(s), registered ${toolsRegistered} tool(s)`
	);
}
