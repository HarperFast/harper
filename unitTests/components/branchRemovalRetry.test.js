'use strict';

const assert = require('node:assert');
const { existsSync, mkdirSync, rmSync } = require('node:fs');
const path = require('node:path');

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const { getConfigPath } = require('#src/config/configUtils');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
const operations = require('#js/components/operations');
const { openBranchDatabase, table, resolveBranchPath } = require('#src/resources/databases');
const { getOrCreateBranch, hasPendingBranchRemoval } = require('#src/resources/branchDatabase');
const { setMainIsWorker, getWorkerIndex } = require('#js/server/threads/manageThreads');
const { preserveRootConfig } = require('../rootConfigFixture.js');
const { waitFor } = require('../waitFor.js');

const BASE = 'retrybase';
const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

describe('a branch removal a drop could not finish (harper#3463)', function () {
	this.timeout(30_000);
	preserveRootConfig();
	const drop = (request) => operations.dropComponent({ operation: 'drop_component', ...request });
	const forksOf = (app) => path.dirname(resolveBranchPath(BASE, app));
	const releases = [];

	/**
	 * A fork of `app`, as its worker left it, and a reference to it the drop does not own, standing in for a worker that
	 * has not let go yet: the removal refuses before it touches anything, until that is released.
	 */
	async function heldFork(app) {
		const mainWasWorker = getWorkerIndex() === 0;
		setMainIsWorker(true);
		try {
			const branch = await getOrCreateBranch(BASE, app);
			await branch.tables.Rows.put({ id: 'kept' });
			await branch.close();
			const holder = openBranchDatabase(resolveBranchPath(BASE, app), BASE, `${app.length}_${app}__${BASE}`);
			let held = true;
			const release = async () => {
				if (!held) return;
				held = false;
				await holder.close();
			};
			releases.push(release);
			return release;
		} finally {
			setMainIsWorker(mainWasWorker);
		}
	}

	before(async function () {
		if (isLMDB) return this.skip(); // forks are RocksDB-only
		await testUtils.ensureSystemTables();
		table({ database: BASE, table: 'Rows', attributes: [{ name: 'id', isPrimaryKey: true }] });
	});

	afterEach(async () => {
		for (const release of releases.splice(0)) await release();
		operations.setBranchRemovalRetryDelayForTests?.();
	});

	it('is retried until it succeeds, with no later drop or start', async () => {
		operations.setBranchRemovalRetryDelayForTests?.(50);
		const release = await heldFork('timer-app');

		await assert.rejects(drop({ project: 'timer-app' }), /open reference\(s\) to its store remain/);
		assert.ok(existsSync(forksOf('timer-app')));
		await release();

		await waitFor(() => !existsSync(forksOf('timer-app')), {
			timeout: 10_000,
			interval: 50,
			message: 'the fork was left on disk',
		});
	});

	it('is cancelled by a later drop that keeps the branches', async () => {
		const release = await heldFork('kept-app');
		await assert.rejects(drop({ project: 'kept-app' }), /open reference\(s\) to its store remain/);
		assert.strictEqual(hasPendingBranchRemoval('kept-app'), true);

		const kept = await drop({ project: 'kept-app', keepBranches: true });
		assert.strictEqual(kept.branchesRemoved, false);
		assert.strictEqual(hasPendingBranchRemoval('kept-app'), false, 'the later verdict replaces the owed removal');
		await release();
		await operations.retryPendingBranchRemovals();

		assert.ok(existsSync(resolveBranchPath(BASE, 'kept-app')), 'the kept fork is still there');
		await drop({ project: 'kept-app' });
		assert.strictEqual(existsSync(forksOf('kept-app')), false);
	});

	it('waits while the application is deployed again, and its next drop removes them', async () => {
		const release = await heldFork('back-app');
		await assert.rejects(drop({ project: 'back-app' }), /open reference\(s\) to its store remain/);
		const componentDir = path.join(getConfigPath(CONFIG_PARAMS.COMPONENTSROOT), 'back-app');
		mkdirSync(componentDir, { recursive: true });
		try {
			await release();
			await operations.retryPendingBranchRemovals();
			assert.ok(existsSync(resolveBranchPath(BASE, 'back-app')), 'a deployed application keeps its forks');
		} finally {
			rmSync(componentDir, { recursive: true, force: true });
		}

		await drop({ project: 'back-app' });
		assert.strictEqual(existsSync(forksOf('back-app')), false);
	});
});
