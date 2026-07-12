/**
 * RFC 0001 — Pillar 2: the per-method request contract (`withSchema` / `defineResource`).
 *
 * A resource declares a contract as runtime VALUES — `{ path, record?, get?/post?/put?/patch?/delete?:
 * { query?, body?, response? } }` — and TypeScript DERIVES the handler types from it (the same
 * value-first bargain `--conditions=typestrip` forces, and that `defineTable` already lives).
 *
 * This is a SUBSET, not a fork (proven by `docs/rfcs/spikes/0001/enforce-schema.spike.ts`). A handler
 * receives the SAME `RequestTarget` it receives today, structurally NARROWED: `target.id` is a string
 * when the path declares `:id`, `target.get('expand')` is typed by the declared query schema, and the
 * built-in filter/sort/limit grammar stays reachable. The enforced resource is assignable wherever the
 * untyped resource shape goes — it still registers and serves like a plain one.
 *
 * The narrowed types are JUSTIFIED by runtime enforcement: each declared verb is wrapped to
 * validate/coerce `query`/`body` before dispatch and returns a structured 400 (`ValidationError`) on
 * failure, so by the time a handler runs the narrowed types are true. Same bargain the DOM makes; same
 * role `Table.validate` plays for tables.
 *
 * ONE vocabulary. The built-in `t`/`schemaOf` builders reduce to `JsonSchemaFragment`
 * (`resources/jsonSchemaTypes.ts`) — the identical IR `defineTable`/GraphQL fields reduce to via
 * `attributeToFragment` — so a single declaration feeds validation, OpenAPI, and MCP. A `defineTable`
 * projection slots straight in: `schemaOf<(typeof Track)['$insert']>({ table: Track, projection:
 * 'insert' })` derives both the compile-time type (from the projection) and the runtime fragment (from
 * the table's attributes).
 */

import type { JsonSchemaFragment } from './jsonSchemaTypes.ts';
import { attributeToFragment, type AttributeLike } from './jsonSchemaTypes.ts';
import { ValidationError, type ValidationIssue } from '../utility/errors/hdbError.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Schema vocabulary — phantom-typed carriers backed by a runtime JsonSchemaFragment.
// `_type` is a phantom (never present at runtime); the fragment + `isOptional` are the
// runtime metadata. `.optional` yields a fresh carrier (immutable chaining).
// ─────────────────────────────────────────────────────────────────────────────

export interface Schema<T> {
	/** phantom — the TS type this schema validates to; never present at runtime. */
	readonly _type?: T;
	/** mark this schema optional within its containing object/query (the property may be absent). */
	readonly optional: Schema<T | undefined>;
	/** allow an explicit `null` value. Non-nullable is the default — a bare `t.string` rejects `null`. */
	readonly nullable: Schema<T | null>;
}

/** Runtime view of a {@link Schema}: its fragment, whether it is optional, and passthrough marker. */
interface SchemaInternal {
	fragment: JsonSchemaFragment;
	isOptional: boolean;
	/** true when no shape was supplied (`schemaOf<T>()` with no source) — validation is a no-op. */
	passthrough: boolean;
}

function makeSchema(fragment: JsonSchemaFragment, isOptional: boolean, passthrough = false): any {
	return {
		_fragment: fragment,
		_optional: isOptional,
		_passthrough: passthrough,
		get optional() {
			return makeSchema(fragment, true, passthrough);
		},
		get nullable() {
			// `nullable: true` on the fragment is what the validator checks; the TS type gains `| null`.
			return makeSchema({ ...fragment, nullable: true }, isOptional, passthrough);
		},
	};
}

function internalOf(schema: any): SchemaInternal {
	return { fragment: schema?._fragment ?? {}, isOptional: !!schema?._optional, passthrough: !!schema?._passthrough };
}

