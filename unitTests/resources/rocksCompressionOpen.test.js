const assert = require('node:assert');
const { mkdirSync, rmSync } = require('node:fs');
const { setProperty } = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
const { setupTestDBPath } = require('../testUtils');
const {
	database,
	closeDatabase,
	getRocksCompression,
	resolveDatabasePath,
	toRocksCompression,
	resetRocksCompression,
} = require('#src/resources/databases');
const { RocksDatabase } = require('@harperfast/rocksdb-js');

describe('storage.rocks.compression reaches a real RocksDB open', function () {
	let dir;
	let databaseName;

	before(function () {
		setupTestDBPath();
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
		databaseName = 'compression-open-' + Date.now() + '-' + Math.random().toString(36).slice(2);
		dir = resolveDatabasePath(databaseName);
		mkdirSync(dir, { recursive: true });
	});

	afterEach(function () {
		closeDatabase(databaseName);
		rmSync(dir, { recursive: true, force: true });
	});

	it('rejects a codec the native build does not provide, naming what is available', function () {
		setProperty(CONFIG_PARAMS.STORAGE_ROCKS_COMPRESSION, 'definitely-not-a-codec');
		assert.throws(() => getRocksCompression(), /not available in this build.*Supported:/s);
	});

	it('applies the configured codec to a directly opened family and to __dbis__ alike', async function () {
		setProperty(CONFIG_PARAMS.STORAGE_ROCKS_COMPRESSION, 'zstd');
		for (const name of ['records', '__dbis__']) {
			const db = RocksDatabase.open(dir, { name, compression: getRocksCompression() });
			try {
				assert.strictEqual(db.compression.algorithm, 'zstd', `${name} opened at the wrong codec`);
			} finally {
				await db.close();
			}
		}
	});

	it('resolves the configured codec alongside disabled per-table metadata', async function () {
		assert.strictEqual(toRocksCompression(false), 'none');
		const db = RocksDatabase.open(dir, { name: 'records', compression: getRocksCompression() });
		try {
			assert.strictEqual(db.compression.algorithm, 'zstd');
		} finally {
			await db.close();
		}
	});

	it('reopens a family in the same process without a codec conflict', async function () {
		const open = () => RocksDatabase.open(dir, { name: 'records', compression: getRocksCompression() });
		const first = open();
		await first.close();
		const second = open();
		try {
			assert.strictEqual(second.compression.algorithm, 'zstd');
		} finally {
			await second.close();
		}
	});

	it('adopts the codec for an unmentioned sibling through the production open path', async function () {
		const sibling = RocksDatabase.open(dir, { name: 'sibling', compression: 'none' });
		await sibling.close();

		setProperty(CONFIG_PARAMS.STORAGE_ROCKS_COMPRESSION, 'none');
		resetRocksCompression();
		const initial = database({ database: databaseName });
		assert.strictEqual(initial.compression.algorithm, 'none');
		closeDatabase(databaseName);

		setProperty(CONFIG_PARAMS.STORAGE_ROCKS_COMPRESSION, 'zstd');
		resetRocksCompression();
		const upgraded = database({ database: databaseName });
		assert.strictEqual(upgraded.compression.algorithm, 'zstd');
		closeDatabase(databaseName);

		const reopenedSibling = RocksDatabase.open(dir, { name: 'sibling' });
		try {
			assert.strictEqual(reopenedSibling.compression.algorithm, 'zstd');
		} finally {
			await reopenedSibling.close();
		}
	});
});
