'use strict';

const assert = require('node:assert');
const { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const { getConfigFilePath, getConfigPath } = require('#src/config/configUtils');
const { CONFIG_PARAMS, ITC_EVENT_TYPES, THREAD_TYPES } = require('#src/utility/hdbTerms');
const operations = require('#js/components/operations');
const { openBranchDatabase, table, resolveBranchPath } = require('#src/resources/databases');
const { getOrCreateBranch, hasPendingBranchRemoval } = require('#src/resources/branchDatabase');
const { setMainIsWorker, getWorkerIndex, startWorker } = require('#js/server/threads/manageThreads');
const { preserveRootConfig, setRootConfigEntry } = require('../rootConfigFixture.js');
const { waitFor } = require('../waitFor.js');

const BASE = 'retrybase';
const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

describe('a branch removal a drop could not finish (harper#3463)', function () {
	this.timeout(30_000);
	preserveRootConfig();
	const drop = (request) => operations.dropComponent({ operation: 'drop_component', ...request });
	const forksOf = (app) => path.dirname(resolveBranchPath(BASE, app));
	const releases = [];

	/** A pool worker that reports nothing until told to. */
	function idleHttpWorker() {
		// a start outside safe mode resolves threads.preload for the rest of the process
		const safeMode = process.env.HARPER_SAFE_MODE;
		process.env.HARPER_SAFE_MODE = '1';
		try {
			return startWorker(path.join(__dirname, 'fixtures', 'idleWorker.js'), {
				name: THREAD_TYPES.HTTP,
				workerIndex: 1,
				autoRestart: false,
			});
		} finally {
			if (safeMode === undefined) delete process.env.HARPER_SAFE_MODE;
			else process.env.HARPER_SAFE_MODE = safeMode;
		}
	}

	/** What `idleHttpWorker` echoes as the report a pool worker sends once its load finished. */
	const loaded = (...applications) => ({
		report: { type: ITC_EVENT_TYPES.CHILD_COMPONENT_VERDICT, components: [], applications },
	});

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
		await operations.retryPendingBranchRemovals();
		assert.ok(existsSync(forksOf('timer-app')), 'every pass so far found it held');
		await release();

		await waitFor(() => !existsSync(forksOf('timer-app')), {
			timeout: 10_000,
			interval: 50,
			message: 'the fork was left on disk',
		});
	});

	it('keeps retrying while it cannot read the storage the removal is owed in', async function () {
		if (process.platform === 'win32' || process.getuid?.() === 0) return this.skip(); // root reads it anyway
		operations.setBranchRemovalRetryDelayForTests?.(50);
		const release = await heldFork('unread-app');
		await assert.rejects(drop({ project: 'unread-app' }), /open reference\(s\) to its store remain/);
		const branchRoot = path.dirname(forksOf('unread-app'));
		chmodSync(branchRoot, 0o000);
		try {
			await release();
			await operations.retryPendingBranchRemovals();
		} finally {
			chmodSync(branchRoot, 0o755);
		}

		await waitFor(() => !existsSync(forksOf('unread-app')), {
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

	for (const [unreadable, spoil] of [
		['does not parse', (configFile) => writeFileSync(configFile, 'config-app: [unclosed\n')],
		['cannot be read', (configFile) => chmodSync(configFile, 0o000)],
	]) {
		it(`keeps retrying while the root config ${unreadable}`, async function () {
			if (unreadable === 'cannot be read' && (process.platform === 'win32' || process.getuid?.() === 0)) {
				return this.skip();
			}
			operations.setBranchRemovalRetryDelayForTests?.(50);
			const release = await heldFork('config-app');
			await assert.rejects(drop({ project: 'config-app' }), /open reference\(s\) to its store remain/);
			const configFile = getConfigFilePath();
			const saved = readFileSync(configFile, 'utf8');
			const mode = statSync(configFile).mode & 0o777;
			spoil(configFile);
			try {
				await release();
				await operations.retryPendingBranchRemovals();
				assert.ok(existsSync(forksOf('config-app')), 'a root config it cannot read might name it');
			} finally {
				chmodSync(configFile, mode);
				writeFileSync(configFile, saved);
			}

			await waitFor(() => !existsSync(forksOf('config-app')), {
				timeout: 10_000,
				interval: 50,
				message: 'the fork was left on disk',
			});
		});
	}

	it('runs again as soon as a worker that may hold it reports it did not load it', async () => {
		operations.setBranchRemovalRetryDelayForTests?.(60 * 60_000);
		const branch = await getOrCreateBranch(BASE, 'reported-app');
		await branch.tables.Rows.put({ id: 'kept' });
		const worker = idleHttpWorker();
		try {
			const dropped = await drop({ project: 'reported-app' });
			assert.match(dropped.message, /workers may still have it loaded/);
			await operations.retryPendingBranchRemovals();
			assert.ok(existsSync(forksOf('reported-app')), 'a worker that has not reported may hold it');

			worker.postMessage(loaded());
			await waitFor(() => !existsSync(forksOf('reported-app')), {
				timeout: 10_000,
				interval: 50,
				message: 'the fork waited for the timer',
			});
		} finally {
			await worker.terminate();
		}
	});

	it('runs again as soon as the worker that held it exits', async () => {
		operations.setBranchRemovalRetryDelayForTests?.(60 * 60_000);
		const branch = await getOrCreateBranch(BASE, 'pooled-app');
		await branch.tables.Rows.put({ id: 'kept' });
		const worker = idleHttpWorker();
		try {
			const dropped = await drop({ project: 'pooled-app' });
			assert.match(dropped.message, /workers may still have it loaded/);
			await operations.retryPendingBranchRemovals();
			assert.ok(existsSync(forksOf('pooled-app')), 'a worker that has not reported may hold it');
		} finally {
			await worker.terminate();
		}

		await waitFor(() => !existsSync(forksOf('pooled-app')), {
			timeout: 10_000,
			interval: 50,
			message: 'the fork waited for the timer',
		});
	});

	describe('of an application that declares branches and has none on disk', () => {
		let worker;
		const stopWorker = async () => {
			await worker?.terminate();
			worker = undefined;
		};
		/** A worker still loading `app` when `request` drops it. */
		async function dropWhileLoading(app, request) {
			operations.setBranchRemovalRetryDelayForTests?.(60 * 60_000);
			setRootConfigEntry(app, { branchedDatabases: [BASE] });
			worker = idleHttpWorker();
			await drop({ project: app, ...request });
			await operations.retryPendingBranchRemovals();
		}
		async function createFork(app) {
			const branch = await getOrCreateBranch(BASE, app);
			await branch.tables.Rows.put({ id: 'kept' });
		}
		afterEach(stopWorker);

		it('removes the first fork a worker still loading creates after the drop looked', async () => {
			await dropWhileLoading('late-app');
			assert.strictEqual(hasPendingBranchRemoval('late-app'), true, 'an unreported worker may yet create one');

			await createFork('late-app');
			worker.postMessage(loaded('late-app'));
			await waitFor(() => worker.loadedApplications?.has('late-app'), { timeout: 10_000, interval: 50 });
			await operations.retryPendingBranchRemovals();
			assert.ok(existsSync(resolveBranchPath(BASE, 'late-app')), 'the worker that loaded it still holds it');

			await stopWorker();
			await waitFor(() => !existsSync(forksOf('late-app')), {
				timeout: 10_000,
				interval: 50,
				message: 'the fork was left on disk',
			});
		});

		it('leaves nothing behind when every worker reports that no fork was created', async () => {
			await dropWhileLoading('never-app');
			worker.postMessage(loaded());
			await waitFor(() => !hasPendingBranchRemoval('never-app'), {
				timeout: 10_000,
				interval: 50,
				message: 'the removal stayed owed',
			});
			assert.strictEqual(existsSync(forksOf('never-app')), false);
		});

		it('survives the drop failing after the application is gone', async () => {
			const packageJson = path.join(getConfigPath(CONFIG_PARAMS.ROOTPATH), 'package.json');
			const saved = existsSync(packageJson) ? readFileSync(packageJson, 'utf8') : undefined;
			writeFileSync(packageJson, '{ not json');
			try {
				await assert.rejects(dropWhileLoading('failed-app'), /JSON/);
			} finally {
				if (saved === undefined) rmSync(packageJson);
				else writeFileSync(packageJson, saved);
			}
			assert.strictEqual(hasPendingBranchRemoval('failed-app'), true);

			await createFork('failed-app');
			await stopWorker();
			await waitFor(() => !existsSync(forksOf('failed-app')), {
				timeout: 10_000,
				interval: 50,
				message: 'the fork was left on disk',
			});
		});

		it('keeps the fork of an application deployed again, until its next drop', async () => {
			await dropWhileLoading('again-app');
			const componentDir = path.join(getConfigPath(CONFIG_PARAMS.COMPONENTSROOT), 'again-app');
			mkdirSync(componentDir, { recursive: true });
			try {
				await createFork('again-app');
				await stopWorker();
				await operations.retryPendingBranchRemovals();
				assert.ok(existsSync(resolveBranchPath(BASE, 'again-app')), 'the deployed application keeps its fork');
			} finally {
				rmSync(componentDir, { recursive: true, force: true });
			}

			await drop({ project: 'again-app' });
			assert.strictEqual(existsSync(forksOf('again-app')), false);
		});

		it('keeps the fork when the drop keeps the branches', async () => {
			await dropWhileLoading('kept-late-app', { keepBranches: true });
			assert.strictEqual(hasPendingBranchRemoval('kept-late-app'), false);
			await createFork('kept-late-app');
			await stopWorker();
			await operations.retryPendingBranchRemovals();
			assert.ok(existsSync(resolveBranchPath(BASE, 'kept-late-app')), 'the kept fork is still there');

			await drop({ project: 'kept-late-app' });
			assert.strictEqual(existsSync(forksOf('kept-late-app')), false);
		});
	});

	for (const [what, entry] of [
		['declares no branches', {}],
		['declares an empty list of them', { branchedDatabases: [] }],
	]) {
		it(`writes nothing for an application that ${what}`, async () => {
			setRootConfigEntry('plain-app', entry);
			await drop({ project: 'plain-app' });
			assert.strictEqual(existsSync(forksOf('plain-app')), false);
		});
	}

	it('removes the forks and their directory when a crash cut the marker write short', async () => {
		const release = await heldFork('debris-app');
		await assert.rejects(drop({ project: 'debris-app' }), /open reference\(s\) to its store remain/);
		rmSync(path.join(forksOf('debris-app'), '`removal-pending`'));
		writeFileSync(path.join(forksOf('debris-app'), '`removal-pending`.partial'), '');
		await release();
		await operations.retryPendingBranchRemovals();

		assert.strictEqual(existsSync(forksOf('debris-app')), false);
	});
});
