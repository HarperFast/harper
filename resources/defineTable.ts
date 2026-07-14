/**
 * Code-first schema authoring (`defineTable` + `types`), the canonical model.
 *
 * The dev names exactly ONE thing — `Track` (singular). `defineTable` eagerly registers the
 * table through the same `table()` factory GraphQL drives (`resources/databases.ts`) and returns
 * the live, registered class: `Track.get/put/post/patch/update/query/search` work immediately,
 * `new Track()` / `instanceof Track` hold, and every per-verb shape is a *projection* inferred
 * from the one definition, discoverable as members (`Track.$record`, `Track.$insert`, …) — never
 * a parallel name.
 *
 * The anchoring constraint (`--conditions=typestrip`): runtime metadata is carried as values;
 * TypeScript types are *derived* from those values. Everything here is erasable syntax — the
 * values survive type-stripping, the types are inferred, nothing can drift.
 *
 * Both authoring front-ends compile to the same typeDef shape (`{ table, database, attributes,
 * properties, schemaDefined }`), so DDL/migration semantics are shared rather than reimplemented.
 * Relationships take a lazy thunk (`types.relation(() => Album, { from: 'albumId' })`); the
 * target class is resolved on first use (the same late-binding contract GraphQL's
 * `connectPropertyType` relies on — `definition` must exist at registration, `definition.tableClass`
 * only by query time), so forward references and cycles between tables just work AT RUNTIME.
 *
 * A truly MUTUAL pair (`Book.author` -> `Author`, `Author.books` -> `Book`) is a different problem
 * at the TYPE level: TypeScript's const-initializer inference is eager, so `typeof Book` and
 * `typeof Author` end up depending on each other and both collapse to `any` (TS7022). `relationOf`
 * / `hasManyOf` are the escape hatch — see their doc comments below.
 */

import { table, type Table } from './databases.ts';
import { attributeToFragment } from './jsonSchemaTypes.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Field model — phantom-typed Field. Flags are set via GETTER PROPERTIES (no call):
// `string.indexed` / `id.primaryKey` / `date.createdTime` narrow the type-level flags.
// Only arg-taking builders (`enum([...])`, `relation(() => T)`) remain calls.
// ─────────────────────────────────────────────────────────────────────────────

export interface Flags {
	nullable?: boolean;
	primaryKey?: boolean;
	serverManaged?: boolean; // @createdTime / @updatedTime — never client-writable
	indexed?: boolean; // queryable in the filter grammar
	relation?: 'one' | 'many';
}

/**
 * A schema field. `_ts`/`_flags` are phantom type carriers (never present at runtime); the
 * flag getters return a fresh field with the flag applied at both the value and type level.
 */
export interface Field<TS, F extends Flags = {}> {
	readonly _ts: TS;
	readonly _flags: F;
	readonly kind: string;
	readonly meta: Record<string, unknown>;
	readonly nullable: Field<TS, F & { nullable: true }>;
	readonly indexed: Field<TS, F & { indexed: true }>;
	readonly primaryKey: Field<TS, F & { primaryKey: true }>;
}

/** Date additionally carries the server-managed timestamp flags. */
export interface DateField<F extends Flags = {}> extends Field<Date, F> {
	readonly createdTime: Field<Date, F & { serverManaged: true }>;
	readonly updatedTime: Field<Date, F & { serverManaged: true }>;
}

/** The read-record type of a related table handle. */
type RecordOf<T> = T extends { readonly $record: infer R } ? R : never;

// to-one resolves to the related record; to-many to an array of it.
export type RelationField<Target, Card extends 'one' | 'many'> = Field<
	Card extends 'many' ? RecordOf<Target>[] : RecordOf<Target>,
	{ relation: Card }
>;

// Runtime builders — getters return FRESH fields (immutable chaining; no shared-state bug).
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
	return Object.defineProperties(makeField('Date', meta), {
		createdTime: {
			get: () => makeField('Date', { ...meta, assignCreatedTime: true }),
			enumerable: true,
			configurable: true,
		},
		updatedTime: {
			get: () => makeField('Date', { ...meta, assignUpdatedTime: true }),
			enumerable: true,
			configurable: true,
		},
	});
}

/**
 * The field vocabulary the dev destructures: `const { id, string, int, date } = types`.
 * Pure-flag builders are values (getter chains); only arg-taking builders stay functions.
 * Every member mirrors a GraphQL directive/type so the two front-ends stay in lockstep.
 */