type TypeOf<S> = S extends Schema<infer T> ? T : never;
type OptionalKeys<P> = { [K in keyof P]-?: undefined extends TypeOf<P[K]> ? K : never }[keyof P];
type RequiredKeys<P> = Exclude<keyof P, OptionalKeys<P>>;
/** The object type of a `t.object(props)` — fields whose schema includes `undefined` become optional. */
type ObjectType<P> = { [K in RequiredKeys<P>]: TypeOf<P[K]> } & { [K in OptionalKeys<P>]?: TypeOf<P[K]> };

function objectFragment(props: Record<string, any>): JsonSchemaFragment {
	const properties: Record<string, JsonSchemaFragment> = {};
	const required: string[] = [];
	for (const [key, schema] of Object.entries(props)) {
		const internal = internalOf(schema);
		properties[key] = internal.fragment;
		if (!internal.isOptional) required.push(key);
	}
	const fragment: JsonSchemaFragment = { type: 'object', properties, additionalProperties: false };
	if (required.length) fragment.required = required;
	return fragment;
}

/**
 * The zero-dependency built-in schema vocabulary for query params and bodies. Every builder reduces to
 * a `JsonSchemaFragment`, so a contract's declarations feed validation + OpenAPI + MCP from one source.
 */
export const t = {
	string: makeSchema({ type: 'string' }, false) as Schema<string>,
	number: makeSchema({ type: 'number' }, false) as Schema<number>,
	integer: makeSchema({ type: 'integer' }, false) as Schema<number>,
	boolean: makeSchema({ type: 'boolean' }, false) as Schema<boolean>,
	/** ISO-8601 timestamp; validates as a string, coerced to `Date` in bodies. */
	date: makeSchema({ type: 'string', format: 'date-time' }, false) as Schema<Date>,
	enum: <const E extends readonly string[]>(values: E) =>
		makeSchema({ type: 'string', enum: values }, false) as Schema<E[number]>,
	array: <T>(item: Schema<T>) => makeSchema({ type: 'array', items: internalOf(item).fragment }, false) as Schema<T[]>,
	object: <P extends Record<string, Schema<any>>>(props: P) =>
		makeSchema(objectFragment(props), false) as Schema<ObjectType<P>>,
};

// ─────────────────────────────────────────────────────────────────────────────
// schemaOf — a type-carrier for an existing TS type (an interface or a `defineTable`
// projection). The TYPE argument carries the compile-time shape; the optional runtime
// `source` supplies the fragment (a raw fragment, a table handle, or `{ table, projection }`).
// With no source it is a passthrough (typed, but not runtime-validated).
// ─────────────────────────────────────────────────────────────────────────────

export type Projection = 'record' | 'insert' | 'upsert' | 'patch' | 'query';

/** Minimal runtime shape of a table handle (`defineTable(...)` / `tables.Foo`) needed to project a fragment. */
interface TableLike {
	attributes?: AttributeLike[];
	primaryKey?: string;
}

export type SchemaSource = JsonSchemaFragment | TableLike | { table: TableLike; projection?: Projection };

/** Type-only schema for an existing TS type — an interface, or a `defineTable` projection like `(typeof Track)['$insert']`. */
export function schemaOf<T>(source?: SchemaSource): Schema<T> {
	if (source == null) return makeSchema({}, false, true);
	return makeSchema(resolveSourceFragment(source), false);
}

function isTableLike(value: any): value is TableLike {
	return value && Array.isArray(value.attributes);
}

function resolveSourceFragment(source: SchemaSource): JsonSchemaFragment {
	if (isTableLike(source)) return projectTableFragment(source, 'record');
	if ((source as any).table && isTableLike((source as any).table)) {
		const { table, projection } = source as { table: TableLike; projection?: Projection };
		return projectTableFragment(table, projection ?? 'record');
	}
	return source as JsonSchemaFragment;
}

