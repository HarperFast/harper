/**
 * MCP resources capability — implements `resources/list`, `resources/read`,
 * and `resources/templates/list` per MCP §server/resources (rev 2025-06-18).
 *
 * Two URI schemes:
 *   - `https://<host>[:<port>]/<path>` for app-exported Resources. The same
 *     URL the REST API uses. Resolved **in-process** via
 *     `Resources.getMatch(path)` — never makes an outbound HTTP request.
 *   - `harper://...` for synthetic / metadata resources that don't have a
 *     real HTTP endpoint:
 *       harper://about              — server version, profile, capabilities
 *       harper://schema/{database}/{table} — Table.attributes (RBAC-filtered at read time)
 *       harper://openapi             — OpenAPI 3.0.3 document
 *       harper://operations          — ops-profile only; canonical ops list
 *
 * Unlike the tool registry, resources aren't *registered* — they're
 * *discovered* at request time. Apps register their `Resource` classes
 * through Harper's normal flow; this module enumerates the global
 * `resources` registry and adds the synthetic URIs that v1 exposes.
 *
 * Security model: list time only checks REST-method presence on the
 * Resource class. Resource access is determined programmatically (per-
 * record `allow{Read,Create,Update,Delete}` predicates), so list-time
 * RBAC walks would be both incomplete and misleading. Every read goes
 * through the corresponding read path's permission enforcement.
 *
 * For `harper://schema/{database}/{table}`, read enforcement uses the
 * static `user.role.permission[db].tables[table].{read,describe}` walk —
 * that's the same path Harper's describe permission uses
 * (`dataLayer/schemaDescribe.ts:29-49`).
 */
import * as env from '../../utility/environment/environmentManager.ts';
import { CONFIG_PARAMS, OPERATIONS_ENUM } from '../../utility/hdbTerms.ts';
import harperLogger from '../../utility/logging/harper_logger.ts';
import { SERVER_CAPABILITIES, SERVER_INFO, SUPPORTED_PROTOCOL_VERSIONS } from './lifecycle.ts';
import { encodeCursor } from './pagination.ts';
import type { McpProfile } from './transport.ts';

// Harper's resource graph (Resources, generateJsonApi, Server) initializes
// eagerly when imported at module-load. Unit tests that don't boot Harper
// would fail to load this module. Lazy-resolve via require() inside the
// getters below; test seams below let unit tests bypass the real bindings.
type ResourcesType = Map<
	string,
	{ Resource: unknown; path: string; exportTypes: unknown; hasSubPaths: boolean; relativeURL: string }
> & {
	getMatch?: (path: string, exportType?: string) => { Resource: unknown; path: string } | undefined;
};
type OpenApiGenerator = (resources: ResourcesType, serverHttpURL: string) => unknown;

export interface AuthedUser {
	username?: string;
	role?: {
		role?: string;
		permission?: {
			super_user?: boolean;
			structure_user?: boolean;
			operations?: string[];
			[database: string]:
				| boolean
				| string[]
				| undefined
				| {
						describe?: boolean;
						read?: boolean;
						tables?: {
							[table: string]:
								| undefined
								| {
										read?: boolean;
										describe?: boolean;
										attribute_permissions?: unknown;
								  };
						};
				  };
		};
	};
}

/** Public shape returned by `resources/list`. */
export interface ResourceDescriptor {
	uri: string;
	name: string;
	description?: string;
	mimeType?: string;
}

/** Public shape inside `resources/read` `contents[]`. */
export interface ResourceContent {
	uri: string;
	mimeType?: string;
	text?: string;
	blob?: string;
}

/** Public shape returned by `resources/templates/list`. */
export interface ResourceTemplate {
	uriTemplate: string;
	name: string;
	description?: string;
	mimeType?: string;
}

const HARPER_SCHEME = 'harper:';
const HTTPS_SCHEME = 'https:';
const HTTP_SCHEME = 'http:';

const DEFAULT_LIMIT = 200;

// Test seams. Injecting these lets us unit-test without standing up a full
// Resources registry or running openapi generation.
let _resourcesOverride: ResourcesType | undefined;
let _openApiOverride: OpenApiGenerator | undefined;
let _httpUrlPrefixOverride: string | undefined;

/** Test seam: replace the Resources registry the module reads. */
export function _setResourcesForTest(r: ResourcesType | undefined): void {
	_resourcesOverride = r;
}

