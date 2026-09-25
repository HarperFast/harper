'use strict';

// A table loaded only from its catalog (a system table, or any table after a restart before its schema is
// re-declared) evicts by what __dbis__ says, on whichever engine it runs.

const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { waitFor } = require('../waitFor');
const { table } = require('#src/resources/databases');
const manageThreads = require('#js/server/threads/manageThreads');

const RECORD_PRUNING_INTERVAL = 60_000;

describe('@expiresAt eviction survives a catalog load', function () {
	this.timeout(30000);

	before(() => {
		setupTestDBPath();
		// the expiry sweep runs on worker 0
		manageThreads.setMainIsWorker(true);
	});

	after(() => {
		manageThreads.setMainIsWorker(false);
	});

	function declare(tableName, expiresAtAttribute) {
		return table({
			table: tableName,
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'expiresAt', ...expiresAtAttribute }, { name: 'note' }],
		});
	}

	it('persists @expiresAt added to an already-indexed attribute, without rebuilding the index', async () => {
		const Indexed = declare('ExpiresAtFlagAdded', { indexed: true });
		await Indexed.put({ id: 1, expiresAt: Date.now() - 1000 });
		await Indexed.indexingOperation;
		const buildBefore = Indexed.indexingOperation;

		declare('ExpiresAtFlagAdded', { indexed: true, expiresAt: true });

		assert.strictEqual(Indexed.dbisDB.getSync('ExpiresAtFlagAdded/expiresAt').expiresAt, true);
		assert.strictEqual(Indexed.indexingOperation, buildBefore);
	});

	it('persists removing @expiresAt', () => {
		const Flagged = declare('ExpiresAtFlagRemoved', { indexed: true, expiresAt: true });
		assert.strictEqual(Flagged.dbisDB.getSync('ExpiresAtFlagRemoved/expiresAt').expiresAt, true);

		declare('ExpiresAtFlagRemoved', { indexed: true });

		assert.strictEqual(Flagged.dbisDB.getSync('ExpiresAtFlagRemoved/expiresAt').expiresAt, undefined);
	});

	it('the expiry sweep evicts expired records and keeps the rest', async () => {
		const originalSetInterval = global.setInterval;
		let sweep;
		global.setInterval = (callback, delay, ...args) => {
			if (delay === RECORD_PRUNING_INTERVAL) sweep = callback;
			return originalSetInterval(callback, delay, ...args);
		};
		let Expiring;
		try {
			Expiring = declare('ExpiresAtSweep', { indexed: true, expiresAt: true });
		} finally {
			global.setInterval = originalSetInterval;
		}
		assert(sweep, 'declaring an @expiresAt table on worker 0 arms the expiry sweep');
		await Expiring.put({ id: 'spent-1', expiresAt: Date.now() - 2000 });
		await Expiring.put({ id: 'spent-2', expiresAt: Date.now() - 1000 });
		await Expiring.put({ id: 'in-window', expiresAt: Date.now() + 3_600_000 });

		await sweep();

		await waitFor(
			() => !Expiring.primaryStore.getEntry('spent-1')?.value && !Expiring.primaryStore.getEntry('spent-2')?.value,
			{
				timeout: 10000,
				message: 'the sweep did not evict the expired records',
			}
		);
		assert.strictEqual(Expiring.primaryStore.getEntry('in-window')?.value?.id, 'in-window');
	});
});