export const types = {
	id: makeField('ID') as Field<string>,
	string: makeField('String') as Field<string>,
	int: makeField('Int') as Field<number>,
	float: makeField('Float') as Field<number>,
	long: makeField('Long') as Field<number>,
	boolean: makeField('Boolean') as Field<boolean>,
	date: makeDateField() as DateField,
	bytes: makeField('Bytes') as Field<Uint8Array>,
	any: makeField('Any') as Field<unknown>,
	// Narrows the TS type to the literal union; stored as a String column. The narrowing is
	// advisory at runtime today (the shared Table.validate has no enum case — same as GraphQL);
	// the literal set is retained on the attribute for downstream surfaces.
	enum: <const E extends readonly string[]>(values: E) => makeField('String', { enum: values }) as Field<E[number]>,
	// many-to-one: this table holds the foreign key named `from`. Lazy thunk — forward refs are fine.
	relation: <T>(target: () => T, opts: { from: string }) =>
		makeField('relation', { target, from: opts.from }) as RelationField<T, 'one'>,
	// one-to-many: the related table holds the foreign key named `to`.
	hasMany: <T>(target: () => T, opts: { to: string }) =>
		makeField('relation', { target, to: opts.to }) as RelationField<T, 'many'>,
	/**
	 * `relation`'s escape hatch for a MUTUAL pair (`Book.author` <-> `Author.books`): TS's
	 * const-initializer inference is eager, so `typeof Book` and `typeof Author` would each depend
	 * on the other and both collapse to `any` (TS7022) if both sides used `relation`/`hasMany`.
	 * `relationOf<R>` breaks the cycle — `target` is typed `() => any` (no inference is pulled from
	 * the argument), and the related RECORD shape is supplied explicitly via `<R>`. Declare a small
	 * interface for the record once, on whichever side of the pair you close second; the runtime
	 * behavior (lazy thunk, resolved on first query-time use) is identical to `relation`.
	 */
	relationOf: <R>(target: () => any, opts: { from: string }) =>
		makeField('relation', { target, from: opts.from }) as RelationField<{ readonly $record: R }, 'one'>,
	/** `hasMany`'s escape hatch for a mutual pair — see `relationOf`. */
	hasManyOf: <R>(target: () => any, opts: { to: string }) =>
		makeField('relation', { target, to: opts.to }) as RelationField<{ readonly $record: R }, 'many'>,
};

export type Shape = Record<string, Field<any, any>>;

// ─────────────────────────────────────────────────────────────────────────────
// Flag predicates
// ─────────────────────────────────────────────────────────────────────────────

type TsOf<F> = F extends Field<infer TS, any> ? TS : never;
type FlagsOf<F> = F extends Field<any, infer Fl> ? Fl : {};
type IsNullable<F> = FlagsOf<F> extends { nullable: true } ? true : false;
type IsPrimaryKey<F> = FlagsOf<F> extends { primaryKey: true } ? true : false;
type IsServerManaged<F> = FlagsOf<F> extends { serverManaged: true } ? true : false;
type IsIndexed<F> = FlagsOf<F> extends { indexed: true } ? true : false;
type IsRelation<F> = FlagsOf<F> extends { relation: 'one' | 'many' } ? true : false;
/** Server-managed and relation fields are read-only on the record. */
type IsReadOnly<F> = IsServerManaged<F> extends true ? true : IsRelation<F>;

// Flatten an intersection of mapped types into one object, preserving readonly/optional modifiers.
type Resolve<T> = { [K in keyof T]: T[K] };

// ─────────────────────────────────────────────────────────────────────────────
// The projections — every one derived from the SAME shape S.
//   nullable field  -> optional property
//   serverManaged / relation -> present on reads (readonly), absent on all writes
//   primaryKey      -> required to read back / upsert, optional to insert, never patched
// ─────────────────────────────────────────────────────────────────────────────

/** The record's data fields: server-managed/relations readonly, others mutable; nullable -> optional. */
type RecordData<S> = Resolve<
	{
		readonly [K in keyof S as IsReadOnly<S[K]> extends true ? K : never]: TsOf<S[K]>;
	} & {
		[K in keyof S as IsReadOnly<S[K]> extends false ? (IsNullable<S[K]> extends false ? K : never) : never]: TsOf<S[K]>;
	} & {
		[K in keyof S as IsReadOnly<S[K]> extends false ? (IsNullable<S[K]> extends true ? K : never) : never]?: TsOf<S[K]>;
	}
>;

// A field is client-writable unless the server manages it or it is a relation projection.
type WritableOf<S> = {
	[K in keyof S as IsServerManaged<S[K]> extends false ? (IsRelation<S[K]> extends false ? K : never) : never]: S[K];
};

/** INSERT (POST): writable fields; PK OPTIONAL (server can generate it); nullable -> optional. */
type InsertOf<S, W = WritableOf<S>> = Resolve<
	{
		[K in keyof W as IsPrimaryKey<W[K]> extends false ? (IsNullable<W[K]> extends false ? K : never) : never]: TsOf<
			W[K]
		>;
	} & {
		[K in keyof W as IsPrimaryKey<W[K]> extends true ? K : IsNullable<W[K]> extends true ? K : never]?: TsOf<W[K]>;
	}
