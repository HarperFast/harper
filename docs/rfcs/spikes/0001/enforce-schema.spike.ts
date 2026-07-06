/**
 * RFC 0001 — Spike: `enforceSchema` — schema-typing as a SUBSET of the existing interface.
 *
 * This answers the Pillar-2 thread the same way canonical-track.spike.ts answered
 * singular-vs-plural. The two positions reconcile:
 *
 *   • NO third request type. A handler under `enforceSchema` receives the SAME
 *     `RequestTarget` it receives today — structurally NARROWED (`target.id: string`
 *     when the path says `:id`; `target.get('expand')` typed by the declared query
 *     schema), never replaced. The built-in query grammar (`conditions`, `sort`,
 *     `limit`, …) stays reachable on the same object. The schema-typed resource is a
 *     drop-in, type-compatible subset: assignable wherever the untyped shape goes.
 *
 *   • Discoverability/typo-detection (the `gwt` vs `get` concern) IS solved, twice:
 *       – a bare object gets it from `satisfies ResourceMethods` — excess-property
 *         checking flags a misspelled verb at the definition site, zero wrappers;
 *       – under `enforceSchema`, the contract's verbs are REQUIRED of the impl
 *         (misspell the impl → "missing `get`") and undeclared extras on an inline
 *         impl literal are rejected (typo → excess-property error).
 *
 * Handler shape: verbs take `(target, data)` — the modern `ResourceInterface` /
 * converged-signature shape (see the PR-review thread on post/put arg order); `get`
 * takes `(target)`.
 *
 * One deliberate deviation from the review-thread sketch (`enforceSchema<RecordType>(…)`):
 * TypeScript has no partial type-argument inference — writing `enforceSchema<Widget>(…)`
 * would force the contract type parameter back to its default and destroy all inference.
 * So the record type rides IN the contract as a value (`record: schemaOf<Widget>()`),
 * which keeps the whole call inferred. (The alternative is a curried
 * `enforceSchema<Widget>()(contract, impl)`.) With `defineTable` landed, a table's own
 * projections slot straight in here (e.g. `record`/`body` schemas derived from `Track`),
 * so the two spikes share one vocabulary.
 *
 * The type-level narrowing is JUSTIFIED by runtime enforcement: the real
 * `enforceSchema` wraps each declared verb to validate/coerce params/query/body
 * before dispatch (structured 400s), so by the time a handler runs, the narrowed
 * types are true. Same bargain the DOM makes; same role `Table.validate` plays for
 * tables. This spike's runtime is intentionally thin — the wrapping lands in the
 * implementation PR.
 *
 * Verify (repo settings: strict, NodeNext, erasableSyntaxOnly):
 *   npx tsc --noEmit --project docs/rfcs/spikes/0001/tsconfig.json
 * A green run IS the proof; `@ts-expect-error` lines prove the negative cases.
 */

/* eslint-disable @typescript-eslint/no-unused-vars */

type MaybePromise<T> = T | Promise<T>;

// ─────────────────────────────────────────────────────────────────────────────
// Stand-ins for the real runtime types (subset of resources/RequestTarget.ts).
// `get` is the URLSearchParams accessor; conditions/sort/limit are the built-in
// query grammar — present here to prove they REMAIN reachable after narrowing.
// ─────────────────────────────────────────────────────────────────────────────

interface RequestTargetLike {
	id?: string | number;
	conditions?: unknown[];
	sort?: unknown;
	limit?: number;
	offset?: number;
	get(name: string): string | null;
}

/**
 * The untyped plain-object resource shape — what a component can export today.
 * Verbs are METHODS (bivariant), which is what makes the narrowed handlers below
 * assignable back to this shape (the same variance rule DOM handlers rely on).
 */
