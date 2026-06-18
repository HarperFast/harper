/**
 * Coverage for the canonical index-option comparison that gates secondary-index rebuilds
 * (issue #1357).
 *
 * table() decides whether to rebuild a secondary index by comparing the new attribute's index
 * options against the persisted descriptor's. Previously that comparison used a raw JSON.stringify,
 * which is sensitive to option key order and string-vs-number scalars — so a representation-only
 * difference (e.g. `@indexed(...)` records options in source order as strings, while the operations
 * API can supply them reordered or as numbers) forced a needless full rebuild, 503-ing the attribute
 * for the duration. canonicalizeIndexOptions() sorts keys and coerces numeric-looking string scalars
 * so a semantically-identical index is recognized as unchanged. It is deliberately conservative: it
 * must NEVER mask a genuine change.
 *
 * Two layers of coverage:
 *  - unit: canonicalizeIndexOptions() against the issue's exact test matrix + conservative edges.
 *  - wiring: a live HNSW index reload — a reordered / string-vs-number option does not re-trigger a
 *    backfill, while a genuine option change does.
 */
require('../testUtils');
const assert = require('node:assert/strict');
const { setupTestDBPath } = require('../testUtils');
const { table, resetDatabases, canonicalizeIndexOptions } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

// Mirror how databases.ts uses the canonicalizer (canonicalIndexKey): structural equality is
// "the canonical forms stringify identically".
const sameStructure = (a, b) =>
	JSON.stringify(canonicalizeIndexOptions(a)) === JSON.stringify(canonicalizeIndexOptions(b));

describe('canonicalizeIndexOptions structural comparison (#1357)', () => {
	it('treats key-order and string-vs-number differences as NOT structurally changed', () => {
		// The issue's matrix case 1.
		assert.equal(sameStructure({ type: 'HNSW', M: '16' }, { M: 16, type: 'HNSW' }), true);
		// key order alone
		assert.equal(sameStructure({ a: 1, b: 2 }, { b: 2, a: 1 }), true);
		// string-vs-number alone
		assert.equal(sameStructure({ M: '16' }, { M: 16 }), true);
		// recurses into nested option objects
		assert.equal(
			sameStructure({ type: 'HNSW', opts: { b: '2', a: 1 } }, { opts: { a: '1', b: 2 }, type: 'HNSW' }),
			true
		);
		// floats and arrays of scalars
		assert.equal(sameStructure({ optimizeRouting: '0.6' }, { optimizeRouting: 0.6 }), true);
		assert.equal(sameStructure({ dims: ['1', '2'] }, { dims: [1, 2] }), true);
	});

	it('treats a genuine option change as structurally changed', () => {
		// The issue's matrix case 2.
		assert.equal(sameStructure({ type: 'HNSW', M: 16 }, { type: 'HNSW', M: 32 }), false);
		// The issue's matrix case 3: boolean vs object is a real change (do not collapse).
		assert.equal(sameStructure(true, { type: 'HNSW' }), false);
		// Conservative: absent-vs-present is NOT coalesced with defaults — adding/removing an option rebuilds.
		assert.equal(sameStructure({ type: 'HNSW' }, { type: 'HNSW', M: 16 }), false);
		// type value differs (non-numeric strings are compared verbatim, case-sensitive)
		assert.equal(sameStructure({ type: 'HNSW' }, { type: 'hnsw' }), false);
	});

	it('does not over-coerce: only genuinely numeric strings become numbers', () => {
		// "16abc" is not numeric-looking -> stays a string -> differs from the number 16
		assert.equal(sameStructure({ M: '16abc' }, { M: 16 }), false);
		// empty string must not coerce to 0
		assert.equal(sameStructure({ x: '' }, { x: 0 }), false);
		// booleans and numeric-looking strings are distinct (no boolean coercion)
		assert.equal(sameStructure({ flag: true }, { flag: 'true' }), false);
		// zero must NOT coerce: string "0" is truthy but number 0 is falsy, and index code branches on
		// truthiness (e.g. HNSW `if (this.optimizeRouting)` doubles maxConnections) — so these build
		// structurally different indexes and must remain a genuine change. (cross-model review, #1357)
		assert.equal(sameStructure({ optimizeRouting: '0' }, { optimizeRouting: 0 }), false);
		assert.equal(canonicalizeIndexOptions('0'), '0');
		assert.equal(canonicalizeIndexOptions('0.0'), '0.0');
		// non-zero numeric strings still coerce (both forms are truthy and numerically identical)
		assert.equal(sameStructure({ optimizeRouting: '0.6' }, { optimizeRouting: 0.6 }), true);
		// the canonical form of a scalar is the scalar; whitespace-padded numerics still coerce
		assert.equal(canonicalizeIndexOptions('16'), 16);
		assert.equal(canonicalizeIndexOptions(' 16 '), 16);
		assert.equal(canonicalizeIndexOptions('HNSW'), 'HNSW');
		assert.equal(canonicalizeIndexOptions(true), true);
	});
});