/**
 * Project a table handle's attributes into a JSON-Schema object fragment for the given projection.
 * Reuses the shared `attributeToFragment` per field (NOT a parallel translator) and applies the same
 * inclusion/required rules as `defineTable`'s type projections and the MCP `derive` schemas:
 *   • record — all scalar fields, readonly; server-managed/PK/required fields marked required
 *   • insert — writable fields, PK optional, server-managed excluded
 *   • upsert — writable fields, PK required
 *   • patch  — writable non-PK fields, all optional
 *   • query  — indexed fields only, all optional
 * Relationship and computed attributes are excluded (they aren't client-writable and their fragment
 * type is the related table name, not a JSON type).
 */
export function projectTableFragment(table: TableLike, projection: Projection): JsonSchemaFragment {
	const attributes = table.attributes ?? [];
	const properties: Record<string, JsonSchemaFragment> = {};
	const required: string[] = [];
	for (const attr of attributes) {
		const a = attr as any;
		if (a.relationship || a.computed || a.computedFromExpression) continue;
		const serverManaged = a.assignCreatedTime || a.assignUpdatedTime || a.expiresAt;
		const isPk = a.isPrimaryKey;
		if (projection !== 'record' && projection !== 'query' && serverManaged) continue; // never client-writable
		if (projection === 'query' && !a.indexed) continue;
		if (projection === 'patch' && isPk) continue;
		const fieldFragment = attributeToFragment(attr);
		// Mirror Table.validate's null policy so a table-derived contract body validates identically:
		// a column rejects `null` only when `nullable === false` (a required column). Everything else
		// (nullable columns, PK, server-managed) accepts an explicit null.
		if (a.nullable !== false) fieldFragment.nullable = true;
		if (a.enum) fieldFragment.enum = a.enum;
		properties[attr.name] = fieldFragment;
		switch (projection) {
			case 'record':
				if (a.nullable === false || serverManaged || isPk) required.push(attr.name);
				break;
			case 'insert':
				if (a.nullable === false && !isPk) required.push(attr.name);
				break;
			case 'upsert':
				if (a.nullable === false || isPk) required.push(attr.name);
				break;
			// patch + query: everything optional
		}
	}
	const fragment: JsonSchemaFragment = { type: 'object', properties, additionalProperties: false };
	if (required.length) fragment.required = required;
	return fragment;
}

// ─────────────────────────────────────────────────────────────────────────────
// The contract shape.
// ─────────────────────────────────────────────────────────────────────────────

export interface VerbSchemas {
	readonly query?: Record<string, Schema<any>>;
	readonly body?: Schema<any>;
	readonly response?: Schema<any>;
}

export interface Contract {
	readonly path: string;
	/** Optional human description, surfaced on OpenAPI/MCP. */
	readonly description?: string;
	/** The resource's record type; defaults `get`'s response and `put`'s body when not overridden. */
	readonly record?: Schema<any>;
	readonly get?: VerbSchemas;
	readonly post?: VerbSchemas;
	readonly put?: VerbSchemas;
	readonly patch?: VerbSchemas;
	readonly delete?: VerbSchemas;
}

export type VerbName = 'get' | 'post' | 'put' | 'patch' | 'delete';
const BODY_VERBS: ReadonlySet<string> = new Set(['post', 'put', 'patch']);
const ALL_VERBS: readonly VerbName[] = ['get', 'post', 'put', 'patch', 'delete'];

// ─────────────────────────────────────────────────────────────────────────────
// Type-level derivation of handler signatures from a contract.
// ─────────────────────────────────────────────────────────────────────────────

type MaybePromise<T> = T | Promise<T>;

/** Template-literal parse of the declared path (matches the runtime, which Object.assigns matched segments). */
export type PathParams<S extends string> = S extends `${string}:${infer P}/${infer Rest}`
	? { [K in P]: string } & PathParams<`/${Rest}`>
	: S extends `${string}:${infer P}`
		? { [K in P]: string }
		: S extends `${string}*${infer W}`
			? { [K in W extends '' ? 'wildcard' : W]: string }
			: {};

