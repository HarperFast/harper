'use strict';

require('../testUtils');
const assert = require('node:assert');
const fsPromises = require('node:fs/promises');
const { existsSync } = require('node:fs');
const { setupTestDBPath } = require('../testUtils');
const { closeDatabase, databases, resetDatabases, table } = require('#src/resources/databases');
const { ResourceBridge } = require('#src/dataLayer/harperBridge/ResourceBridge');

function withDeadline(promise, description) {
	let timer;
	return Promise.race([
		promise,
		new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error(`${description} did not settle`)), 10000);
		}),
	]).finally(() => clearTimeout(timer));
}

describe('LMDB environment close completion', function () {
	before(function () {
		if (process.env.HARPER_STORAGE_ENGINE !== 'lmdb') return this.skip();
		setupTestDBPath();
	});

	const definition = (databaseName) => ({
		table: 'Items',
		database: databaseName,
		attributes: [{ attribute: 'id', isPrimaryKey: true }],
	});

	// lmdb defers a close only on an environment that has not written, so reload the database to get one
	async function readOnlyTable(databaseName) {
		const Writer = table(definition(databaseName));
		await Writer.put({ id: 1, name: 'one' });
		await closeDatabase(databaseName);
		resetDatabases();
		return databases[databaseName].Items;
	}

	it('removes a dropped database file only after its environment has closed', async function () {
		this.timeout(30000);
		const databaseName = 'lmdbdropreadinflight';
		const Items = await readOnlyTable(databaseName);
		const rootStore = Items.primaryStore.rootStore;
		const close = rootStore.close;
		let closeDeferred;
		rootStore.close = function (...args) {
			Items.primaryStore.prefetch([1]);
			const result = close.apply(this, args);
			closeDeferred = rootStore.status === 'closing';
			return result;
		};
		const removals = [];
		const { rm, unlink } = fsPromises;
		const record = (remove) =>
			function (path, ...args) {
				if (path === rootStore.path) removals.push(rootStore.status);
				return remove.call(this, path, ...args);
			};
		fsPromises.rm = record(rm);
		fsPromises.unlink = record(unlink);
		try {
			await withDeadline(new ResourceBridge().dropSchema({ schema: databaseName }), 'the drop');
		} finally {
			fsPromises.rm = rm;
			fsPromises.unlink = unlink;
		}

		assert.strictEqual(closeDeferred, true, 'precondition: a read was in flight when the environment closed');
		assert.deepStrictEqual(removals, ['closed']);
		const Recreated = table(definition(databaseName));
		await withDeadline(Recreated.put({ id: 2, name: 'two' }), 'a write to the recreated database');
		assert.strictEqual(Recreated.primaryStore.get(1), undefined);
		assert.strictEqual(Recreated.primaryStore.get(2).name, 'two');
	});

	it('a close that overlaps one still waiting on a read resolves only once the environment has closed', async function () {
		this.timeout(30000);
		const databaseName = 'lmdbcloseoverlap';
		const Items = await readOnlyTable(databaseName);
		const rootStore = Items.primaryStore.rootStore;
		Items.primaryStore.prefetch([1]);
		const firstClose = rootStore.close();
		assert.strictEqual(rootStore.status, 'closing', 'precondition: the first close is waiting on the read');

		await withDeadline(closeDatabase(databaseName, { requireClosed: true }), 'the overlapping close');

		assert.strictEqual(rootStore.status, 'closed');
		await firstClose;
	});

	it('a drop that overlaps a close still waiting on a read removes the file', async function () {
		this.timeout(30000);
		const databaseName = 'lmdbdropoverlap';
		const Items = await readOnlyTable(databaseName);
		const rootStore = Items.primaryStore.rootStore;
		Items.primaryStore.prefetch([1]);
		const firstClose = rootStore.close();
		assert.strictEqual(rootStore.status, 'closing', 'precondition: the first close is waiting on the read');

		await withDeadline(new ResourceBridge().dropSchema({ schema: databaseName }), 'the drop');

		assert.strictEqual(rootStore.status, 'closed');
		assert.strictEqual(existsSync(rootStore.path), false);
		await firstClose;
	});
});
