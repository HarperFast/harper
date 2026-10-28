/**
 * Multi-worker comparison for record-lock issuance before and after one strict ratchet claim.
 * Run `npm run bench:record-lock-admission`.
 */
require('../testUtils');
const { Worker } = require('node:worker_threads');
const { performance } = require('node:perf_hooks');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const { getIdOfRemoteNode } = require('#src/resources/nodeIdMapping');
const { readLocalIssuanceCeiling } = require('#src/resources/auditStore');
const { waitFor } = require('../waitFor');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';
const WORKERS = 3;
const PER_WORKER = 300;
const PLAIN_WRITES = 2000;

function rate(operations, milliseconds) {
	return `${((operations / milliseconds) * 1000).toFixed(0)} op/s`;
}

describe('Benchmark: record-lock issuance across workers', function () {
	this.timeout(600_000);
	let LockTable;
	let workers = [];
	let recordId;

	before(function () {
		if (isLMDB) return this.skip();
		setupTestDBPath();
		setMainIsWorker(true);
		LockTable = table({
			table: 'RecordLockThread',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'n' }],
		});
		recordId = `record-lock-admission-${process.pid}`;
		workers = Array.from(
			{ length: WORKERS },
			() => new Worker(__dirname + '/recordLock-thread.js', { workerData: { addPorts: [] } })
		);
	});

	after(async function () {
		await Promise.all(workers.map((worker) => worker.terminate()));
		workers = [];
	});

	function request(worker, message, replyType) {
		return new Promise((resolve, reject) => {
			const onMessage = (reply) => {
				if (reply.type === 'error') {
					worker.off('message', onMessage);
					reject(Object.assign(new Error(reply.message), { statusCode: reply.statusCode }));
				} else if (reply.type === replyType) {
					worker.off('message', onMessage);
					resolve(reply);
				}
			};
			worker.on('message', onMessage);
			worker.postMessage(message);
		});
	}

	async function lockedWrites() {
		await LockTable.put({ id: recordId, n: 0 });
		const start = performance.now();
		const parallel = workers.map((worker) =>
			request(worker, { type: 'increment', id: recordId, count: PER_WORKER }, 'incremented')
		);
		for (let index = 0; index < PER_WORKER; index++) {
			await transaction(async () => {
				const record = await LockTable.lock(recordId);
				record.set('n', (record.getProperty('n') ?? 0) + 1);
				await record.save();
			});
		}
		await Promise.all(parallel);
		const elapsed = performance.now() - start;
		await waitFor(() => LockTable.primaryStore.getEntry(recordId)?.value?.n === PER_WORKER * (WORKERS + 1), {
			timeout: 5000,
			message: 'all benchmark lock writes landed',
		});
		return elapsed;
	}

	async function plainWrites() {
		const start = performance.now();
		for (let index = 0; index < PLAIN_WRITES; index++)
			await LockTable.put({ id: `${recordId}-plain-${index}`, n: index });
		return performance.now() - start;
	}

	it('reports multi-worker lock and ordinary-save throughput before and after a strict claim', async function () {
		const warm = await lockedWrites();
		const beforeLock = await lockedWrites();
		const beforePlain = await plainWrites();
		const sourceContext = { source: {}, timestamp: Date.now() + 1000 };
		await transaction(sourceContext, async () => {
			const record = await LockTable.getResource(recordId, sourceContext);
			return record._writeUpdate(recordId, { id: recordId, n: 0 }, true, {
				isNotification: true,
				nodeId: getIdOfRemoteNode('record-lock-bench-peer', LockTable.auditStore),
			});
		});
		await transaction(async () => LockTable.lock(recordId));
		const afterLock = await lockedWrites();
		const afterPlain = await plainWrites();
		const strictCeiling = readLocalIssuanceCeiling(LockTable.auditStore);
		console.log('');
		console.log(`  warm-up: ${warm.toFixed(0)} ms`);
		console.log(
			`  ${WORKERS + 1} workers, ${PER_WORKER * (WORKERS + 1)} lock writes before claim: ${rate(PER_WORKER * (WORKERS + 1), beforeLock)} (${beforeLock.toFixed(0)} ms)`
		);
		console.log(
			`  ${WORKERS + 1} workers, ${PER_WORKER * (WORKERS + 1)} lock writes after claim:  ${rate(PER_WORKER * (WORKERS + 1), afterLock)} (${afterLock.toFixed(0)} ms)`
		);
		console.log(`  ordinary puts before claim: ${rate(PLAIN_WRITES, beforePlain)} (${beforePlain.toFixed(0)} ms)`);
		console.log(`  ordinary puts after claim:  ${rate(PLAIN_WRITES, afterPlain)} (${afterPlain.toFixed(0)} ms)`);
		console.log(`  strict ceiling: ${strictCeiling}`);
	});
});
