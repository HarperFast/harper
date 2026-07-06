/**
 * RFC 0001 — Spike: ONE canonical `Track`, every request/response shape inferred from it.
 *
 * This answers the singular-vs-plural thread directly. The two positions reconcile:
 *
 *   • The dev names exactly ONE thing — `Track` (singular). It is the table they query
 *     and write through (`Track.get` / `Track.update` / `Track.put` / `Track.query`), AND
 *     it is the type of a live record: `let track: Track = Track.update(id)` — `track` is a
 *     mutable instance with `.save()`, and `track instanceof Track` is true. There is no
 *     second `Tracks` concept to teach, no when-to-pluralize rule.
 *
 *   • A table nonetheless presents DIFFERENT shapes per verb — what you respond with is not
 *     what you insert is not what you patch is not what you filter on. Those shapes are not
 *     separate hand-maintained concepts; they are *projections* inferred from the one `Track`
 *     definition (include/omit fields automatically), the precedent set by Prisma / Drizzle /
 *     Kysely. They live AS MEMBERS of the single canonical thing (`Track.$insert`, …), so
 *     discovery is `Track.` + autocomplete — never a parallel name.
 *
 * So `Track` itself stays the useful, central type (the live instance); the read-only and
 * write-side variants are derived off it:
 *
 *   type Track       = InstanceType<typeof Track>;     // live, mutable, has .save(); instanceof Track
 *   type TrackRecord = (typeof Track)['$record'];      // read-only variant (what get()/query() return)
 *   type InsertTrack = (typeof Track)['$insert'];      // POST body, etc.
 *
 * Field flags use the property/getter surface from the proposal (`id.primaryKey`, not
 * `id.primaryKey()`); only arg-taking builders (`enum([...])`) remain calls.
 *
 * Public API this spike emulates (defined locally so it type-checks standalone):
 *   import { defineTable, types } from 'harper';
 *   const { id, int, string, date } = types;
 *
 * Verify (repo settings: strict, NodeNext, erasableSyntaxOnly):
 *   npx tsc --noEmit --project docs/rfcs/spikes/0001/tsconfig.json
 * A green run IS the proof; `@ts-expect-error` lines prove the negative cases.
 */

/* eslint-disable @typescript-eslint/no-unused-vars */

// ─────────────────────────────────────────────────────────────────────────────
// Field model — phantom-typed Field. Flags are set via GETTER PROPERTIES (no call),
// so `string.indexed` / `id.primaryKey` / `int.nullable` narrow the type-level flags.
// ─────────────────────────────────────────────────────────────────────────────

interface Flags {
	nullable?: boolean;
	primaryKey?: boolean;
	serverManaged?: boolean; // @createdTime / @updatedTime / @computed — never client-writable
	indexed?: boolean; // queryable in the filter grammar
}

interface Field<TS, F extends Flags = {}> {
	readonly _ts: TS; // phantom carriers (never present at runtime)
	readonly _flags: F;
	readonly nullable: Field<TS, F & { nullable: true }>;
	readonly indexed: Field<TS, F & { indexed: true }>;
	readonly primaryKey: Field<TS, F & { primaryKey: true }>;
}

/** Date carries the server-managed timestamp flags in addition to the base getters. */
interface DateField<F extends Flags = {}> extends Field<Date, F> {
	readonly createdTime: Field<Date, F & { serverManaged: true }>;
	readonly updatedTime: Field<Date, F & { serverManaged: true }>;
}

// Runtime builder — getters return FRESH fields (immutable chaining; no shared-state bug).
function makeField(kind: string, meta: Record<string, unknown> = {}): any {
	return {
		kind,
		meta,
		get nullable() {
			return makeField(kind, { ...meta, nullable: true });
		},
		get indexed() {
			return makeField(kind, { ...meta, indexed: true });
		},
		get primaryKey() {
			return makeField(kind, { ...meta, primaryKey: true });
		},
	};
}
function makeDateField(meta: Record<string, unknown> = {}): any {
	return {
		kind: 'Date',
		meta,
		get nullable() {
			return makeField('Date', { ...meta, nullable: true });
		},
		get indexed() {
			return makeField('Date', { ...meta, indexed: true });
		},
		get primaryKey() {
			return makeField('Date', { ...meta, primaryKey: true });
		},
		get createdTime() {
			return makeField('Date', { ...meta, assignCreatedTime: true, serverManaged: true });
		},
		get updatedTime() {
			return makeField('Date', { ...meta, assignUpdatedTime: true, serverManaged: true });
		},
	};
}

// The `types` namespace the dev destructures. Pure-flag builders are values (getter chains);
// only arg-taking builders (enum) stay functions.
const types = {
	id: makeField('ID') as Field<string>,
	string: makeField('String') as Field<string>,
	int: makeField('Int') as Field<number>,
	float: makeField('Float') as Field<number>,
	boolean: makeField('Boolean') as Field<boolean>,
	date: makeDateField() as DateField,
	enum: (<const E extends readonly string[]>(values: E) => makeField('String', { enum: values }) as Field<E[number]>),
};

