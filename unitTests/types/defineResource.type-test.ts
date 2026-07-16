/**
 * Type-contract test for the request contract (`defineResource` / `Resource.withSchema`).
 *
 * Asserts the SHIPPED public types (imported from the built package) against the contract: inferred
 * handler signatures, the narrowed `RequestTarget` (path param typed, declared query typed, fallback +
 * built-in grammar intact), the drop-in/subset property, the record default, and the negative cases.
 * It imports the build output so this strict tsconfig checks only the declaration surface
 * (skipLibCheck), not the whole repo graph.
 *
 * Run (after `npm run build`):  npm run test:types
 * A green run IS the proof; `@ts-expect-error` lines prove the negative cases.
 */

/* eslint-disable @typescript-eslint/no-unused-vars */

import { defineResource, t, schemaOf } from '../../dist/index.js';

type MaybePromise<T> = T | Promise<T>;

// The untyped resource shape a component can export today — the drop-in target the enforced resource
// must remain assignable to (verbs are bivariant methods, same variance DOM handlers rely on).
interface RequestTargetLike {
	id?: string | number;
	limit?: number;
	get(name: string): string | null;
}
interface ResourceMethods {
	path?: string;
	get?(target: RequestTargetLike): unknown;
	post?(target: RequestTargetLike, data: unknown): unknown;
}

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

// (1) The schema-enforced version — inferred handlers, no casts.
const StrictWidget = defineResource(
	{
		path: '/widget/:id',
		record: schemaOf<Widget>(),
		get: { query: { expand: t.array(t.enum(['parts', 'owner'])).optional } },
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

// (2) Wrapping the record default: `get` with no declared response returns the record type.
const StricterWidget = defineResource(
	{ path: '/widget/:id', record: schemaOf<Widget>(), get: {} },
	{
		async get(target) {
			return loadWidget(target.id, undefined);
		},
	}
);

// ── Type-level assertions (green tsc == proof) ──────────────────────────────
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
type Extends<A, B> = A extends B ? true : false;

// THE SUBSET CLAIM — the enforced resource is a drop-in replacement for the untyped shape.
const asPlain: ResourceMethods = StrictWidget;
type _dropin = Expect<Extends<typeof StrictWidget, ResourceMethods>>;

// The narrowed target: path param typed, declared query typed, fallback + built-in grammar intact.
type StrictGetTarget = Parameters<(typeof StrictWidget)['get']>[0];
type _id_narrowed = Expect<Equal<StrictGetTarget['id'], string>>;
declare const strictTarget: StrictGetTarget;
const expanded = strictTarget.get('expand');
type _query_typed = Expect<Equal<typeof expanded, ('parts' | 'owner')[] | undefined>>;
const fallback = strictTarget.get('anything-else');
type _query_fallback = Expect<Equal<typeof fallback, string | null>>;
type _grammar_intact = Expect<Equal<StrictGetTarget['limit'], number | undefined>>;

// The record default flows through `get`'s response.
type _get_response = Expect<Extends<ReturnType<(typeof StricterWidget)['get']>, MaybePromise<Widget>>>;

// The declared body is inferred without a cast.
type StrictPostBody = Parameters<(typeof StrictWidget)['post']>[1];
type _body_typed = Expect<Equal<StrictPostBody, NewWidget>>;

// ── Negative cases — each MUST be an error, or tsc fails ─────────────────────

// A contract-declared verb missing from the impl (e.g. misspelled) is an error.
const MissingVerb = defineResource(
	{ path: '/w/:id', record: schemaOf<Widget>(), get: {}, put: {} },
	// @ts-expect-error contract declares `put`; the impl does not provide it
	{
		async get(target) {
			return loadWidget(target.id, undefined);
		},
	}
);

// An impl verb the contract does NOT declare is rejected on an inline literal.
const UndeclaredVerb = defineResource(
	{ path: '/w/:id', record: schemaOf<Widget>(), get: {} },
	{
		async get(target) {
			return loadWidget(target.id, undefined);
		},
		// @ts-expect-error 'gwt' is not declared in the contract — typo caught
		async gwt(target) {},
	}
);

// A handler that breaks the declared response contract is an error.
const BadResponse = defineResource(
	{ path: '/w/:id', record: schemaOf<Widget>(), get: { response: schemaOf<{ ok: boolean }>() } },
	{
		// @ts-expect-error handler returns Widget; the contract promises { ok: boolean }
		async get(target) {
			return loadWidget(target.id, undefined);
		},
	}
);

export { StrictWidget, StricterWidget, asPlain };
