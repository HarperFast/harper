// Regression guard for the rocksdb-js 2.6 upgrade (HarperFast/harper#2036): persisted table
// metadata carries LMDB-era compression values (false/'' = explicitly disabled, true/object =
// enabled with defaults). rocksdb-js >= 2.6 validates the `compression` option strictly — a
// bare '' or boolean throws ("Unsupported compression algorithm") — and treats UNSET as "use
// the build default (lz4)", so disabled values must be mapped to 'none' before they reach a
// RocksDB open.
const assert = require('node:assert');
const { toRocksCompression } = require('#src/resources/databases');

describe('toRocksCompression', function () {
	it('maps explicitly disabled values to none', function () {
		assert.strictEqual(toRocksCompression(false), 'none');
		assert.strictEqual(toRocksCompression(''), 'none');
		assert.strictEqual(toRocksCompression(null), 'none');
		assert.strictEqual(toRocksCompression(0), 'none');
	});

	it('maps true to unset so the build default applies', function () {
		assert.strictEqual(toRocksCompression(true), undefined);
	});

	it('leaves unset unset (internal DBIs keep the build default)', function () {
		assert.strictEqual(toRocksCompression(undefined), undefined);
	});

	it('passes through LMDB-era option objects (rocksdb-js treats a missing algorithm as unset)', function () {
		const legacyOptions = { startingOffset: 32, threshold: 4036 };
		assert.strictEqual(toRocksCompression(legacyOptions), legacyOptions);
	});

	it('passes through explicit algorithm names', function () {
		assert.strictEqual(toRocksCompression('zstd'), 'zstd');
	});
});

// HARPER_STORAGE_ROCKS_COMPRESSION selects one codec for every column family the process opens.
// It is read once at module load, so these assert the resolved value rather than re-resolving:
// re-reading per open is what makes the main thread and its workers disagree, and a disagreement
// is unrecoverable — RocksDB refuses to reopen a column family under a different codec.
describe('ROCKS_COMPRESSION', function () {
	it('is unset when the environment does not select a codec, leaving the build default (lz4)', function () {
		if (process.env.HARPER_STORAGE_ROCKS_COMPRESSION) return this.skip();
		const { ROCKS_COMPRESSION } = require('#src/resources/databases');
		assert.strictEqual(ROCKS_COMPRESSION, undefined);
	});

	it('takes precedence over per-table metadata so every column family agrees', function () {
		const { ROCKS_COMPRESSION } = require('#src/resources/databases');
		// openRocksDatabase resolves `ROCKS_COMPRESSION ?? toRocksCompression(metadata)`. With no
		// override the metadata mapping decides; with one, it wins over even an explicit
		// LMDB-era "disabled", which would otherwise open that CF as 'none' while the rest of
		// the process used the configured codec.
		const resolve = (metadata) => ROCKS_COMPRESSION ?? toRocksCompression(metadata);
		if (ROCKS_COMPRESSION === undefined) {
			assert.strictEqual(resolve(false), 'none');
			assert.strictEqual(resolve(undefined), undefined);
		} else {
			assert.strictEqual(resolve(false), ROCKS_COMPRESSION);
			assert.strictEqual(resolve(undefined), ROCKS_COMPRESSION);
		}
	});
});
