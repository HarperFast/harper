/**
 * RFC 0001 — Spike (b): `t` builder + `defineTable` type inference.
 *
 * GOAL: prove the *type mechanics* of code-first schema authoring, in isolation,
 * under the repo's compiler settings (NodeNext, erasableSyntaxOnly). This file is
 * self-contained — it defines its own minimal `t`/`defineTable` so the inference can
 * be proven without wiring into the runtime. Spike (c) does the runtime registration.
 *
 * What this proves:
 *   1. `Select<typeof Table>` infers the read record — enum -> literal union,
 *      nullable -> optional, relation -> related record (to-one) / array (to-many),
 *      server-managed fields -> `readonly`.
 *   2. `Insert<typeof Table>` drops primary key + server-managed + relations, keeps
 *      writable fields, preserves optionality.
 *   3. Wrong values (excess primary key / server field, off-enum literal) are rejected.
 *
 * Verify:  npx tsc --noEmit --project docs/rfcs/spikes/0001/tsconfig.json
 * A green run IS the proof. The `@ts-expect-error` lines prove the negative cases:
 * if any stops being an error, tsc fails.
 */

/* eslint-disable @typescript-eslint/no-unused-vars */

// ─────────────────────────────────────────────────────────────────────────────
// Field flags & the phantom-typed Field
// ─────────────────────────────────────────────────────────────────────────────

interface Flags {
	nullable?: boolean;
	primaryKey?: boolean;
	serverManaged?: boolean; // @createdTime / @updatedTime / @computed
	readonly?: boolean;
	relation?: 'one' | 'many';
}

/**
 * A schema field. `_ts` and `_flags` are phantom type carriers (never present at
 * runtime); the chainable methods narrow the flags at the type level.
 */
interface Field<TS, F extends Flags = {}> {
	readonly _ts: TS;
	readonly _flags: F;
	readonly kind: string;
	readonly meta: Record<string, unknown>;
	nullable(): Field<TS, F & { nullable: true }>;
	indexed(): Field<TS, F>;
	primaryKey(): Field<TS, F & { primaryKey: true }>;
}

// to-one resolves to the related record; to-many to an array of it.
type RelationField<Target, Card extends 'one' | 'many'> = Field<
	Card extends 'many' ? Select<Target>[] : Select<Target>,
	{ relation: Card; readonly: true }
>;

// ─────────────────────────────────────────────────────────────────────────────
// Runtime builder (intentionally thin — Spike (c) reuses this to feed `table()`)
// ─────────────────────────────────────────────────────────────────────────────

function field(kind: string, meta: Record<string, unknown> = {}): any {
	return {
		kind,
		meta,
		nullable() {
			return field(kind, { ...meta, nullable: true });
		},
		indexed() {
			return field(kind, { ...meta, indexed: true });
		},
		primaryKey() {
			return field(kind, { ...meta, primaryKey: true });
		},
	};
}

const t = {
	id: () => field('ID') as Field<string>,
	string: () => field('String') as Field<string>,
	int: () => field('Int') as Field<number>,
	float: () => field('Float') as Field<number>,
	boolean: () => field('Boolean') as Field<boolean>,
	date: () => field('Date') as Field<Date>,
	enum: <const E extends readonly string[]>(values: E) => field('String', { enum: values }) as Field<E[number]>,
	createdTime: () => field('Date', { assignCreatedTime: true }) as Field<Date, { serverManaged: true; readonly: true }>,
	updatedTime: () => field('Date', { assignUpdatedTime: true }) as Field<Date, { serverManaged: true; readonly: true }>,
	relation: <T>(target: () => T, opts: { from: string }) =>
		field('relation', { target, ...opts }) as RelationField<T, 'one'>,
	hasMany: <T>(target: () => T, opts: { to: string }) =>
		field('relation', { target, ...opts }) as RelationField<T, 'many'>,
};

type Shape = Record<string, Field<any, any>>;
interface TableDef<S extends Shape> {
	name: string;
	shape: S;
}

// NOTE: no `const` type parameter here. A `const S` would infer the shape's
// properties as `readonly`, and the homomorphic `[K in keyof S]` mapped types below
// would copy that `readonly` onto every output field. Enum literal tuples are
// preserved by `t.enum`'s own `const` parameter, so we don't need it here.
function defineTable<S extends Shape>(name: string, shape: S): TableDef<S> {
	return { name, shape };
}

// ─────────────────────────────────────────────────────────────────────────────
// The inference: Select (read) and Insert (write) derived from the shape
// ─────────────────────────────────────────────────────────────────────────────

type TsOf<F> = F extends Field<infer TS, any> ? TS : never;
type FlagsOf<F> = F extends Field<any, infer Fl> ? Fl : {};

type IsNullable<F> = FlagsOf<F> extends { nullable: true } ? true : false;
type IsReadonly<F> = FlagsOf<F> extends { readonly: true } ? true : false;
type IsPrimaryKey<F> = FlagsOf<F> extends { primaryKey: true } ? true : false;
type IsServerManaged<F> = FlagsOf<F> extends { serverManaged: true } ? true : false;
type IsRelation<F> = FlagsOf<F> extends { relation: 'one' | 'many' } ? true : false;