/** Test seam: replace the openapi generator. */
export function _setOpenApiGeneratorForTest(fn: OpenApiGenerator | undefined): void {
	_openApiOverride = fn;
}

/** Test seam: replace the inferred application HTTP URL prefix. */
export function _setHttpUrlPrefixForTest(prefix: string | undefined): void {
	_httpUrlPrefixOverride = prefix;
}

/**
 * A live audit-log subscription started by `resource.subscribe`, viewed as an
 * async-iterable with an `.end()` to stop it (the shape MQTT's durable session
 * consumes). Test seam below injects a fake so unit tests don't need the real
 * audit log.
 */
type ResourceChangeStream = AsyncIterable<{ acknowledge?: () => void }> & { end?: () => void };
let _subscribeImplOverride: ((path: string, user: AuthedUser) => Promise<ResourceChangeStream | null>) | undefined;

/** Test seam: replace the real `resource.subscribe` resolution with a fake stream. */
export function _setSubscribeImplForTest(
	fn: ((path: string, user: AuthedUser) => Promise<ResourceChangeStream | null>) | undefined
): void {
	_subscribeImplOverride = fn;
}

function getResources(): ResourcesType {
	if (_resourcesOverride) return _resourcesOverride;
	// Lazy import — see file-top comment on Harper graph initialization.
	const { resources } = require('../../resources/Resources');
	return resources as ResourcesType;
}

function getOpenApiGenerator(): OpenApiGenerator {
	if (_openApiOverride) return _openApiOverride;
	const { generateJsonApi } = require('../../resources/openApi');
	return generateJsonApi as OpenApiGenerator;
}

// ─── Public entry points ────────────────────────────────────────────────

export interface ListResourcesArgs {
	user: AuthedUser;
	profile: McpProfile;
	/**
	 * Decoded pagination offset, or `undefined` for a fresh (first-page) call.
	 * The transport decodes the opaque cursor and rejects invalid cursors with
	 * `-32602` before calling us (see `decodeCursor` in pagination.ts).
	 */
	offset?: number;
	limit?: number;
}

export interface ListResourcesResult {
	resources: ResourceDescriptor[];
	nextCursor?: string;
}

export function listResources(args: ListResourcesArgs): ListResourcesResult {
	const all = enumerate(args.profile);
	const offset = args.offset ?? 0;
	const limit = args.limit && args.limit > 0 ? args.limit : DEFAULT_LIMIT;
	const slice = all.slice(offset, offset + limit);
	const next = offset + slice.length;
	return {
		resources: slice,
		nextCursor: next < all.length ? encodeCursor(next) : undefined,
	};
}

export interface ListResourceTemplatesResult {
	resourceTemplates: ResourceTemplate[];
	nextCursor?: string;
}

/**
 * List resource templates for a profile, paginated by opaque cursor offset like
 * `listResources`/`listTools`. The 2025-06-18 spec says `resources/templates/list`
 * supports pagination; the set is tiny today, but paginating keeps the shape
 * spec-conformant and consistent with the other list methods. `offset` is the
 * decoded cursor (the transport rejects malformed cursors with `-32602` first).
 */
export function listResourceTemplates(
	profile: McpProfile,
	offset?: number,
	limit?: number
): ListResourceTemplatesResult {
	const all: ResourceTemplate[] = [];
	if (profile === 'application') {
		all.push({
			uriTemplate: 'harper://schema/{database}/{table}',
			name: 'Table schema',
			description: 'Attribute definitions for a Harper table, RBAC-filtered by attribute_permissions',
			mimeType: 'application/json',
		});
		const serverHttpURL = guessAppHttpUrlPrefix();
		if (serverHttpURL) {
			all.push({
				uriTemplate: `${serverHttpURL}/{resourcePath}`,
				name: 'Application resource',
				description:
					'A Resource exported on the HTTP port. The URI is the canonical REST URL; resolution is in-process.',
				mimeType: 'application/json',
			});
		}
	}
	const start = offset ?? 0;
	const max = limit && limit > 0 ? limit : DEFAULT_LIMIT;
	const slice = all.slice(start, start + max);
	const next = start + slice.length;
	return {
		resourceTemplates: slice,
		nextCursor: next < all.length ? encodeCursor(next) : undefined,
	};
}

/** Result shape for `completion/complete` (#1349 §3.2). */
export interface CompletionResult {
	values: string[];
	total: number;
	hasMore: boolean;
}