// The per-attribute descriptor is persisted in Table.dbisDB keyed by the attribute's internal key;
// find it by name rather than reconstructing the key format.
function findDescriptor(Tbl, attrName) {
	for (const { value } of Tbl.dbisDB.getRange({ start: false })) {
		if (value && value.name === attrName) return value;
	}
	return null;
}

describe('index rebuild gating: representation-only options do not re-trigger a backfill (#1357)', () => {
	if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return; // HNSW custom index is RocksDB-only here

	const DB = 'test';
	const N = 8;

	// Build an HNSW index over existing rows, then reload with various option representations. A
	// re-trigger is detected by table() installing a NEW indexingOperation promise (the promise
	// carries across resetDatabases, so identity — not truthiness — is the reliable signal; cf.
	// indexRestartNumber.test.js).
	function reload(TABLE, indexedOption) {
		resetDatabases();
		return table({
			table: TABLE,
			database: DB,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'vector', indexed: indexedOption, type: 'Array' },
			],
		});
	}

	it('skips the rebuild for reordered / string-vs-number options and rebuilds on a real change', async () => {
		const TABLE = 'CanonOpts';
		setupTestDBPath();
		setMainIsWorker(true);

		// Seed rows with vectors, no index yet.
		let Tbl = table({
			table: TABLE,
			database: DB,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'vector', type: 'Array' },
			],
		});
		let last;
		for (let i = 0; i < N; i++) last = Tbl.put({ id: i, vector: [i % 2, i % 3, i % 4] });
		await last;

		// First build of the HNSW index over the existing rows.
		Tbl = reload(TABLE, { type: 'HNSW', M: 16 });
		const buildOp = Tbl.indexingOperation;
		assert.ok(buildOp, 'adding @indexed over existing rows should schedule a backfill');
		await buildOp;

		// Reordered keys: raw JSON differs, canonical form is identical -> NO rebuild.
		const reordered = reload(TABLE, { M: 16, type: 'HNSW' });
		assert.equal(reordered.indexingOperation, buildOp, 'reordered index options must NOT re-trigger a backfill');

		// String-vs-number scalar: canonical form identical -> NO rebuild.
		const stringly = reload(TABLE, { type: 'HNSW', M: '16' });
		assert.equal(stringly.indexingOperation, buildOp, 'string-vs-number index options must NOT re-trigger a backfill');

		// Genuine option change (M: 16 -> 32) -> rebuild.
		const changed = reload(TABLE, { type: 'HNSW', M: 32 });
		assert.notEqual(changed.indexingOperation, buildOp, 'a genuine option change must re-trigger a backfill');
		assert.ok(changed.indexingOperation, 'a genuine option change should install an indexingOperation');
		await changed.indexingOperation;

		// Descriptor self-heals to the latest raw form (persistence keys off the raw value).
		const desc = findDescriptor(changed, 'vector');
		assert.ok(desc, 'vector descriptor should exist after the rebuild');
		assert.equal(desc.indexed.M, 32, 'descriptor should persist the changed option');
	});
});
