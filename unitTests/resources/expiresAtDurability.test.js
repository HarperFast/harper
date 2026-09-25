'use strict';

// A table loaded only from its catalog (a system table, or any table after a restart before its schema is
// re-declared) evicts by what __dbis__ says, on whichever engine it runs.

const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { waitFor } = require('../waitFor');
const { table, armLoadedExpirySweeps } = require('#src/resources/databases');
const manageThreads = require('#js/server/threads/manageThreads');

const RECORD_PRUNING_INTERVAL = 60_000;

describe('@expiresAt eviction survives a catalog load', function () {
	this.timeout(30000);

	before(() => {
		setupTestDBPath();
		// the expiry sweep runs on worker 0
		manageThreads.setMainIsWorker(true);
	});

	function declare(tableName, expiresAtAttribute) {
		return table({
			table: tableName,
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'expiresAt', ...expiresAtAttribute }, { name: 'note' }],
		});
	}

	// Runs `arm` and returns the expiry sweep callbacks it armed.
	function capturingSweeps(arm) {
		const originalSetInterval = global.setInterval;
		const sweeps = [];
		global.setInterval = (callback, delay, ...args) => {
			if (delay === RECORD_PRUNING_INTERVAL) sweeps.push(callback);
			return originalSetInterval(callback, delay, ...args);
		};
		try {
			const result = arm();
			return { result, sweeps };
		} finally {
			global.setInterval = originalSetInterval;
		}
	}

	function declareWithSweep(tableName) {
		const { result: Expiring, sweeps } = capturingSweeps(() => declare(tableName, { indexed: true, expiresAt: true }));
		assert.strictEqual(sweeps.length, 1, 'declaring an @expiresAt table on worker 0 arms its expiry sweep');
		return { Expiring, sweep: sweeps[0] };
	}

	function indexedIds(Expiring) {
		return Array.from(Expiring.indices.expiresAt.getRange({ start: true })).map(({ value }) => value);
	}

	function resident(Expiring, id) {
		return Expiring.primaryStore.getEntry(id)?.value !== undefined;
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

	it('keeps @expiresAt declared while a backfill of the attribute is still running', async () => {
		const Backfilled = declare('ExpiresAtFlagMidBuild', {});
		for (let i = 0; i < 200; i++) await Backfilled.put({ id: i, expiresAt: Date.now() + i });
		declare('ExpiresAtFlagMidBuild', { indexed: true });
		const build = Backfilled.indexingOperation;
		assert(build, 'indexing an attribute of a populated table starts a backfill');

		declare('ExpiresAtFlagMidBuild', { indexed: true, expiresAt: true });
		await build;

		const descriptor = Backfilled.dbisDB.getSync('ExpiresAtFlagMidBuild/expiresAt');
		assert.strictEqual(descriptor.expiresAt, true);
		assert.strictEqual(descriptor.indexingPID, undefined);
	});

	it('the expiry sweep evicts expired records and keeps the rest', async () => {
		const { Expiring, sweep } = declareWithSweep('ExpiresAtSweep');
		await Expiring.put({ id: 'spent-1', expiresAt: Date.now() - 2000 });
		await Expiring.put({ id: 'spent-2', expiresAt: Date.now() - 1000 });
		await Expiring.put({ id: 'in-window', expiresAt: Date.now() + 3_600_000 });

		await sweep();

		await waitFor(() => !resident(Expiring, 'spent-1') && !resident(Expiring, 'spent-2'), {
			timeout: 10000,
			message: 'the sweep did not evict the expired records',
		});
		assert(resident(Expiring, 'in-window'));
	});

	it('the expiry sweep keeps a record whose explicit expiresAt outranks its expired field', async () => {
		const { Expiring, sweep } = declareWithSweep('ExpiresAtSweepOverride');
		await Expiring.put(
			'extended',
			{ id: 'extended', expiresAt: Date.now() - 1000 },
			{ expiresAt: Date.now() + 3_600_000 }
		);
		await Expiring.put({ id: 'spent', expiresAt: Date.now() - 1000 });

		await sweep();

		await waitFor(() => !resident(Expiring, 'spent'), {
			timeout: 10000,
			message: 'the sweep did not evict the expired record',
		});
		assert(resident(Expiring, 'extended'));
	});

	it('the expiry sweep removes an expired index entry whose record is gone, and carries on past it', async () => {
		const { Expiring, sweep } = declareWithSweep('ExpiresAtSweepOrphan');
		await Expiring.put({ id: 'orphaned', expiresAt: Date.now() - 2000 });
		await Expiring.put({ id: 'spent', expiresAt: Date.now() - 1000 });
		await Expiring.put({ id: 'in-window', expiresAt: Date.now() + 3_600_000 });
		// the record goes but its index entry stays
		await Expiring.primaryStore.remove('orphaned');
		assert.deepStrictEqual(indexedIds(Expiring).sort(), ['in-window', 'orphaned', 'spent']);

		await sweep();

		await waitFor(() => indexedIds(Expiring).length === 1 && !resident(Expiring, 'spent'), {
			timeout: 10000,
			message: 'the sweep did not remove the orphaned index entry and evict the expired record behind it',
		});
		assert.deepStrictEqual(indexedIds(Expiring), ['in-window']);
	});

	it('arms the sweep of a table loaded before its thread became worker 0, once it is', async () => {
		manageThreads.setMainIsWorker(false);
		let Expiring;
		try {
			const declared = capturingSweeps(() => declare('ExpiresAtSweepLateOwner', { indexed: true, expiresAt: true }));
			assert.strictEqual(declared.sweeps.length, 0, 'a thread that is not worker 0 arms no expiry sweep');
			Expiring = declared.result;
		} finally {
			manageThreads.setMainIsWorker(true);
		}
		await Expiring.put({ id: 'spent', expiresAt: Date.now() - 1000 });

		const { sweeps } = capturingSweeps(() => armLoadedExpirySweeps());
		for (const sweep of sweeps) await sweep();

		await waitFor(() => !resident(Expiring, 'spent'), {
			timeout: 10000,
			message: 'no sweep armed for the table evicted its expired record',
		});
	});
});