const COMPLETION_CAP = 100;

export interface CompleteResourceArgs {
	/** The template variable being completed (e.g. `database`, `table`, `resourcePath`). */
	argument: { name: string; value: string };
	/** Previously-resolved sibling variables (e.g. `database` when completing `table`). */
	context?: { arguments?: Record<string, string> };
	user: AuthedUser;
	/** Caller's profile — resource templates exist only on `application`. */
	profile: McpProfile;
}

/**
 * Complete a resource-template variable (`ref/resource`) from schema introspection,
 * RBAC-filtered. Candidates are derived from the same Resource registry the rest of
 * the MCP resource surface uses; prefix-matched (case-insensitive) against the
 * partial value and capped at 100 per the MCP completion spec.
 *
 * Gated to the templates `resources/templates/list` actually advertises: resource
 * templates exist only on the `application` profile, and `{resourcePath}` only when
 * an application HTTP URL is inferable. Otherwise return nothing rather than leak
 * route/schema names a profile can't read.
 */
export function completeResourceArgument(args: CompleteResourceArgs): CompletionResult {
	const { argument, context, user, profile } = args;
	if (profile !== 'application') return capCompletion([]);
	const partial = (argument.value ?? '').toLowerCase();
	let candidates: string[] = [];
	if (argument.name === 'database') {
		const dbs = new Set<string>();
		for (const { db, table } of enumerateTableBackedResources()) {
			if (canSeeTable(user, db, table)) dbs.add(db);
		}
		candidates = [...dbs];
	} else if (argument.name === 'table') {
		const db = context?.arguments?.database;
		const tables = new Set<string>();
		for (const e of enumerateTableBackedResources()) {
			if (db && e.db !== db) continue;
			if (canSeeTable(user, e.db, e.table)) tables.add(e.table);
		}
		candidates = [...tables];
	} else if (argument.name === 'resourcePath') {
		// Only advertised when an app HTTP URL prefix exists (the `{resourcePath}`
		// template). No prefix → no such template → no completions.
		if (guessAppHttpUrlPrefix()) candidates = enumerateMcpResourcePaths();
	}
	const filtered = candidates.filter((c) => c.toLowerCase().startsWith(partial)).sort();
	return capCompletion(filtered);
}

/** Cap a candidate list to the MCP completion limit, reporting total + hasMore. */
export function capCompletion(values: string[]): CompletionResult {
	const total = values.length;
	const capped = values.slice(0, COMPLETION_CAP);
	return { values: capped, total, hasMore: total > capped.length };
}

/** A table is offerable if the user may read or describe it. */
function canSeeTable(user: AuthedUser, db: string, table: string): boolean {
	const perm = userTablePermissions(user, db, table);
	return !!perm && (perm.read === true || perm.describe === true);
}

/** MCP-exposed application resource paths (the `{resourcePath}` candidates). */
function enumerateMcpResourcePaths(): string[] {
	const out: string[] = [];
	for (const [path, entry] of getResources()) {
		if (!isMcpExposed(entry)) continue;
		const ResourceClass = entry.Resource as { prototype?: unknown; hidden?: boolean } | undefined;
		if (ResourceClass?.hidden === true) continue;
		if (!hasRestVerbs(ResourceClass?.prototype)) continue;
		out.push(path);
	}
	return out;
}

export interface ResourceSubscription {
	/** Stop the subscription and release the underlying audit-log iterator. */
	stop: () => void;
}

/**
 * Subscribe to changes on a row-backed resource URI (#1349 §3.6), invoking
 * `onUpdate` once per committed change. Returns a handle to stop it, or `null`
 * if the URI is not subscribable — only application HTTP(S) resource URLs backed
 * by a Resource with `subscribe` qualify; synthetic `harper://*` URIs have no
 * row-change source and are list_changed-only.
 *
 * Mirrors the MQTT durable-subscription consumer (`server/DurableSubscriptionsSession.ts`):
 * `resource.subscribe` (a transactional static) returns an async-iterable with an
 * `.end()`; we iterate it on the worker holding the SSE stream, so the audit-log
 * `'committed'` broadcast delivers changes locally (cross-worker via the shared log).
 */