interface ResourceMethods {
	path?: string;
	get?(target: RequestTargetLike): unknown;
	post?(target: RequestTargetLike, data: unknown): unknown;
	put?(target: RequestTargetLike, data: unknown): unknown;
	patch?(target: RequestTargetLike, data: unknown): unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// Path params — template-literal parse of the declared path (from the RFC §5,
// incl. the named-wildcard arm). Matches runtime binding: matched segments are
// Object.assign'ed onto the target, so `:id` lands on `target.id`.
// ─────────────────────────────────────────────────────────────────────────────

type PathParams<S extends string> = S extends `${string}:${infer P}/${infer Rest}`
	? { [K in P]: string } & PathParams<`/${Rest}`>
	: S extends `${string}:${infer P}`
		? { [K in P]: string }
		: S extends `${string}*${infer W}`
			? { [K in W extends '' ? 'wildcard' : W]: string }
			: {};

// ─────────────────────────────────────────────────────────────────────────────
// Minimal schema vocabulary — spike-local phantom carriers. The real
// implementation reuses the `defineTable` field vocabulary / JsonSchemaFragment
// (one vocabulary across table fields, query params, and bodies); `.optional`
// follows the property-getter style from the canonical-track spike.
// ─────────────────────────────────────────────────────────────────────────────

interface Schema<T> {
	readonly _ts: T; // phantom (never present at runtime)
	readonly optional: Schema<T | undefined>;
}

function makeSchema(): any {
	return {
		get optional() {
			return makeSchema();
		},
	};
}

const s = {
	string: makeSchema() as Schema<string>,
	number: makeSchema() as Schema<number>,
	boolean: makeSchema() as Schema<boolean>,
	enumOf: <const E extends readonly string[]>(values: E) => makeSchema() as Schema<E[number]>,
	arrayOf: <T>(item: Schema<T>) => makeSchema() as Schema<T[]>,
};

/** Type-only schema for an existing TS type (a record interface, a defineTable projection, …). */
function schemaOf<T>(): Schema<T> {
	return makeSchema();
}

type InferSchema<S> = S extends Schema<infer T> ? T : never;

// ─────────────────────────────────────────────────────────────────────────────
// The contract: path + record + per-verb { query?, body?, response? }.
// ─────────────────────────────────────────────────────────────────────────────

interface VerbSchemas {
	readonly query?: Record<string, Schema<any>>;
	readonly body?: Schema<any>;
	readonly response?: Schema<any>;
}

interface Contract {
	readonly path: string;
	/** The resource's record type; defaults `get`'s response and `put`'s body. */
	readonly record?: Schema<any>;
	readonly get?: VerbSchemas;
	readonly post?: VerbSchemas;
	readonly put?: VerbSchemas;
	readonly patch?: VerbSchemas;
}

type VerbName = 'get' | 'post' | 'put' | 'patch';

type RecordOf<C> = C extends { record: Schema<infer R> } ? R : unknown;
type QueryOf<VS> = VS extends { query: infer Q } ? { [K in keyof Q]: InferSchema<Q[K]> } : {};
type ResponseOf<VS, R> = VS extends { response: Schema<infer T> } ? T : R;
type BodyOf<VS, V, R> = VS extends { body: Schema<infer T> } ? T : V extends 'put' ? R : unknown;

// ─────────────────────────────────────────────────────────────────────────────
// The narrowed target — the SAME RequestTarget, with `get` overloaded for the
// declared query params (falling back to plain string|null for anything else)
// and the path params intersected on. Structurally assignable to
// RequestTargetLike, which is what makes the whole thing a subset, not a fork.
// ─────────────────────────────────────────────────────────────────────────────

interface TypedSearchParams<Q> {
	get<K extends keyof Q & string>(name: K): Q[K];
	get(name: string): string | null;
}

type TypedTarget<P extends string, Q> = Omit<RequestTargetLike, 'get'> & PathParams<P> & TypedSearchParams<Q>;

type HandlerFor<C extends Contract, V extends keyof C & VerbName, R> = V extends 'get'
	? (target: TypedTarget<C['path'], QueryOf<C[V]>>) => MaybePromise<ResponseOf<C[V], R>>
	: (target: TypedTarget<C['path'], QueryOf<C[V]>>, data: BodyOf<C[V], V, R>) => MaybePromise<ResponseOf<C[V], R>>;

/** Every verb the contract declares is REQUIRED of the impl — a misspelled impl verb is a missing-member error. */
type ImplFor<C extends Contract> = {
	[V in keyof C & VerbName]: HandlerFor<C, V, RecordOf<C>>;
};

function enforceSchema<const C extends Contract>(contract: C, impl: ImplFor<C>): ImplFor<C> & { path: C['path'] } {
	// Implementation PR: wrap each declared verb to validate/coerce params/query/body
	// before dispatch (structured 400s) and assert impl.path, if present, matches
	// contract.path. That runtime step is what justifies the narrowed types above.
	return Object.assign({ path: contract.path }, impl) as ImplFor<C> & { path: C['path'] };
}

// ─────────────────────────────────────────────────────────────────────────────
// The running example — a Widget record and its handlers.
// ─────────────────────────────────────────────────────────────────────────────

interface Widget {
	id: string;
	name: string;
	parts?: string[];
	ownerId?: string;
}
interface NewWidget {
	name: string;
	parts?: string[];
}

declare function loadWidget(id: string, expand: ('parts' | 'owner')[] | undefined): Promise<Widget>;
declare function createWidget(data: NewWidget): Promise<Widget>;

// (1) The untyped baseline — a bare object is already a valid resource, and
// `satisfies` alone catches verb typos (no wrapper needed). Note the casts: the
// untyped world's tax.
const Widget = {
	path: '/widget/:id',
	async get(target) {
		return loadWidget(String(target.id), undefined);
	},
	async post(_target, data) {
		return createWidget(data as NewWidget);
	},
} satisfies ResourceMethods;

// (2) The schema-enforced version — same shape, inferred handlers, no casts.
const StrictWidget = enforceSchema(
	{
		path: '/widget/:id',
		record: schemaOf<Widget>(),
		get: { query: { expand: s.arrayOf(s.enumOf(['parts', 'owner'])).optional } },
		post: { body: schemaOf<NewWidget>(), response: schemaOf<Widget>() },
	},
	{
		async get(target) {
			// target.id: string (from ':id') · target.get('expand'): ('parts'|'owner')[] | undefined
			return loadWidget(target.id, target.get('expand'));
		},
		async post(_target, data) {
			// data: NewWidget (declared body) — no cast
			return createWidget(data);
		},
	}
);

// (3) Wrapping a PRE-EXISTING resource (the review-thread sketch): the untyped
// `Widget` object drops straight in — extra members are fine on a non-literal —
// and callers of `StricterWidget` see the narrowed signatures.
const StricterWidget = enforceSchema({ path: '/widget/:id', record: schemaOf<Widget>(), get: {}, post: {} }, Widget);

// (4) Class statics are the same shape — one mechanism covers both idioms.
class WidgetClass {
	static path = '/widget/:id';
	static async get(target: RequestTargetLike) {
		return loadWidget(String(target.id), undefined);
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Type-level assertions — a green tsc run is the proof.
// ─────────────────────────────────────────────────────────────────────────────

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
type Extends<A, B> = A extends B ? true : false;

// THE SUBSET CLAIM — the enforced resources are drop-in replacements for the
// untyped shape (and so is a class with static verbs). No new types demanded
// anywhere downstream.
const asPlain: ResourceMethods = StrictWidget;
type _dropin_strict = Expect<Extends<typeof StrictWidget, ResourceMethods>>;
type _dropin_wrapped = Expect<Extends<typeof StricterWidget, ResourceMethods>>;
type _dropin_class = Expect<Extends<typeof WidgetClass, ResourceMethods>>;

// The narrowed target: path param typed, declared query param typed, everything
// else falls back to the plain URLSearchParams contract, built-in grammar intact.
type StrictGetTarget = Parameters<(typeof StrictWidget)['get']>[0];
type _id_narrowed = Expect<Equal<StrictGetTarget['id'], string>>;
declare const strictTarget: StrictGetTarget;
const expanded = strictTarget.get('expand');
type _query_typed = Expect<Equal<typeof expanded, ('parts' | 'owner')[] | undefined>>;
const fallback = strictTarget.get('anything-else');
type _query_fallback = Expect<Equal<typeof fallback, string | null>>;
type _grammar_intact = Expect<Equal<StrictGetTarget['limit'], number | undefined>>;

// Wildcard paths type too.
type _wildcard = Expect<Equal<PathParams<'/files/*path'>, { path: string }>>;
type _multi = Expect<Equal<PathParams<'/widget/:id/rev/:n'>, { id: string } & PathParams<'/rev/:n'>>>;

// The record default: `get` with no declared response returns the record type.
type _get_response = Expect<Extends<ReturnType<(typeof StricterWidget)['get']>, MaybePromise<Widget>>>;

// ─────────────────────────────────────────────────────────────────────────────
// Negative cases — each MUST be an error, or tsc fails.
// ─────────────────────────────────────────────────────────────────────────────

// A bare object catches verb typos with `satisfies` alone (the discoverability answer).
// @ts-expect-error 'gwt' is not a resource verb — flagged at the definition site
const TypoWidget = { path: '/widget/:id', async gwt(target: RequestTargetLike) {} } satisfies ResourceMethods;

// A contract-declared verb missing from the impl (e.g. misspelled) is an error.
const MissingVerb = enforceSchema(
	{ path: '/w/:id', record: schemaOf<Widget>(), get: {}, put: {} },
	// @ts-expect-error contract declares `put`; the impl does not provide it
	{
		async get(target) {
			return loadWidget(target.id, undefined);
		},
	}
);

// An impl verb the contract does NOT declare is rejected on an inline literal.
const UndeclaredVerb = enforceSchema(
	{ path: '/w/:id', record: schemaOf<Widget>(), get: {} },
	{
		async get(target) {
			return loadWidget(target.id, undefined);
		},
		// @ts-expect-error 'gwt' is not declared in the contract — typo caught
		async gwt(target: RequestTargetLike) {},
	}
);

// A handler that breaks the declared response contract is an error.
const BadResponse = enforceSchema(
	{ path: '/w/:id', record: schemaOf<Widget>(), get: { response: schemaOf<{ ok: boolean }>() } },
	{
		// @ts-expect-error handler returns Widget; the contract promises { ok: boolean }
		async get(target) {
			return loadWidget(target.id, undefined);
		},
	}
);

// Keep the runtime values referenced so this type-checks as a module.
export { enforceSchema, s, schemaOf, Widget, StrictWidget, StricterWidget, WidgetClass, asPlain };
export type { Contract, ImplFor, TypedTarget, PathParams, RequestTargetLike, ResourceMethods };
