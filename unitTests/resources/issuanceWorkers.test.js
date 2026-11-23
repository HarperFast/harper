require('../testUtils');
const assert = require('node:assert');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { PID_DIR_PATH } = require('../perPidRoot');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { claimLocalKey } = require('#src/resources/originClosedFloor');
const { readLocalIssuanceCeiling } = require('#src/resources/auditStore');
const { waitFor } = require('../waitFor');

// The claim raises the process-wide clock, so it is kept short and waited out before the next file.
const CLAIM_LEAD_MS = 6000;

describe('issuance coverage across live workers', function () {
	this.timeout(60_000);
	const definition = {
		table: 'IssuanceWorkerTable',
		database: 'issuanceWorkerTests',
		audit: true,
		attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'n' }],
	};
	let Tbl, claimed, lifted, initialCeiling, failedPath;
	const workers = new Set();
	before(function () {
		if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') this.skip();
		setupTestDBPath();
		setMainIsWorker(true);
		Tbl = table(definition);
		assert.strictEqual(readLocalIssuanceCeiling(Tbl.auditStore), 0);
	});
	after(async () => {
		const raisedTo = Math.max(claimed ?? 0, lifted ?? 0);
		await waitFor(() => Date.now() > raisedTo + 1, raisedTo - Date.now() + 5000, 50);
	});
	afterEach(async () => {
		for (const worker of workers) await worker.terminate();
		workers.clear();
		if (failedPath) await fs.rm(failedPath, { recursive: true, force: true });
	});
	function spawn(mode) {
		const worker = new Worker(path.join(__dirname, 'fixtures/issuanceWorker.cjs'), {
			workerData: { mode, definition, failedPath },
		});
		workers.add(worker);
		let markReady, finish, fail, result;
		const loaded = new Promise((resolve) => (markReady = resolve));
		const finished = new Promise((resolve, reject) => {
			finish = resolve;
			fail = reject;
		});
		finished.catch(() => {});
		const timer = setTimeout(() => fail(new Error(`issuance worker timed out (${mode})`)), 30_000);
		worker.on('message', (message) => {
			if (message.error) fail(new Error(message.error));
			else if (message.ready) markReady();
			else if (message.result) result = message.result;
		});
		worker.once('error', fail);
		worker.once('exit', (code) => {
			clearTimeout(timer);
			workers.delete(worker);
			if (code !== 0 || !result) fail(new Error(`issuance worker exited ${code} (${mode})`));
			else finish(result);
		});
		return { loaded, release: () => worker.postMessage({ go: true }), finished };
	}
	async function runWorkers(modes, claim) {
		const started = modes.map(spawn);
		// a claim for a group that has already failed would still raise the process-wide clock for `after()` to wait out
		await Promise.race([
			Promise.all(started.map((worker) => worker.loaded)),
			...started.map((worker) => worker.finished),
		]);
		claim();
		for (const worker of started) worker.release();
		return Promise.all(started.map((worker) => worker.finished));
	}
	it('does not consume persisted headroom when more workers open a live database', async () => {
		const results = await runWorkers(
			Array.from({ length: 4 }, () => 'issue'),
			() => {
				claimed = claimLocalKey(Tbl.primaryStore.rootStore, Date.now() + CLAIM_LEAD_MS);
				initialCeiling = readLocalIssuanceCeiling(Tbl.auditStore);
			}
		);
		for (const result of results) {
			const sinceClaim = result.issuedAt - (claimed - CLAIM_LEAD_MS);
			assert.ok(
				result.issuedAt < claimed,
				`the workers must issue before wall-clock catch-up (${sinceClaim} ms after the claim)`
			);
			assert.ok(result.key > claimed);
			assert.ok(result.key < initialCeiling, 'opening another worker must not promote the reserved headroom');
			assert.ok(result.ceiling < initialCeiling + 1, 'per-worker coverage must not compound full headroom steps');
		}
	});
	it('serves a failed-coverage source read uncached and gives a waiter a fresh fill', async () => {
		failedPath = await fs.mkdtemp(path.join(PID_DIR_PATH, 'closed-issuance-audit-'));
		const Other = table({ ...definition, database: 'issuanceWorkerOther' });
		const [result] = await runWorkers(['source'], () => {
			// another database's claim lifts the clock past this database's ceiling, so its next key needs coverage
			const above = readLocalIssuanceCeiling(Tbl.auditStore) + 1000;
			lifted = claimLocalKey(Other.primaryStore.rootStore, Math.max(above, Date.now() + CLAIM_LEAD_MS));
		});
		const ahead = lifted - Date.now();
		assert.ok(result.failures > 0, `the real closed audit store must reject coverage (the lift is ${ahead} ms ahead)`);
		assert.strictEqual(result.calls[0].noCacheStore, true);
		assert.strictEqual(result.calls.length, 2, 'the waiter must not share the raw-version outcome');
		assert.deepStrictEqual(
			result.values.map((value) => value.n),
			[1, 2]
		);
		assert.strictEqual(result.cached.n, 2);
		assert.ok(result.cached.version > result.values[0].version);
	});
});