type InferSchema<S> = S extends Schema<infer T> ? T : never;
type RecordOf<C> = C extends { record: Schema<infer R> } ? R : unknown;
type QueryOf<VS> = VS extends { query: infer Q } ? { [K in keyof Q]: InferSchema<Q[K]> } : {};
type ResponseOf<VS, R> = VS extends { response: Schema<infer T> } ? T : R;
type BodyOf<VS, V, R> = VS extends { body: Schema<infer T> } ? T : V extends 'put' ? R : unknown;

/** `RequestTarget.get` overloaded for declared query params; anything else falls back to `string | null`. */
export interface TypedSearchParams<Q> {
	get<K extends keyof Q & string>(name: K): Q[K];
	get(name: string): string | null;
}

/** The built-in query grammar that stays reachable on the narrowed target (a subset of RequestTarget). */
interface QueryGrammar {
	conditions?: unknown[];
	sort?: unknown;
	select?: unknown;
	limit?: number;
	offset?: number;
}

/** The SAME RequestTarget, narrowed: path params intersected on, `.get` typed by the query schema. */
export type TypedTarget<P extends string, Q> = QueryGrammar & PathParams<P> & TypedSearchParams<Q>;

type HandlerFor<C extends Contract, V extends keyof C & VerbName, R> = V extends 'get'
	? (target: TypedTarget<C['path'], QueryOf<C[V]>>) => MaybePromise<ResponseOf<C[V], R>>
	: V extends 'delete'
		? (target: TypedTarget<C['path'], QueryOf<C[V]>>) => MaybePromise<ResponseOf<C[V], R>>
		: (target: TypedTarget<C['path'], QueryOf<C[V]>>, data: BodyOf<C[V], V, R>) => MaybePromise<ResponseOf<C[V], R>>;

/** Every verb the contract declares is REQUIRED of the impl; a misspelled/missing verb is an error. */
export type ImplFor<C extends Contract> = {
	[V in keyof C & VerbName]: HandlerFor<C, V, RecordOf<C>>;
};

// ─────────────────────────────────────────────────────────────────────────────
// Runtime validation.
// ─────────────────────────────────────────────────────────────────────────────

const JSON_TYPE_CHECK: Record<string, (v: any) => boolean> = {
	string: (v) => typeof v === 'string',
	integer: (v) => typeof v === 'number' && Number.isInteger(v),
	number: (v) => typeof v === 'number' && !Number.isNaN(v),
	boolean: (v) => typeof v === 'boolean',
	object: (v) => v != null && typeof v === 'object' && !Array.isArray(v),
	array: (v) => Array.isArray(v),
	null: (v) => v === null,
};

/** A fragment accepts `null` only when explicitly `nullable` or its type union includes `'null'`. */
function isNullable(fragment: JsonSchemaFragment): boolean {
	return fragment.nullable === true || (Array.isArray(fragment.type) && fragment.type.includes('null'));
}