>;

/** UPSERT (PUT): full replace — writable fields, PK REQUIRED (you're naming the row). */
type UpsertOf<S, W = WritableOf<S>> = Resolve<
	{
		[K in keyof W as IsNullable<W[K]> extends false ? K : never]: TsOf<W[K]>;
	} & {
		[K in keyof W as IsNullable<W[K]> extends true ? K : never]?: TsOf<W[K]>;
	}
>;

/** PATCH: partial update — every writable non-PK field optional. */
type PatchOf<S, W = WritableOf<S>> = Resolve<{
	[K in keyof W as IsPrimaryKey<W[K]> extends true ? never : K]?: TsOf<W[K]>;
}>;

/** QUERY / filter: indexed fields only, all optional (the base filter grammar keys to these). */
type QueryOf<S> = Resolve<{
	[K in keyof S as IsIndexed<S[K]> extends true ? K : never]?: TsOf<S[K]>;
}>;

/** The read-only response variant — the whole record, nothing writable. */
type ReadVariant<S> = Readonly<RecordData<S>>;

/** The LIVE instance — what `new Track()` / `Track.update()` yield; writable fields mutable. */
type InstanceOf<S> = RecordData<S>;

/** The primary-key property and its value type (falls back to string|number when none declared). */
type PkKey<S> = { [K in keyof S]: IsPrimaryKey<S[K]> extends true ? K : never }[keyof S];
type IdOf<S> = [PkKey<S>] extends [never] ? string | number : TsOf<S[PkKey<S>]>;

type MaybePromise<T> = T | Promise<T>;

// The verbs retyped by the projections. Full query-grammar typing (conditions/sort/select keyed
// to the record) is future typed-query-behavior work — here only inputs/outputs are narrowed.
interface TypedVerbs<S extends Shape> {
	get(id: IdOf<S>, context?: any): MaybePromise<ReadVariant<S> | undefined>;
	put(record: UpsertOf<S>, context?: any): MaybePromise<unknown>;
	post(record: InsertOf<S>, context?: any): MaybePromise<unknown>;
	patch(id: IdOf<S>, changes: PatchOf<S>, context?: any): MaybePromise<unknown>;
	update(id: IdOf<S>, updates?: PatchOf<S>, context?: any): MaybePromise<InstanceOf<S>>;
	delete(id: IdOf<S>, context?: any): MaybePromise<unknown>;
	search(query?: any, context?: any): AsyncIterable<ReadVariant<S>>;
	query(query?: any, context?: any): AsyncIterable<ReadVariant<S>>;
}

/**
 * The single canonical handle `defineTable` returns: the registered table class, with
 *   • the verbs typed by the projections,
 *   • phantom `$*` members so each projection is discoverable as `(typeof Track)['$insert']`,
 *   • a construct signature so `Track` doubles as the instance type via `InstanceType<typeof Track>`.
 */
export type TableHandle<S extends Shape = Shape> = Omit<
	Table,
	'get' | 'put' | 'post' | 'patch' | 'update' | 'delete' | 'search' | 'query'
> &
	TypedVerbs<S> & {
		// phantom projection carriers — discovery surface, zero runtime cost
		readonly $record: ReadVariant<S>;
		readonly $insert: InsertOf<S>;
		readonly $upsert: UpsertOf<S>;
		readonly $patch: PatchOf<S>;
		readonly $query: QueryOf<S>;
	} & (new (...args: any[]) => InstanceOf<S>);

// ─────────────────────────────────────────────────────────────────────────────
// Compilation & registration
// ─────────────────────────────────────────────────────────────────────────────

/** `@table` directive parity — options GraphQL can declare on a type, plus the database. */
export interface DefineTableOptions {
	/** Database (schema) the table lives in; defaults to the `data` database. */
	database?: string;
	audit?: boolean;
	replicate?: boolean;
	sealed?: boolean;
	expiration?: number;
	eviction?: number;
	scanInterval?: number;
	splitSegments?: boolean;
	trackDeletes?: boolean;
	randomAccessFields?: boolean;
}

function memoize<T>(fn: () => T): () => T {
	let value: T;
	let resolved = false;
	return () => {
		if (!resolved) {
			value = fn();
			resolved = true;
		}
		return value;
	};
}

/**
 * Compile a shape into the same `{ table, database, attributes, properties }` typeDef
 * `resources/graphql.ts` builds, so registration takes the identical `table()` path.
 *
 * Nullability parity: GraphQL leaves plain fields' `nullable` undefined and marks `!` fields
 * `nullable: false` (it never emits `nullable: true`). We map identically — `.nullable` leaves
 * the attribute unmarked, everything else writable is `nullable: false` — so fragments AND
 * validation semantics match. PK and server-managed fields stay unmarked (the PK machinery and
 * server assignment own their presence; marking them required would reject valid writes).
 *
 * Relations resolve lazily: `definition` exists at registration (the resolver-build contract in
 * Table.ts) but its `tableClass` getter defers the thunk to first use, by which time the target
 * is defined — forward references and cycles are safe.
 */