export async function subscribeToResource(
	uri: string,
	user: AuthedUser,
	onUpdate: () => void
): Promise<ResourceSubscription | null> {
	let parsed: URL;
	try {
		parsed = new URL(uri);
	} catch {
		return null;
	}
	if (parsed.protocol !== HTTPS_SCHEME && parsed.protocol !== HTTP_SCHEME) return null;
	const path = parsed.pathname.replace(/^\/+/, '');

	let stream: ResourceChangeStream | null;
	if (_subscribeImplOverride) {
		stream = await _subscribeImplOverride(path, user);
	} else {
		const resourcesRegistry = getResources();
		const entry = resourcesRegistry.getMatch(path, 'mcp') as
			| { Resource: { subscribe?: (request: unknown, context: unknown) => unknown }; relativeURL?: string }
			| undefined;
		const ResourceClass = entry?.Resource;
		if (!entry || typeof ResourceClass?.subscribe !== 'function') return null;
		// `getMatch` matched the Resource and put the remaining path (the record key,
		// if any) on `entry.relativeURL`. The table subscribe targets `request.id`,
		// so set it explicitly: a record URI watches that record; a collection URI
		// (empty remainder — what `resources/list` advertises) watches the whole
		// table. `new RequestTarget(path)` parses an id out of the path on its own,
		// so we must override both cases (else a collection URI watches a phantom
		// record named after the resource and receives nothing).
		const recordId = (entry.relativeURL ?? '').replace(/^\/+/, '');
		// Lazy-require the server-layer machinery (see file-top note on eager init).
		const { transaction } = require('../../resources/transaction');
		const { RequestTarget } = require('../../resources/RequestTarget');
		const request = new RequestTarget(path);
		// `omitCurrent`: only deliver changes after subscribe, not a retained snapshot —
		// the MCP notification just says "this resource changed; re-read it".
		Object.assign(request, {
			id: recordId || undefined,
			isCollection: !recordId,
			omitCurrent: true,
			checkPermission: user?.role?.permission ?? {},
		});
		const context = { user, authorize: true, request };
		const result = await transaction(context, async () => ResourceClass.subscribe!(request, context));
		stream =
			result && typeof (result as ResourceChangeStream)[Symbol.asyncIterator] === 'function'
				? (result as ResourceChangeStream)
				: null;
	}
	if (!stream) return null;

	let stopped = false;
	void (async () => {
		try {
			for await (const update of stream) {
				if (stopped) break;
				update?.acknowledge?.();
				onUpdate();
			}
		} catch (err) {
			harperLogger.trace(`MCP subscription ${uri} ended: ${(err as Error).message}`);
		}
	})();

	return {
		stop: () => {
			stopped = true;
			try {
				stream.end?.();
			} catch (err) {
				harperLogger.trace(`MCP subscription ${uri} stop: ${(err as Error).message}`);
			}
		},
	};
}

export interface ReadResourceArgs {
	uri: string;
	user: AuthedUser;
	profile: McpProfile;
}

export interface ReadResourceOk {
	ok: true;
	contents: ResourceContent[];
}

export interface ReadResourceFail {
	ok: false;
	reason: string;
}

export async function readResource(args: ReadResourceArgs): Promise<ReadResourceOk | ReadResourceFail> {
	const { uri, user, profile } = args;
	let parsed: URL;
	try {
		parsed = new URL(uri);
	} catch {
		return { ok: false, reason: `invalid uri: ${uri}` };
	}

	if (parsed.protocol === HARPER_SCHEME) {
		return readHarperUri(parsed, user, profile);
	}
	if (parsed.protocol === HTTPS_SCHEME || parsed.protocol === HTTP_SCHEME) {
		if (profile !== 'application') {
			return { ok: false, reason: 'https:// resources are only available on the application profile' };
		}
		return readAppResource(parsed);
	}
	return { ok: false, reason: `unsupported uri scheme: ${parsed.protocol}` };
}

// ─── Enumeration ───────────────────────────────────────────────────────