// Flatten an intersection of mapped types into one object, preserving readonly/optional.
// (Homomorphic `in keyof T` copies the readonly/optional modifiers from the source.)
type Resolve<T> = { [K in keyof T]: T[K] };

/** The read record: every field, with nullable -> optional and server-managed -> readonly. */
type Select<T> =
	T extends TableDef<infer S>
		? Resolve<
				{
					[K in keyof S as IsReadonly<S[K]> extends false
						? IsNullable<S[K]> extends false
							? K
							: never
						: never]: TsOf<S[K]>;
				} & {
					[K in keyof S as IsReadonly<S[K]> extends false
						? IsNullable<S[K]> extends true
							? K
							: never
						: never]?: TsOf<S[K]>;
				} & {
					readonly [K in keyof S as IsReadonly<S[K]> extends true
						? IsNullable<S[K]> extends false
							? K
							: never
						: never]: TsOf<S[K]>;
				} & {
					readonly [K in keyof S as IsReadonly<S[K]> extends true
						? IsNullable<S[K]> extends true
							? K
							: never
						: never]?: TsOf<S[K]>;
				}
			>
		: never;

/** A field is writable on insert unless it is the PK, server-managed, or a relation. */
type Writable<F> = IsPrimaryKey<F> extends true
	? false
	: IsServerManaged<F> extends true
		? false
		: IsRelation<F> extends true
			? false
			: true;

/** The insert record: writable fields only, optionality preserved. */
type Insert<T> =
	T extends TableDef<infer S>
		? Resolve<
				{
					[K in keyof S as Writable<S[K]> extends true
						? IsNullable<S[K]> extends false
							? K
							: never
						: never]: TsOf<S[K]>;
				} & {
					[K in keyof S as Writable<S[K]> extends true
						? IsNullable<S[K]> extends true
							? K
							: never
						: never]?: TsOf<S[K]>;
				}
			>
		: never;

// ─────────────────────────────────────────────────────────────────────────────
// Example schema (the RFC's running example)
// ─────────────────────────────────────────────────────────────────────────────

const Albums = defineTable('Albums', {
	id: t.id().primaryKey(),
	title: t.string(),
});

const Tracks = defineTable('Tracks', {
	id: t.id().primaryKey(),
	name: t.string().indexed(),
	duration: t.int().nullable(),
	status: t.enum(['draft', 'published']),
	createdAt: t.createdTime(),
	album: t.relation(() => Albums, { from: 'albumId' }), // to-one -> Album record
});

// to-many demo (acyclic: Tags has no back-reference to Posts)
const Tags = defineTable('Tags', {
	id: t.id().primaryKey(),
	label: t.string(),
});

const Posts = defineTable('Posts', {
	id: t.id().primaryKey(),
	title: t.string(),
	tags: t.hasMany(() => Tags, { to: 'postId' }), // to-many -> Tag[]
});

// ─────────────────────────────────────────────────────────────────────────────
// Type-level assertions — a green tsc run is the proof
// ─────────────────────────────────────────────────────────────────────────────

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

type Track = Select<typeof Tracks>;
type NewTrack = Insert<typeof Tracks>;
type Post = Select<typeof Posts>;

// (1) Read record: enum union, nullable->optional, relation->record, server->readonly
type _assert_track = Expect<
	Equal<
		Track,
		{
			id: string;
			name: string;
			status: 'draft' | 'published';
			duration?: number;
			readonly createdAt: Date;
			readonly album: { id: string; title: string };
		}
	>
>;

// (2) Insert record: PK + server-managed + relation dropped, optionality kept
type _assert_new_track = Expect<
	Equal<
		NewTrack,
		{
			name: string;
			status: 'draft' | 'published';
			duration?: number;
		}
	>
>;

// (3) to-many relation resolves to an array of the related record
type _assert_post = Expect<
	Equal<
		Post,
		{
			id: string;
			title: string;
			readonly tags: { id: string; label: string }[];
		}
	>
>;

// Positive: a minimal valid insert (duration optional, server/PK/relation absent)
const okInsert: NewTrack = { name: 'Intro', status: 'draft' };

// Negative cases — each MUST be an error, or tsc fails:
// @ts-expect-error primary key is not part of the insert type
const bad_pk: NewTrack = { name: 'x', status: 'draft', id: '1' };
// @ts-expect-error 'archived' is not in the enum
const bad_enum: NewTrack = { name: 'x', status: 'archived' };
// @ts-expect-error createdAt is server-managed, not writable on insert
const bad_server: NewTrack = { name: 'x', status: 'draft', createdAt: new Date() };
// @ts-expect-error name is required
const bad_missing: NewTrack = { status: 'draft' };

// Keep the runtime values referenced so this also type-checks as a module.
export { t, defineTable, Albums, Tracks, Tags, Posts, okInsert };
export type { Select, Insert, Field, TableDef };