/** Validate a JSON value against a fragment (a subset of JSON Schema), pushing structured issues. Returns coerced value. */
function validateValue(value: any, fragment: JsonSchemaFragment, path: string, issues: ValidationIssue[]): any {
	if (!fragment || fragment.type == null) return value; // passthrough / untyped
	if (value === undefined) return value; // absence is enforced by the parent object's `required`
	if (value === null) {
		// Non-nullable is the default; only `.nullable` (fragment.nullable) or a `null` type accepts null.
		if (!isNullable(fragment)) issues.push({ path, code: 'nullable', message: `${path} may not be null` });
		return value;
	}
	const types = Array.isArray(fragment.type) ? fragment.type : [fragment.type];
	const primary = types[0] as string;
	// Body dates arrive as ISO strings; coerce to Date when the schema calls for a date-time.
	if (primary === 'string' && fragment.format === 'date-time' && typeof value === 'string') {
		const d = new Date(value);
		if (Number.isNaN(d.getTime())) {
			issues.push({ path, code: 'format', message: `${path} must be an ISO-8601 date-time` });
			return value;
		}
		value = d;
	}
	// A Date is a valid value ONLY for a `string`/`date-time` field (we coerced an ISO string above);
	// it must not slip past the type check for a number/boolean/array/object schema.
	const matches = types.some((ty) => {
		if (ty === 'string' && fragment.format === 'date-time' && value instanceof Date) return true;
		return JSON_TYPE_CHECK[ty as string]?.(value) ?? true;
	});
	if (!matches) {
		issues.push({ path, code: 'type', message: `${path} must be of type ${types.join(' | ')}` });
		return value;
	}
	if (fragment.enum && !fragment.enum.includes(value)) {
		issues.push({ path, code: 'enum', message: `${path} must be one of: ${fragment.enum.join(', ')}` });
		return value;
	}
	if (primary === 'array' && fragment.items && Array.isArray(value)) {
		return value.map((el, i) => validateValue(el, fragment.items as JsonSchemaFragment, `${path}[${i}]`, issues));
	}
	if (primary === 'object' && fragment.properties && value && typeof value === 'object') {
		return validateObject(value, fragment, path, issues);
	}
	return value;
}

function validateObject(value: any, fragment: JsonSchemaFragment, path: string, issues: ValidationIssue[]): any {
	const props = fragment.properties ?? {};
	const scope = path ? `${path}.` : '';
	for (const key of fragment.required ?? []) {
		// `required` is about presence; an explicit `null` is present (and rejected by the per-property
		// nullable check below unless the field is nullable).
		if (value[key] === undefined)
			issues.push({ path: `${scope}${key}`, code: 'required', message: `${scope}${key} is required` });
	}
	for (const [key, sub] of Object.entries(props)) {
		if (value[key] !== undefined) {
			const coerced = validateValue(value[key], sub, `${scope}${key}`, issues);
			if (coerced !== value[key]) value[key] = coerced;
		}
	}
	if (fragment.additionalProperties === false) {
		for (const key of Object.keys(value)) {
			if (!(key in props))
				issues.push({
					path: `${scope}${key}`,
					code: 'unknown_property',
					message: `${scope}${key} is not an allowed property`,
				});
		}
	}
	return value;
}

/** Validate/coerce a request body against a fragment. Returns the (possibly coerced) body. */
function validateBody(fragment: JsonSchemaFragment, body: any, issues: ValidationIssue[]): any {
	if (!fragment || fragment.type == null) return body;
	if (body === undefined) {
		// a missing body fails each declared required field
		for (const key of fragment.required ?? [])
			issues.push({ path: `body.${key}`, code: 'required', message: `body.${key} is required` });
		return body;
	}
	// a `null` body is rejected unless the top-level body schema is nullable (validateValue handles it)
	return validateValue(body, fragment, 'body', issues);
}

/**
 * Read the declared query params off the target (a URLSearchParams), validate/coerce them, and install
 * a coercing `.get` so a handler reads the typed values (`target.get('expand')` → the coerced array),
 * while undeclared keys still return the raw `string | null`. Pushes structured issues for
 * required-missing / bad-enum / bad-type params.
 */