function enumerate(profile: McpProfile): ResourceDescriptor[] {
	const out: ResourceDescriptor[] = [];

	// `harper://about` is available on both profiles.
	out.push({
		uri: 'harper://about',
		name: 'Server metadata',
		description: 'Harper server version, profile, and the MCP protocol versions advertised by this server.',
		mimeType: 'application/json',
	});

	if (profile === 'operations') {
		out.push({
			uri: 'harper://operations',
			name: 'Operations catalog',
			description: 'User-filtered list of Harper operations with their JSON Schemas.',
			mimeType: 'application/json',
		});
	}

	if (profile === 'application') {
		out.push({
			uri: 'harper://openapi',
			name: 'OpenAPI document',
			description: "OpenAPI 3.0.3 spec for the application's HTTP REST surface.",
			mimeType: 'application/json',
		});

		// harper://schema/{database}/{table} — one entry per table backing a Resource.
		// No list-time RBAC filter; readTableSchema enforces describe/read perms.
		for (const { db, table, description: tableDoc } of enumerateTableBackedResources()) {
			const base = `Attribute definitions for ${db}.${table}, filtered at read time by your role's attribute_permissions.`;
			out.push({
				uri: `harper://schema/${db}/${table}`,
				name: `${db}.${table} schema`,
				description: tableDoc ? `${tableDoc} ${base}` : base,
				mimeType: 'application/json',
			});
		}

		// https://... — one per exported Resource that has class-level REST methods.
		// Per-record access is decided by each Resource's `allow{Read,...}` predicate
		// at read time, so the list filter only checks method presence.
		for (const entry of enumerateAppHttpResources()) out.push(entry);
	}

	out.sort((a, b) => (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0));
	return out;
}

function enumerateTableBackedResources(): Array<{ db: string; table: string; description?: string }> {
	const seen = new Set<string>();
	const result: Array<{ db: string; table: string; description?: string }> = [];
	for (const entry of getResources().values()) {
		if (!isMcpExposed(entry)) continue;
		const ResourceClass = entry.Resource as {
			databaseName?: string;
			tableName?: string;
			description?: string;
			hidden?: boolean;
		};
		// @hidden suppresses the Resource from descriptive surfaces (MCP + OpenAPI).
		if (ResourceClass?.hidden === true) continue;
		const db = ResourceClass?.databaseName;
		const table = ResourceClass?.tableName;
		if (!db || !table) continue;
		const key = `${db}/${table}`;
		if (seen.has(key)) continue;
		seen.add(key);
		result.push({ db, table, description: ResourceClass?.description });
	}
	return result;
}

function enumerateAppHttpResources(): ResourceDescriptor[] {
	const prefix = guessAppHttpUrlPrefix();
	if (!prefix) return [];
	const out: ResourceDescriptor[] = [];
	for (const [path, entry] of getResources()) {
		if (!isMcpExposed(entry)) continue;
		const ResourceClass = entry.Resource as { prototype?: unknown; description?: string; hidden?: boolean } | undefined;
		// @hidden suppresses the Resource from descriptive surfaces (MCP + OpenAPI).
		if (ResourceClass?.hidden === true) continue;
		if (!hasRestVerbs(ResourceClass?.prototype)) continue;
		const tableDoc = ResourceClass?.description;
		const description = tableDoc
			? `${tableDoc} Application resource at /${path}. Resolves in-process via Resources.getMatch.`
			: `Application resource at /${path}. Resolves in-process via Resources.getMatch.`;
		out.push({
			uri: `${prefix}/${path}`,
			name: path,
			description,
			mimeType: 'application/json',
		});
	}
	return out;
}

/**
 * Honor the per-protocol export controls operators use to scope a
 * Resource's surface. A Resource registered with `exportTypes.mcp === false`
 * is explicitly opted out of MCP enumeration entirely. Missing flag = opted
 * in (mirror of how `Resources.getMatch` treats unspecified types).
 */
function isMcpExposed(entry: { exportTypes?: unknown }): boolean {
	const types = entry.exportTypes as Record<string, boolean> | undefined;
	if (!types) return true;
	return types.mcp !== false;
}

/**
 * Mirrors the verb-presence check at `resources/openApi.ts:149-153`.
 * Returns true if the Resource subclass defines any REST verb on its
 * prototype, which is what makes it visible over HTTP. `update()` is
 * counted because openApi treats it as an implicit POST override.
 */
function hasRestVerbs(prototype: unknown): boolean {
	if (!prototype || typeof prototype !== 'object') return false;
	const p = prototype as Record<string, unknown>;
	return (
		typeof p.get === 'function' ||
		typeof p.put === 'function' ||
		typeof p.post === 'function' ||
		typeof p.patch === 'function' ||
		typeof p.delete === 'function' ||
		typeof p.update === 'function'
	);
}

// ─── Read dispatchers ──────────────────────────────────────────────────

