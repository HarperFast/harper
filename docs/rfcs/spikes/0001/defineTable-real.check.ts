/**
 * RFC 0001 — canonical-track contract, enforced against the REAL `defineTable` implementation.
 *
 * canonical-track.spike.ts proved the type mechanics on a self-contained stub; this file asserts
 * the shipped module (`resources/defineTable.ts`, via the built package types) satisfies the same
 * contract: the `$record`/`$insert`/`$upsert`/`$patch`/`$query` projections, getter-style field
 * flags, and the negative cases. It imports the build output so this strict spike tsconfig checks
 * only the declaration surface (skipLibCheck), not the whole repo graph.
 *
 * Verify (after `npm run build`):
 *   npx tsc --noEmit --project docs/rfcs/spikes/0001/tsconfig.json
 * A green run IS the proof; `@ts-expect-error` lines prove the negative cases.
 */

/* eslint-disable @typescript-eslint/no-unused-vars */

import { defineTable, types } from '../../../../dist/index.js';

const { id, int, string, date } = types;

// NOTE: defineTable registers eagerly, so this module is type-check-only (never executed) —
// exactly like the spike, whose runtime lived in the registration test.
const Track = defineTable('Track', {
	id: id.primaryKey,
	name: string.indexed,
	duration: int.nullable,
	status: types.enum(['draft', 'published']).indexed,
	createdTime: date.createdTime,
});

// `Track` stays the central type; variants are derived off it as members.
type Track = InstanceType<typeof Track>;
type TrackRecord = (typeof Track)['$record'];
type InsertTrack = (typeof Track)['$insert'];
type UpsertTrack = (typeof Track)['$upsert'];
type PatchTrack = (typeof Track)['$patch'];
type TrackQuery = (typeof Track)['$query'];

// ── Type-level assertions (green tsc == proof) ──────────────────────────────
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

// The read-only variant: every field readonly, server-managed present.
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

// Relations: to-one resolves to the related read record (readonly), to-many to an array; both
// are dropped from every write projection. A to-one relation's FK must be DECLARED in the shape
// (like GraphQL), which makes it typed, queryable, and writable — the relation itself is not.
const Album = defineTable('Album', {
	id: id.primaryKey,
	title: string,
	tracks: types.hasMany(() => Track, { to: 'albumId' }),
});
type AlbumRecord = (typeof Album)['$record'];
type _album_record = Expect<
	Equal<AlbumRecord, { readonly id: string; readonly title: string; readonly tracks: TrackRecord[] }>
>;
type _album_insert = Expect<Equal<(typeof Album)['$insert'], { title: string; id?: string }>>;

const Song = defineTable('Song', {
	id: id.primaryKey,
	title: string,
	albumId: id.indexed, // declared FK — typed and writable
	album: types.relation(() => Album, { from: 'albumId' }),
});
type _song_record = Expect<
	Equal<
		(typeof Song)['$record'],
		{ readonly id: string; readonly title: string; readonly albumId: string; readonly album: AlbumRecord }
	>
>;
// the declared FK is insertable/patchable; the relation projection is not
type _song_insert = Expect<Equal<(typeof Song)['$insert'], { title: string; albumId: string; id?: string }>>;
type _song_query = Expect<Equal<(typeof Song)['$query'], { albumId?: string }>>;

// Verbs are typed by the projections (await-friendly MaybePromise results).
async function verbs() {
	const ro = await Track.get('DtMF');
	if (ro) {
		ro.name.toUpperCase(); //          read ok
		ro.createdTime.getFullYear(); //   server field present on reads
	}
	await Track.post({ name: 'Intro', status: 'draft' }); //                       id generated, createdTime server-set
	await Track.put({ id: 'DtMF', name: 'Intro', status: 'published' }); //        PK required for replace
	await Track.patch('DtMF', { status: 'published' }); //                         partial
	const live = await Track.update('DtMF', { duration: 75 }); //                  live instance
	live.name = 'Renamed'; //                                                      writable field — mutable
}

// Explicit-typed forms, to show the projections stand alone too:
const toInsert: InsertTrack = { name: 'New Album', status: 'draft', duration: 50 };
const toReplace: UpsertTrack = { id: 'DtMF', name: 'New Album', status: 'draft' };
const toPatch: PatchTrack = { duration: 75 };
const filter: TrackQuery = { name: 'Intro' };

// ── Negative cases — each MUST error, or tsc fails ──────────────────────────
declare const ro: TrackRecord;
declare const live: Track;
// @ts-expect-error the read-only variant cannot be mutated
ro.name = 'nope';
// @ts-expect-error server-managed field is readonly even on the live instance
live.createdTime = new Date();
// @ts-expect-error server-managed field is not insertable
const bad_insert: InsertTrack = { name: 'x', status: 'draft', createdTime: new Date() };
// @ts-expect-error upsert requires the primary key
const bad_upsert: UpsertTrack = { name: 'x', status: 'draft' };
// @ts-expect-error 'archived' is not in the enum
const bad_enum: PatchTrack = { status: 'archived' };
// @ts-expect-error duration is not indexed, so it is not a query key
const bad_query: TrackQuery = { duration: 50 };
// @ts-expect-error relations are not writable
const bad_album: (typeof Album)['$insert'] = { title: 'x', tracks: [] };

export { Track, Album, toInsert, toReplace, toPatch, filter, verbs };
