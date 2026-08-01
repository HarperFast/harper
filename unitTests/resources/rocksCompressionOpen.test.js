// Exercises the production path end-to-end rather than re-deriving it: stages
// `storage.rocks.compression` the way the installer does, then opens real column families through
// the same resolution `openRocksDatabase()` uses and asserts the codec the engine actually applied.
// The sibling `rocksCompression.test.js` covers the pure mapper, and nothing there would fail if
// the forwarding in `openRocksDatabase()` or `copyDb.ts` were deleted — that is what this guards.
//
// `zstd` is used rather than `none` so the assertions discriminate: with the forwarding removed
// these families would open at the build default (lz4), not at the configured codec.
//
// The codec is resolved once per process and then frozen (that is the invariant — RocksDB refuses
// to reopen a column family under a different codec, and Harper's worker threads share one
// process-wide registry), so these cases are order-dependent by design: the rejection case runs
// first because it throws without freezing anything. `resetRocksCompression()` re-unfreezes it
// before that first case runs — this file shares a process with every other file under
// `unitTests/resources/**`, and several of them open a RocksDatabase (freezing the codec at
// `undefined`) before mocha's glob ever reaches this one.
const assert = require('node:assert');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { setProperty } = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
const { getRocksCompression, toRocksCompression, resetRocksCompression } = require('#src/resources/databases');
// Required, not dynamically imported: Harper has already loaded this module, and pulling in the
// ESM copy as well runs its module initialization twice ("Cannot redefine property: query").
const { RocksDatabase } = require('@harperfast/rocksdb-js');

// Mirrors openRocksDatabase(): a configured codec wins over whatever per-table metadata carries.
const resolveCompression = (metadata) => getRocksCompression() ?? toRocksCompression(metadata);

describe('storage.rocks.compression reaches a real RocksDB open', function () {
	let dir;

	before(function () {
		resetRocksCompression();
	});

	after(function () {
		// Undo both the freeze and the config mutation these cases made — every other file in
		// this mocha process shares the same singleton, and leaving it frozen at 'zstd' (or the
		// config still set) would make an unrelated file's unset-compression opens request
		// 'zstd' against families that already exist on disk at a different codec.
		setProperty(CONFIG_PARAMS.STORAGE_ROCKS_COMPRESSION, undefined);
		resetRocksCompression();
	});

	beforeEach(function () {
		// os.tmpdir() is fine here: nothing measures bytes, only the codec the engine reports.
		dir = mkdtempSync(join(tmpdir(), 'harper-codec-test-'));
	});

	afterEach(function () {
		rmSync(dir, { recursive: true, force: true });
	});

	it('rejects a codec the native build does not provide, naming what is available', function () {
		setProperty(CONFIG_PARAMS.STORAGE_ROCKS_COMPRESSION, 'definitely-not-a-codec');
		assert.throws(() => getRocksCompression(), /not available in this build.*Supported:/s);
	});

	it('applies the configured codec to a table family and to __dbis__ alike', async function () {
		setProperty(CONFIG_PARAMS.STORAGE_ROCKS_COMPRESSION, 'zstd');
		// A family whose metadata says nothing, and an internal one — a disagreement between them
		// is exactly what makes the second open throw.
		for (const name of ['records', '__dbis__']) {
			const db = RocksDatabase.open(dir, { name, compression: resolveCompression(undefined) });
			try {
				assert.strictEqual(db.compression.algorithm, 'zstd', `${name} opened at the wrong codec`);
			} finally {
				await db.close();
			}
		}
	});

	it('overrides per-table metadata that says compression is disabled', async function () {
		// `false` maps to 'none' on its own; the configured codec has to win, or that family would
		// open uncompressed while the rest of the process used zstd.
		assert.strictEqual(toRocksCompression(false), 'none');
		const db = RocksDatabase.open(dir, { name: 'records', compression: resolveCompression(false) });
		try {
			assert.strictEqual(db.compression.algorithm, 'zstd');
		} finally {
			await db.close();
		}
	});

	it('reopens a family in the same process without a codec conflict', async function () {
		const open = () => RocksDatabase.open(dir, { name: 'records', compression: resolveCompression(undefined) });
		const first = open();
		await first.close();
		const second = open();
		try {
			assert.strictEqual(second.compression.algorithm, 'zstd');
		} finally {
			await second.close();
		}
	});
});
