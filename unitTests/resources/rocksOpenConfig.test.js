'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { setupTestDBPath, stubMethod } = require('../testUtils');
const { PID_DIR_PATH } = require('../perPidRoot.js');
const env = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
const { openRocksDatabase } = require('#src/resources/databases');
const { RocksDatabase, getWriteBufferManagerStats } = require('@harperfast/rocksdb-js');

// rocksdb-js releases before HarperFast/rocksdb-js#987 ignore both options.
const nativeSupport = typeof getWriteBufferManagerStats().flushPolicy === 'string';

function latestColumnFamilyOptions(databasePath) {
	const optionsFile = fs
		.readdirSync(databasePath)
		.filter((file) => /^OPTIONS-\d+$/.test(file))
		.sort((a, b) => Number(a.slice(8)) - Number(b.slice(8)))
		.at(-1);
	const arenaBlockSizes = new Map();
	let family;
	for (const line of fs.readFileSync(path.join(databasePath, optionsFile), 'utf8').split('\n')) {
		const section = /^\[CFOptions "(.*)"\]/.exec(line);
		if (section) family = section[1];
		else if (line.startsWith('[')) family = undefined;
		const arena = /^\s*arena_block_size=(\d+)/.exec(line);
		if (arena && family !== undefined) arenaBlockSizes.set(family, Number(arena[1]));
	}
	return arenaBlockSizes;
}

describe('openRocksDatabase storage.rocks config', function () {
	const priorValues = new Map();
	const openStores = [];
	let databasePath;

	before(function () {
		setupTestDBPath();
		for (const key of [
			CONFIG_PARAMS.STORAGE_ROCKS_ARENABLOCKSIZE,
			CONFIG_PARAMS.STORAGE_ROCKS_WRITEBUFFERMANAGERFLUSHPOLICY,
		]) {
			priorValues.set(key, env.get(key));
		}
	});

	beforeEach(function () {
		databasePath = path.join(PID_DIR_PATH, `rocks-open-config-${randomUUID()}`);
	});

	afterEach(function () {
		while (openStores.length) openStores.pop().close();
		fs.rmSync(databasePath, { recursive: true, force: true });
		for (const [key, value] of priorValues) env.setProperty(key, value);
	});

	function open(options) {
		const store = openRocksDatabase(databasePath, options);
		openStores.push(store);
		return store;
	}

	it('passes a configured arenaBlockSize to every store it opens', function () {
		env.setProperty(CONFIG_PARAMS.STORAGE_ROCKS_ARENABLOCKSIZE, 131072);
		const rootOptions = {};
		const familyOptions = { name: 'records' };
		const indexOptions = { name: 'records/index', dupSort: true };
		open(rootOptions);
		open(familyOptions);
		open(indexOptions);
		for (const options of [rootOptions, familyOptions, indexOptions])
			assert.strictEqual(options.arenaBlockSize, 131072);
		if (!nativeSupport) return;
		const families = ['default', 'records', 'records/index'];
		for (const family of families)
			assert.strictEqual(latestColumnFamilyOptions(databasePath).get(family), 131072, family);
		// a restart opens every existing family with the root, at the size configured then
		while (openStores.length) openStores.pop().close();
		env.setProperty(CONFIG_PARAMS.STORAGE_ROCKS_ARENABLOCKSIZE, 262144);
		open({});
		for (const family of families)
			assert.strictEqual(latestColumnFamilyOptions(databasePath).get(family), 262144, family);
	});

	it('leaves arenaBlockSize to rocksdb-js when unset or invalid', function () {
		for (const configured of [undefined, 0, -1, 'large']) {
			env.setProperty(CONFIG_PARAMS.STORAGE_ROCKS_ARENABLOCKSIZE, configured);
			const options = { name: `family-${String(configured)}` };
			open(options);
			assert.ok(!('arenaBlockSize' in options), String(configured));
		}
	});

	it('passes a configured writeBufferManagerFlushPolicy to RocksDatabase.config', function () {
		const configCalls = [];
		const originalConfig = RocksDatabase.config;
		// Recorded but not applied: rocksdb-js keeps an explicit policy for the life of the process.
		const restore = stubMethod(RocksDatabase, 'config', (config) => {
			configCalls.push(config);
			const { writeBufferManagerFlushPolicy: _policy, ...rest } = config;
			originalConfig.call(RocksDatabase, rest);
		});
		try {
			env.setProperty(CONFIG_PARAMS.STORAGE_ROCKS_WRITEBUFFERMANAGERFLUSHPOLICY, 'largestAcrossDBs');
			open({});
			env.setProperty(CONFIG_PARAMS.STORAGE_ROCKS_WRITEBUFFERMANAGERFLUSHPOLICY, undefined);
			open({ name: 'unset' });
			env.setProperty(CONFIG_PARAMS.STORAGE_ROCKS_WRITEBUFFERMANAGERFLUSHPOLICY, 'newest');
			open({ name: 'invalid' });
		} finally {
			restore();
		}
		assert.strictEqual(configCalls.length, 3);
		assert.strictEqual(configCalls[0].writeBufferManagerFlushPolicy, 'largestAcrossDBs');
		assert.ok(!('writeBufferManagerFlushPolicy' in configCalls[1]));
		assert.ok(!('writeBufferManagerFlushPolicy' in configCalls[2]));
	});
});