async function readHarperUri(
	uri: URL,
	user: AuthedUser,
	profile: McpProfile
): Promise<ReadResourceOk | ReadResourceFail> {
	// `harper://about` parses with host='about' (URL treats it like a host).
	// We use `host + pathname` to recover the full opaque path. Empty host
	// is also valid (some parsers strip it); fall back to pathname.
	const opaque = (uri.host || '') + (uri.pathname || '');
	if (opaque === '' || opaque === 'about') return readAbout(profile, uri.href);
	if (opaque === 'openapi') {
		if (profile !== 'application') {
			return { ok: false, reason: 'harper://openapi is only available on the application profile' };
		}
		return readOpenApi(uri.href);
	}
	if (opaque === 'operations') {
		if (profile !== 'operations') {
			return { ok: false, reason: 'harper://operations is only available on the operations profile' };
		}
		return readOperationsCatalog(user, uri.href);
	}
	const schemaMatch = /^schema\/([^/]+)\/([^/]+)$/.exec(opaque);
	if (schemaMatch) {
		return readTableSchema(schemaMatch[1], schemaMatch[2], user, uri.href);
	}
	return { ok: false, reason: `unknown harper:// resource: ${uri.href}` };
}

function readAbout(profile: McpProfile, href: string): ReadResourceOk {
	// Reuse the lifecycle module's constants so this resource and the
	// `initialize` handshake never drift.
	const body = {
		serverInfo: SERVER_INFO,
		profile,
		protocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
		capabilities: SERVER_CAPABILITIES,
	};
	return jsonContent(href, body);
}

function readOpenApi(href: string): ReadResourceOk | ReadResourceFail {
	try {
		const generator = getOpenApiGenerator();
		const serverHttpURL = guessAppHttpUrlPrefix() ?? '';
		const api = generator(getResources(), serverHttpURL);
		return jsonContent(href, api);
	} catch (err) {
		harperLogger.warn(`MCP harper://openapi generation failed: ${(err as Error).message}`);
		return { ok: false, reason: 'failed to generate openapi document' };
	}
}

function readTableSchema(db: string, table: string, user: AuthedUser, href: string): ReadResourceOk | ReadResourceFail {
	const perm = userTablePermissions(user, db, table);
	if (!perm?.read && !perm?.describe) {
		return { ok: false, reason: `permission denied: cannot describe ${db}.${table}` };
	}
	// Find the Resource backing this table.
	let resource: any | undefined;
	for (const entry of getResources().values()) {
		const r = entry.Resource as { databaseName?: string; tableName?: string } | undefined;
		if (r?.databaseName === db && r?.tableName === table) {
			resource = r;
			break;
		}
	}
	if (!resource) return { ok: false, reason: `table not found: ${db}.${table}` };
	const attributes = resource.attributes ?? [];
	const filteredAttributes = filterAttributesByPermissions(attributes, perm?.attribute_permissions);
	const body = {
		database: db,
		table,
		primaryKey: resource.primaryKey,
		attributes: filteredAttributes,
		// `attribute_permissions` is forwarded as informational — lets the LLM
		// surface "fields you can't write to" hints without us having to
		// pre-compute them.
		attribute_permissions: perm?.attribute_permissions,
	};
	return jsonContent(href, body);
}

function readOperationsCatalog(user: AuthedUser, href: string): ReadResourceOk {
	const out: Array<{ name: string }> = [];
	for (const opName of Object.values(OPERATIONS_ENUM)) {
		if (canRoleInvokeOperation(user, opName)) {
			out.push({ name: opName });
		}
	}
	out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	return jsonContent(href, { operations: out });
}

async function readAppResource(uri: URL): Promise<ReadResourceOk | ReadResourceFail> {
	// Strip the host:port and leading slash to get the path that
	// Resources.getMatch expects. Passing the 'mcp' export type runs the
	// existing per-protocol gate at resources/Resources.ts:97 — an entry
	// registered with exportTypes.mcp === false short-circuits to "no match".
	const path = uri.pathname.replace(/^\/+/, '');
	const entry = getResources().getMatch(path, 'mcp');
	if (!entry) return { ok: false, reason: `no resource matches: ${uri.href}` };

	const ResourceClass = entry.Resource as { databaseName?: string; tableName?: string } | undefined;
	// v1 returns a descriptor of the Resource class — enough for an LLM to
	// understand what's available. Full content reads (a record fetch, a
	// search result) go through the tools surface, where each Resource's
	// existing `transactional()` + `allow{Read,Create,Update,Delete}`
	// predicates run per-record. This keeps `resources/read` a fast,
	// side-effect-free metadata view; the descriptor itself isn't a
	// capability token, just a hint that this URI exists in the registry.
	const body = {
		uri: uri.href,
		path: entry.path,
		database: ResourceClass?.databaseName,
		table: ResourceClass?.tableName,
		hint: 'Use the corresponding `get_*` or `search_*` tool from `tools/list` to fetch records.',
	};
	return jsonContent(uri.href, body);
}