type Shape = Record<string, Field<any, any>>;

// ─────────────────────────────────────────────────────────────────────────────
// Flag predicates
// ─────────────────────────────────────────────────────────────────────────────

type TsOf<F> = F extends Field<infer TS, any> ? TS : never;
type FlagsOf<F> = F extends Field<any, infer Fl> ? Fl : {};
type IsNullable<F> = FlagsOf<F> extends { nullable: true } ? true : false;
type IsPrimaryKey<F> = FlagsOf<F> extends { primaryKey: true } ? true : false;
type IsServerManaged<F> = FlagsOf<F> extends { serverManaged: true } ? true : false;
type IsIndexed<F> = FlagsOf<F> extends { indexed: true } ? true : false;

type Resolve<T> = { [K in keyof T]: T[K] };

// ─────────────────────────────────────────────────────────────────────────────
// The projections — every one derived from the SAME shape S.
//   nullable field  -> optional property
//   serverManaged   -> present on reads (readonly), absent on all writes
//   primaryKey      -> required to read back / upsert, optional to insert, never patched
// ─────────────────────────────────────────────────────────────────────────────

/** The record's data fields: server-managed readonly, others mutable; nullable -> optional. */
type RecordData<S> = Resolve<
	{
		readonly [K in keyof S as IsServerManaged<S[K]> extends true ? K : never]: TsOf<S[K]>;
	} & {
		[K in keyof S as IsServerManaged<S[K]> extends false ? (IsNullable<S[K]> extends false ? K : never) : never]: TsOf<
			S[K]
		>;
	} & {
		[K in keyof S as IsServerManaged<S[K]> extends false ? (IsNullable<S[K]> extends true ? K : never) : never]?: TsOf<
			S[K]
		>;
	}
>;

// A field is client-writable unless the server manages it.
type Writable<S> = { [K in keyof S as IsServerManaged<S[K]> extends false ? K : never]: S[K] };

/** INSERT (POST): writable fields; PK OPTIONAL (server can generate it); nullable -> optional. */
type Insert<S, W = Writable<S>> = Resolve<
	{
		[K in keyof W as IsPrimaryKey<W[K]> extends false ? (IsNullable<W[K]> extends false ? K : never) : never]: TsOf<
			W[K]
		>;
	} & {
		// PK + nullable fields are optional on insert
		[K in keyof W as IsPrimaryKey<W[K]> extends true ? K : IsNullable<W[K]> extends true ? K : never]?: TsOf<W[K]>;
	}
>;

/** UPSERT (PUT): full replace — writable fields, PK REQUIRED (you're naming the row); nullable -> optional. */
type Upsert<S, W = Writable<S>> = Resolve<
	{
		[K in keyof W as IsNullable<W[K]> extends false ? K : never]: TsOf<W[K]>;
	} & {
		[K in keyof W as IsNullable<W[K]> extends true ? K : never]?: TsOf<W[K]>;
	}
>;

/** PATCH: partial update — every writable non-PK field optional. */
type Patch<S, W = Writable<S>> = Resolve<{
	[K in keyof W as IsPrimaryKey<W[K]> extends true ? never : K]?: TsOf<W[K]>;
}>;

/** QUERY / filter: indexed fields only, all optional (the base filter grammar keys to these). */
type Query<S> = Resolve<{
	[K in keyof S as IsIndexed<S[K]> extends true ? K : never]?: TsOf<S[K]>;
}>;

/** The read-only response variant — the whole record, nothing writable, no methods. */
type ReadVariant<S> = Readonly<RecordData<S>>;

/** The LIVE instance — mutable data + persistence methods. This is what `Track` (the type) is. */
type Methods = {
	save(): Promise<void>;
	delete(): Promise<void>;
};
type Instance<S> = RecordData<S> & Methods;

// ─────────────────────────────────────────────────────────────────────────────
// The single canonical handle. `defineTable` returns ONE value that is:
//   • a CONSTRUCTOR — so `new Track()` / `x instanceof Track` work and `Track` doubles as
//     the instance type via `InstanceType<typeof Track>`;
//   • the static verbs (get/query/update/post/put/patch) typed by the projections;
//   • phantom `$*` members so each projection is discoverable as `typeof Track['$insert']`.
// Phantom members are type-only (never assigned at runtime).
// ─────────────────────────────────────────────────────────────────────────────

interface TableStatics<S extends Shape> {
	// phantom projection carriers — discovery surface, zero runtime cost
	readonly $record: ReadVariant<S>;
	readonly $insert: Insert<S>;
	readonly $upsert: Upsert<S>;
	readonly $patch: Patch<S>;
	readonly $query: Query<S>;

	// reads return the read-only variant; writes return a live instance you can mutate + save()
	get(id: string): ReadVariant<S>;
	query(where: Query<S>): ReadVariant<S>[];
	update(id: string): Instance<S>;
	post(body: Insert<S>): Instance<S>;
	put(body: Upsert<S>): Instance<S>;
	patch(id: string, changes: Patch<S>): Instance<S>;
}