function coerceAndValidateQuery(fragment: JsonSchemaFragment, target: any, issues: ValidationIssue[]): void {
	const props = fragment.properties ?? {};
	const required = new Set(fragment.required ?? []);
	const coerced: Record<string, any> = Object.create(null);
	const rawGet = URLSearchParams.prototype.get;
	const rawGetAll = URLSearchParams.prototype.getAll;
	for (const [key, sub] of Object.entries(props)) {
		const subType = Array.isArray(sub.type) ? sub.type[0] : sub.type;
		const present = URLSearchParams.prototype.has.call(target, key);
		if (!present) {
			if (required.has(key))
				issues.push({ path: `query.${key}`, code: 'required', message: `query.${key} is required` });
			coerced[key] = undefined;
			continue;
		}
		if (subType === 'array') {
			const raw = rawGetAll.call(target, key);
			coerced[key] = raw.map((el: string, i: number) =>
				coerceScalar(el, sub.items as JsonSchemaFragment, `query.${key}[${i}]`, issues)
			);
		} else {
			coerced[key] = coerceScalar(rawGet.call(target, key) as string, sub, `query.${key}`, issues);
		}
	}
	Object.defineProperty(target, 'get', {
		configurable: true,
		writable: true,
		value: function (name: string) {
			return name in coerced ? coerced[name] : rawGet.call(this, name);
		},
	});
	// Keep `getAll` consistent with the coercing `get`: a declared key returns its coerced value as an
	// array (arrays pass through; a scalar is wrapped, undefined → []); undeclared keys read raw.
	Object.defineProperty(target, 'getAll', {
		configurable: true,
		writable: true,
		value: function (name: string) {
			if (name in coerced) {
				const val = coerced[name];
				return Array.isArray(val) ? val : val === undefined ? [] : [val];
			}
			return rawGetAll.call(this, name);
		},
	});
}

/** Coerce a single query string to the fragment's scalar type and validate enum membership. */
function coerceScalar(
	raw: string,
	fragment: JsonSchemaFragment | undefined,
	path: string,
	issues: ValidationIssue[]
): any {
	if (!fragment) return raw;
	const type = Array.isArray(fragment.type) ? fragment.type[0] : fragment.type;
	let value: any = raw;
	if (type === 'integer' || type === 'number') {
		// `Number('')`/`Number(' ')` are 0 — treat an empty/whitespace param as a type error, not a silent 0.
		if (raw == null || raw.trim() === '') {
			issues.push({ path, code: 'type', message: `${path} must be ${type === 'integer' ? 'an integer' : 'a number'}` });
			return raw;
		}
		value = Number(raw);
		if (Number.isNaN(value) || (type === 'integer' && !Number.isInteger(value))) {
			issues.push({ path, code: 'type', message: `${path} must be ${type === 'integer' ? 'an integer' : 'a number'}` });
			return raw;
		}
	} else if (type === 'boolean') {
		if (raw === 'true') value = true;
		else if (raw === 'false') value = false;
		else {
			issues.push({ path, code: 'type', message: `${path} must be a boolean` });
			return raw;
		}
	} else if (type === 'string' && fragment.format === 'date-time') {
		const d = new Date(raw);
		if (Number.isNaN(d.getTime())) {
			issues.push({ path, code: 'format', message: `${path} must be an ISO-8601 date-time` });
			return raw;
		}
		value = d;
	}
	if (fragment.enum && !fragment.enum.includes(value)) {
		issues.push({ path, code: 'enum', message: `${path} must be one of: ${fragment.enum.join(', ')}` });
	}
	return value;
}

// ─────────────────────────────────────────────────────────────────────────────
// Contract → static metadata + verb wrappers.
// ─────────────────────────────────────────────────────────────────────────────

/** Per-verb input schemas landed on `static inputSchemas` for OpenAPI/MCP to read. */
export interface VerbInputSchema {
	query?: JsonSchemaFragment;
	body?: JsonSchemaFragment;
}

interface CompiledVerb {
	queryFragment?: JsonSchemaFragment;
	bodyFragment?: JsonSchemaFragment;
	hasBody: boolean;
}

function compileVerb(contract: Contract, verb: VerbName): CompiledVerb {
	const vs = (contract as any)[verb] as VerbSchemas;
	const queryFragment = vs?.query ? objectFragment(vs.query) : undefined;
	let bodyFragment: JsonSchemaFragment | undefined;
	if (BODY_VERBS.has(verb)) {
		const bodySchema = vs?.body ?? (verb === 'put' ? contract.record : undefined);
		if (bodySchema) {
			const internal = internalOf(bodySchema);
			if (!internal.passthrough) bodyFragment = internal.fragment;
		}
	}
	return { queryFragment, bodyFragment, hasBody: BODY_VERBS.has(verb) };
}

