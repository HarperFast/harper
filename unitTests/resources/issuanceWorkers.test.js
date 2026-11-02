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

describe('issuance coverage across live workers', function () {
	this.timeout(60_000);
	const definition = {
		table: 'IssuanceWorkerTable',
		database: 'issuanceWorkerTests',
		audit: true,
		attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'n' }],
	};
	let Tbl, claimed, initialCeiling, failedPath;
	const workers = new Set();
	before(function () {
		if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') this.skip();
		setupTestDBPath();
		setMainIsWorker(true);
		Tbl = table(definition);
		assert.strictEqual(readLocalIssuanceCeiling(Tbl.auditStore), 0);
		claimed = claimLocalKey(Tbl.primaryStore.rootStore, Date.now() + 60_000);
		initialCeiling = readLocalIssuanceCeiling(Tbl.auditStore);
	});
	afterEach(async () => {
		for (const worker of workers) await worker.terminate();
		workers.clear();
		if (failedPath) await fs.rm(failedPath, { recursive: true, force: true });
	});
	async function run(mode) {
		const worker = new Worker(path.join(__dirname, 'fixtures/issuanceWorker.cjs'), {
			workerData: { mode, definition, failedPath },
		});
		workers.add(worker);
		let result;
		await new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`issuance worker timed out (${mode})`)), 30_000);
			worker.once('message', (message) => {
				if (message.error) reject(new Error(message.error));
				result = message.result;
			});
			worker.once('error', reject);
			worker.once('exit', (code) => {
				clearTimeout(timer);
				if (code !== 0 || !result) reject(new Error(`issuance worker exited ${code} (${mode})`));
				else resolve();
			});
		});
		workers.delete(worker);
		return result;
	}
	it('does not consume persisted headroom when more workers open a live database', async () => {
		for (let n = 0; n < 4; n++) {
			const result = await run('issue');
			assert.ok(Date.now() < claimed, 'the worker must issue before wall-clock catch-up');
			assert.ok(result.key > claimed);
			assert.ok(result.key < initialCeiling, 'opening another worker must not promote the reserved headroom');
			assert.ok(result.ceiling < initialCeiling + 1, 'per-worker coverage must not compound full headroom steps');
		}
	});
	it('serves a failed-coverage source read uncached and gives a waiter a fresh fill', async () => {
		failedPath = await fs.mkdtemp(path.join(PID_DIR_PATH, 'closed-issuance-audit-'));
		const result = await run('source');
		assert.ok(result.failures > 0, 'the real closed audit store must reject coverage');
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
