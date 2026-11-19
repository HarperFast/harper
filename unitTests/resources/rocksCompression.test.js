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

	// Not "unset so the build default applies": unset inherits the column family's persisted
	// codec and only falls back to the build default when the family does not exist yet, so an
	// upgraded database would keep writing uncompressed despite storage.compression being true.
	it('maps enabled to an explicit codec so upgraded databases honor it', function () {
		assert.strictEqual(toRocksCompression(true), 'lz4');
	});

	it('leaves unset unset (internal DBIs keep the build default)', function () {
		assert.strictEqual(toRocksCompression(undefined), undefined);
	});

	it('maps LMDB-era option objects to an explicit codec (they mean enabled, not a codec choice)', function () {
		assert.strictEqual(toRocksCompression({ startingOffset: 32, threshold: 4036 }), 'lz4');
	});

	it('leaves an explicit rocksdb-js request alone', function () {
		const request = { algorithm: 'zstd', level: 3 };
		assert.strictEqual(toRocksCompression(request), request);
	});

	it('passes through explicit algorithm names', function () {
		assert.strictEqual(toRocksCompression('zstd'), 'zstd');
	});
});