function compileTypeDef(name: string, shape: Shape, options: DefineTableOptions): any {
	const attributes: any[] = [];
	const properties: Record<string, any> = {};
	const declared = new Set(Object.keys(shape));

	for (const [attrName, f] of Object.entries(shape) as [string, any][]) {
		const meta = f.meta ?? {};
		if (f.kind === 'relation') {
			const resolveClass = memoize(meta.target as () => any);
			// The definition mirrors what GraphQL's connectPropertyType attaches (the target
			// typeDef): `type` and `attributes` feed OpenAPI's includeDefinitionInSchema (so the
			// emitted $ref component is always defined), `tableClass` feeds the query-time
			// resolvers. All lazy — read only after every table is defined.
			const definition = {};
			Object.defineProperty(definition, 'tableClass', { get: resolveClass, enumerable: true, configurable: true });
			Object.defineProperty(definition, 'type', {
				get: () => resolveClass().tableName,
				enumerable: true,
				configurable: true,
			});
			Object.defineProperty(definition, 'attributes', {
				get: () => resolveClass().attributes,
				enumerable: true,
				configurable: true,
			});
			let attr: any;
			if (meta.from) {
				// many-to-one: this table holds the foreign key. Like GraphQL, the FK must be a
				// declared field — that makes it typed, projected into `properties`, and writable
				// in $insert/$upsert (the relation itself is a read-only projection).
				if (!declared.has(meta.from)) {
					throw new Error(
						`Table "${name}": relation "${attrName}" references foreign key "${meta.from}", which must be declared in the shape (e.g. \`${meta.from}: id.indexed\`)`
					);
				}
				attr = { name: attrName, relationship: { from: meta.from } };
				Object.defineProperty(attr, 'type', {
					get: () => resolveClass().tableName,
					enumerable: true,
					configurable: true,
				});
				// non-enumerable, mirroring GraphQL's connectPropertyType
				Object.defineProperty(attr, 'definition', { value: definition, configurable: true });
			} else {
				// one-to-many: the related table holds the foreign key
				const elements: any = {};
				Object.defineProperty(elements, 'type', {
					get: () => resolveClass().tableName,
					enumerable: true,
					configurable: true,
				});
				Object.defineProperty(elements, 'definition', { value: definition, configurable: true });
				attr = { name: attrName, type: 'array', relationship: { to: meta.to }, elements };
			}
			attributes.push(attr);
			// fragment reads the lazy `type`, so project it lazily too (memoized — cold surface)
			let fragment: any;
			Object.defineProperty(properties, attrName, {
				get: () => (fragment ??= attributeToFragment(attr)),
				enumerable: true,
				configurable: true,
			});
			continue;
		}
		const attr: any = { name: attrName, type: f.kind };
		if (meta.primaryKey) attr.isPrimaryKey = true;
		if (meta.indexed) attr.indexed = true;
		if (meta.assignCreatedTime) attr.assignCreatedTime = true;
		if (meta.assignUpdatedTime) attr.assignUpdatedTime = true;
		if (meta.enum) attr.enum = meta.enum; // enum -> String column, literal set retained for downstream surfaces
		if (!meta.nullable && !meta.primaryKey && !meta.assignCreatedTime && !meta.assignUpdatedTime) attr.nullable = false; // required, like GraphQL `!`
		attributes.push(attr);
		properties[attrName] = attributeToFragment(attr);
	}

	const { database, ...tableOptions } = options;
	// `schemaDefined: true` matches @table so the existing-Table re-assert in `table()` fires on
	// every reload (DDL parity: added/removed attributes and index changes are applied).
	return {
		table: name,
		type: name,
		database: database ?? 'data',
		attributes,
		properties,
		schemaDefined: true,
		...tableOptions,
	};
}

/**
 * Declare AND register a table from a TypeScript value. Eager: the returned value is the live,
 * registered table class (the same class `tables.<Name>` holds), typed by the shape — the import
 * IS the typed handle. Defining the same table again re-asserts the schema (add/remove attributes,
 * index changes) through the same evolution path GraphQL reloads take.
 */
export function defineTable<S extends Shape>(name: string, shape: S, options: DefineTableOptions = {}): TableHandle<S> {
	const typeDef = compileTypeDef(name, shape, options);
	const tableClass = table(typeDef);
	typeDef.tableClass = tableClass;
	return tableClass as TableHandle<S>;
}
