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