// ─── Helpers ───────────────────────────────────────────────────────────

interface TablePermissions {
	read: boolean;
	describe: boolean;
	attribute_permissions?: unknown;
}

function isSuperUser(user: AuthedUser | undefined): boolean {
	return user?.role?.permission?.super_user === true;
}

function userTablePermissions(user: AuthedUser, db: string, table: string): TablePermissions | null {
	if (isSuperUser(user)) {
		return { read: true, describe: true };
	}
	const dbPerm = user?.role?.permission?.[db];
	if (!dbPerm || typeof dbPerm !== 'object' || Array.isArray(dbPerm)) return null;
	const tablePerm = dbPerm.tables?.[table];
	if (!tablePerm) return null;
	return {
		read: tablePerm.read === true,
		describe: tablePerm.describe === true,
		attribute_permissions: tablePerm.attribute_permissions,
	};
}

const SCHEMA_STRUCTURE_OPERATIONS = new Set([
	'create_schema',
	'create_database',
	'drop_schema',
	'drop_database',
	'create_table',
	'drop_table',
	'create_attribute',
	'drop_attribute',
]);

function canRoleInvokeOperation(user: AuthedUser, operation: string): boolean {
	if (isSuperUser(user)) return true;
	const perm = user?.role?.permission;
	if (!perm) return false;
	if (perm.structure_user && SCHEMA_STRUCTURE_OPERATIONS.has(operation)) return true;
	if (Array.isArray(perm.operations) && perm.operations.includes(operation)) return true;
	return false;
}

function filterAttributesByPermissions(attributes: any[], attributePermissions: unknown): any[] {
	if (!attributePermissions || !Array.isArray(attributes)) return attributes;
	// `attribute_permissions` is an array of `{ attribute_name, read, insert,
	// update }` per Harper's existing role-permissions shape. v1 simply
	// drops attributes the user has no read on; finer-grained handling
	// (write-only / partial visibility) is documented but unimplemented.
	const denied = new Set<string>();
	if (Array.isArray(attributePermissions)) {
		for (const ap of attributePermissions) {
			if (ap && ap.attribute_name && ap.read === false) denied.add(ap.attribute_name);
		}
	}
	if (denied.size === 0) return attributes;
	return attributes.filter((a) => !denied.has(a?.name));
}

function guessAppHttpUrlPrefix(): string | undefined {
	// Best-effort URL prefix construction. Hostname comes from the server
	// module post-boot; the port comes from config. In tests where neither
	// is available we return undefined and skip the https:// enumeration —
	// callers handle the absence gracefully.
	if (_httpUrlPrefixOverride !== undefined) return _httpUrlPrefixOverride || undefined;
	let hostname: string | undefined;
	try {
		const { server } = require('../../server/Server');
		hostname = (server as { hostname?: string })?.hostname;
	} catch {
		return undefined;
	}
	if (!hostname) return undefined;

	// On Fabric, secure ports are shadowed through Unix domain sockets and
	// the published surface lives behind a load balancer (9926 → 443). Drop
	// the port so the URL points at the public surface, not the internal one.
	if (env.get(CONFIG_PARAMS.TLS_UNIXDOMAINSOCKETS)) {
		return `https://${hostname}`;
	}

	// Standard deployment: prefer the HTTPS port. Fall back to the plain
	// HTTP port for dev setups that don't configure TLS.
	const securePort = env.get(CONFIG_PARAMS.HTTP_SECUREPORT);
	if (securePort) return `https://${hostname}:${securePort}`;
	const httpPort = env.get(CONFIG_PARAMS.HTTP_PORT);
	if (httpPort) return `http://${hostname}:${httpPort}`;
	return undefined;
}

function jsonContent(uri: string, body: unknown): ReadResourceOk {
	return {
		ok: true,
		contents: [
			{
				uri,
				mimeType: 'application/json',
				text: JSON.stringify(body),
			},
		],
	};
}