/** Build the `{ verb: { query?, body? } }` map for OpenAPI/MCP. */
function buildInputSchemas(contract: Contract): Record<string, VerbInputSchema> {
	const inputSchemas: Record<string, VerbInputSchema> = {};
	for (const verb of ALL_VERBS) {
		if (!(contract as any)[verb]) continue;
		const { queryFragment, bodyFragment } = compileVerb(contract, verb);
		const entry: VerbInputSchema = {};
		if (queryFragment) entry.query = queryFragment;
		if (bodyFragment) entry.body = bodyFragment;
		inputSchemas[verb] = entry;
	}
	return inputSchemas;
}

/** Build the `{ verb: responseFragment }` map (get/delete default to the record). */
function buildOutputSchemas(contract: Contract): Record<string, JsonSchemaFragment> {
	const outputSchemas: Record<string, JsonSchemaFragment> = {};
	const recordFragment = contract.record ? unwrapFragment(contract.record) : undefined;
	for (const verb of ALL_VERBS) {
		const vs = (contract as any)[verb] as VerbSchemas;
		if (!vs) continue;
		const responseFragment = vs.response ? unwrapFragment(vs.response) : verb === 'get' ? recordFragment : undefined;
		if (responseFragment) outputSchemas[verb] = responseFragment;
	}
	return outputSchemas;
}

function unwrapFragment(schema: Schema<any>): JsonSchemaFragment | undefined {
	const internal = internalOf(schema);
	return internal.passthrough ? undefined : internal.fragment;
}

/** Attach the contract metadata to a resource carrier (class or plain object). */
function applyContractMetadata(carrier: any, contract: Contract): void {
	carrier.path = contract.path;
	carrier.requestContract = contract;
	carrier.inputSchemas = buildInputSchemas(contract);
	const outputSchemas = buildOutputSchemas(contract);
	if (Object.keys(outputSchemas).length) carrier.outputSchemas = { ...carrier.outputSchemas, ...outputSchemas };
	if (contract.record) {
		const recordFragment = unwrapFragment(contract.record);
		if (recordFragment?.properties) carrier.properties = { ...carrier.properties, ...recordFragment.properties };
	}
	if (contract.description && !carrier.description) carrier.description = contract.description;
}

/**
 * Wrap a verb entry so `query`/`body` are validated/coerced before dispatch, returning a structured
 * 400 (`ValidationError`) on failure. Only acts on the HTTP shape (first arg is a `URLSearchParams` /
 * `RequestTarget`); a programmatic `.post(record)` call passes through untouched to `original`.
 */
function wrapStaticVerb(original: Function, compiled: CompiledVerb): Function {
	const { queryFragment, bodyFragment, hasBody } = compiled;
	return function (this: any, target: any, ...rest: any[]) {
		if (target instanceof URLSearchParams) {
			const issues: ValidationIssue[] = [];
			if (queryFragment) coerceAndValidateQuery(queryFragment, target, issues);
			if (hasBody && bodyFragment) rest[0] = validateBody(bodyFragment, rest[0], issues);
			if (issues.length) throw new ValidationError(issues);
		}
		return original.call(this, target, ...rest);
	};
}

