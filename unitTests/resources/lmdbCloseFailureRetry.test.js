'use strict';

require('../testUtils');
const assert = require('node:assert');
const { existsSync } = require('node:fs');
const { setupTestDBPath } = require('../testUtils');
const { closeDatabase, databases, table } = require('#src/resources/databases');
const { ResourceBridge } = require('#src/dataLayer/harperBridge/ResourceBridge');

describe('LMDB environment close retry after a failed close', function () {
	before(function () {
		if (process.env.HARPER_STORAGE_ENGINE !== 'lmdb') return this.skip();
		setupTestDBPath();
	});

	const definition = (databaseName) => ({
		table: 'Items',
		database: databaseName,
		attributes: [{ attribute: 'id', isPrimaryKey: true }],
	});

	async function loadedRootStore(databaseName) {
		const Items = table(definition(databaseName));
		await Items.put({ id: 1, name: 'one' });
		return Items.primaryStore.rootStore;
	}

	// lmdb's close() awaits _endWrites() before closing the environment, so a rejection there fails one close attempt
	function failEndWritesOnce(rootStore) {
		const endWrites = rootStore._endWrites;
		const attempts = { endWrites: 0 };
		rootStore._endWrites = function (...args) {
			if (++attempts.endWrites === 1) return Promise.reject(new Error('end writes failed'));
			return endWrites.apply(this, args);
		};
		return attempts;
	}

	it('a rejected close does not stop the next close from closing the environment', async function () {
		this.timeout(30000);
		const databaseName = 'lmdbclosefailureretry';
		const rootStore = await loadedRootStore(databaseName);
		const attempts = failEndWritesOnce(rootStore);

		await assert.rejects(rootStore.close(), /end writes failed/);
		assert.notStrictEqual(rootStore.status, 'closed');

		await rootStore.close();
		assert.ok(attempts.endWrites >= 2, 'the second close must run lmdb close again');
		assert.strictEqual(rootStore.status, 'closed');
		const callsAfterClose = attempts.endWrites;
		await rootStore.close();
		assert.strictEqual(attempts.endWrites, callsAfterClose, 'a close after a successful one is not repeated');
		await closeDatabase(databaseName);
	});

	it('a drop retried after a failed close finishes closing the environment and removes the file', async function () {
		this.timeout(30000);
		const databaseName = 'lmdbdropfailureretry';
		const rootStore = await loadedRootStore(databaseName);
		const attempts = failEndWritesOnce(rootStore);
		const bridge = new ResourceBridge();

		await assert.rejects(bridge.dropSchema({ schema: databaseName }));
		assert.strictEqual(existsSync(rootStore.path), true, 'a failed close must not remove the database file');

		await bridge.dropSchema({ schema: databaseName });
		assert.ok(attempts.endWrites >= 2, 'the retried drop must run lmdb close again');
		assert.strictEqual(rootStore.status, 'closed');
		assert.strictEqual(existsSync(rootStore.path), false);
		assert.strictEqual(databases[databaseName], undefined);
	});

	it('a strict close that failed is retried by the next drop', async function () {
		this.timeout(30000);
		const databaseName = 'lmdbstrictclosefailureretry';
		const rootStore = await loadedRootStore(databaseName);
		const attempts = failEndWritesOnce(rootStore);

		await assert.rejects(closeDatabase(databaseName, { requireClosed: true }), AggregateError);
		assert.notStrictEqual(rootStore.status, 'closed');
		const callsAfterFailure = attempts.endWrites;

		await new ResourceBridge().dropSchema({ schema: databaseName });
		assert.ok(attempts.endWrites > callsAfterFailure, 'the retry must run lmdb close again');
		assert.strictEqual(rootStore.status, 'closed');
		assert.strictEqual(existsSync(rootStore.path), false);
	});
});