// The table value is both a constructor (for instanceof / the instance type) and the statics.
type TableConstructor<S extends Shape> = TableStatics<S> & (new () => Instance<S>);

function defineTable<S extends Shape>(name: string, shape: S): TableConstructor<S> {
	return {} as any; // runtime registration lives in defineTable-registration.test.js
}

// ─────────────────────────────────────────────────────────────────────────────
// The one canonical definition — singular name, property-style field flags.
// ─────────────────────────────────────────────────────────────────────────────

const { id, int, string, date } = types;

const Track = defineTable('Track', {
	id: id.primaryKey,
	name: string.indexed,
	duration: int.nullable,
	status: types.enum(['draft', 'published']).indexed, // arg-taking builder stays a call, then .indexed
	createdTime: date.createdTime, // auto-assigned, never client-writable
});

// `Track` stays the central type (the live instance). Variants are derived off it as members.
type Track = InstanceType<typeof Track>; //        live, mutable, has .save(); `track instanceof Track`
type TrackRecord = (typeof Track)['$record']; //   read-only variant (get()/query())
type InsertTrack = (typeof Track)['$insert'];
type UpsertTrack = (typeof Track)['$upsert'];
type PatchTrack = (typeof Track)['$patch'];
type TrackQuery = (typeof Track)['$query'];

// ─────────────────────────────────────────────────────────────────────────────
// Usage — one concept (`Track`), the right shape inferred per verb. All green.
// ─────────────────────────────────────────────────────────────────────────────

const track: Track = Track.update('DtMF'); // live instance
track.name = 'Renamed'; //                    writable field — mutable
void track.save(); //                         method present on the instance
const isTrack: boolean = track instanceof Track; // Track is a constructor -> true

const ro: TrackRecord = Track.get('DtMF'); //  read-only variant
ro.name.toUpperCase(); //                      read ok
ro.createdTime.getFullYear(); //               server field present on reads

const inserted = Track.post({ name: 'Intro', status: 'draft' }); // id generated, createdTime server-set
const upserted = Track.put({ id: 'DtMF', name: 'Intro', status: 'published' }); // PK required for replace
const patched = Track.patch('DtMF', { status: 'published' }); // partial
const published = Track.query({ status: 'published' }); //       filter on indexed fields

// Explicit-typed forms, to show the projections stand alone too:
const toInsert: InsertTrack = { name: 'New Album', status: 'draft', duration: 50 }; // no id, no createdTime
const toReplace: UpsertTrack = { id: 'DtMF', name: 'New Album', status: 'draft' };
const toPatch: PatchTrack = { duration: 75 };
const filter: TrackQuery = { name: 'Intro' };

// ── Type-level assertions (green tsc == proof) ──────────────────────────────
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

// `Track` (the instance) is mutable on writable fields, readonly on server-managed, has methods.
type _instance_save = Expect<Equal<ReturnType<Track['save']>, Promise<void>>>;

// The read-only variant: every field readonly, no methods.
type _record = Expect<
	Equal<
		TrackRecord,
		{
			readonly id: string;
			readonly name: string;
			readonly status: 'draft' | 'published';
			readonly createdTime: Date;
			readonly duration?: number;
		}
	>
>;
type _insert = Expect<
	Equal<
		InsertTrack,
		{ name: string; status: 'draft' | 'published'; id?: string; duration?: number } // PK optional, server field gone
	>
>;
type _upsert = Expect<
	Equal<
		UpsertTrack,
		{ id: string; name: string; status: 'draft' | 'published'; duration?: number } // PK required
	>
>;
type _patch = Expect<
	Equal<PatchTrack, { name?: string; status?: 'draft' | 'published'; duration?: number }> // all writable optional, no PK
>;
type _query = Expect<
	Equal<TrackQuery, { name?: string; status?: 'draft' | 'published' }> // indexed fields only (id/duration excluded)
>;

// ── Negative cases — each MUST error, or tsc fails ──────────────────────────
// @ts-expect-error the read-only variant cannot be mutated
ro.name = 'nope';
// @ts-expect-error server-managed field is readonly even on the live instance
track.createdTime = new Date();
// @ts-expect-error server-managed field is not insertable
const bad_insert: InsertTrack = { name: 'x', status: 'draft', createdTime: new Date() };
// @ts-expect-error upsert requires the primary key
const bad_upsert: UpsertTrack = { name: 'x', status: 'draft' };
// @ts-expect-error 'archived' is not in the enum
const bad_enum: PatchTrack = { status: 'archived' };
// @ts-expect-error duration is not indexed, so it is not a query key
const bad_query: TrackQuery = { duration: 50 };

export { Track, toInsert, toReplace, toPatch, filter };
export type { Track as TrackInstance, TrackRecord, InsertTrack, UpsertTrack, PatchTrack, TrackQuery };