/** Install validating overrides for every declared verb onto a class's static verb entries. */
function installStaticVerbValidators(cls: any, contract: Contract): void {
	for (const verb of ALL_VERBS) {
		if (!(contract as any)[verb]) continue;
		const original = cls[verb];
		if (typeof original !== 'function') continue;
		Object.defineProperty(cls, verb, {
			configurable: true,
			writable: true,
			value: wrapStaticVerb(original, compileVerb(contract, verb)),
		});
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API — class form (`Resource.withSchema`) + function form (`defineResource`).
// ─────────────────────────────────────────────────────────────────────────────

/** The instance-side verb handlers a `withSchema` base class declares, so a subclass's overrides narrow. */
type SchemaHandlers<C extends Contract> = {
	[V in keyof C & VerbName]?: HandlerFor<C, V, RecordOf<C>>;
};

/** The class returned by `Resource.withSchema(contract)`: extend it and implement the declared verbs. */
export type SchemaClass<Base, C extends Contract> = Base & {
	new (...args: any[]): SchemaHandlers<C>;
	readonly path: C['path'];
	readonly requestContract: C;
};

/**
 * Build a Resource subclass carrying `contract` — its static verb entries validate before dispatch and
 * its static metadata slots (`path`, `requestContract`, `inputSchemas`, `outputSchemas`, `properties`)
 * feed OpenAPI/MCP. Wired as `Resource.withSchema` (see `Resource.ts`).
 */
export function makeSchemaClass<Base extends new (...args: any[]) => any, C extends Contract>(
	BaseClass: Base,
	contract: C
): SchemaClass<Base, C> {
	const Enforced = class extends BaseClass {};
	// The narrowed handler types (and the spike/function form) use the converged `(target, data)` arg
	// order. Harper's dispatch only calls instance verbs that way when `loadAsInstance === false`
	// (the default, undefined, gives the legacy `(data, target)`), so pin it — withSchema is for custom
	// resources, which handle their own loading. Without this the class-form types would lie about the
	// arg order (Resource.post/put/patch dispatch, Resource.ts).
	(Enforced as any).loadAsInstance = false;
	applyContractMetadata(Enforced, contract);
	installStaticVerbValidators(Enforced, contract);
	return Enforced as unknown as SchemaClass<Base, C>;
}

/**
 * Function-form twin of `withSchema`: wrap an object literal of verb handlers with the contract. Every
 * declared verb is required of `impl` (a missing/misspelled verb is a type error) and undeclared extras
 * on an inline literal are rejected. Returns a plain resource object (drop-in wherever the untyped shape
 * goes) whose verbs validate/coerce before running the handler.
 */
export function defineResource<const C extends Contract>(
	contract: C,
	impl: ImplFor<C>
): ImplFor<C> & { path: C['path'] } {
	if ((impl as any).path != null && (impl as any).path !== contract.path) {
		throw new Error(
			`defineResource: impl.path (${(impl as any).path}) does not match contract.path (${contract.path})`
		);
	}
	const resource: any = {};
	// A synthetic prototype mirroring the verb methods: OpenAPI (`prototype.post !== Resource.prototype
	// .post`, `typeof prototype.put === 'function'`) and MCP (`detectVerbs` reads the prototype) key
	// verb presence off `.prototype`. A bare object has none, so without this a function-form resource
	// is invisible to MCP and crashes OpenAPI's non-parameterised loop at `prototype.post`. REST still
	// dispatches the own methods; this only advertises which verbs exist.
	const prototype: any = {};
	// carry any non-verb members of a pre-existing impl object through unchanged
	for (const key of Object.keys(impl as any)) {
		if (!ALL_VERBS.includes(key as VerbName)) resource[key] = (impl as any)[key];
	}
	for (const verb of ALL_VERBS) {
		const handler = (impl as any)[verb];
		if (typeof handler !== 'function') continue;
		const wrapped = (contract as any)[verb] ? wrapStaticVerb(handler, compileVerb(contract, verb)) : handler; // undeclared-but-present verb: pass through unvalidated
		resource[verb] = wrapped;
		prototype[verb] = wrapped;
	}
	resource.prototype = prototype;
	applyContractMetadata(resource, contract);
	return resource as ImplFor<C> & { path: C['path'] };
}
