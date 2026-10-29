/**
 * Benchmark: a replicated write that arrives older than its record's newest full put (harper#3532).
 *
 * Each record gets a head put from one origin, then a patch from another origin with an older version. Reports
 * the audit lookups (`get`/`getSync`/`getRange` on the audit store) and the time per late write. Run the same
 * file against two builds to compare.
 *
 * Run via: `npx mocha unitTests/resources/lateWriteFullHead.bench.js`.
 */
require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const { getIdOfRemoteNode } = require('#src/resources/nodeIdMapping');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';
const RECORDS = 20_000;
const BATCH = 100;
const ROUNDS = 3;

describe('Benchmark: late write against a full-put head', function () {
	this.timeout(600_000);
	let Tbl, headOrigin, lateOrigin;

	before(function () {
		if (isLMDB) return this.skip();
		setupTestDBPath();
		setMainIsWorker(true);
		Tbl = table({
			table: 'LateWriteBench',
			database: 'test',
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }, { name: 'count' }, { name: 'payload' }],
		});
		// named origins, so each write is read from and filed under its origin's own log
		headOrigin = getIdOfRemoteNode('late-write-bench-head', Tbl.auditStore);
		lateOrigin = getIdOfRemoteNode('late-write-bench-late', Tbl.auditStore);
	});

	function applyBatch(writes, nodeId, fullUpdate) {
		const logKey = writes[0].version;
		const context = { source: {}, sourceApply: true, timestamp: logKey };
		return transaction(context, async () => {
			for (const { id, record, version } of writes) {
				const resource = await Tbl.getResource(id, context, { ensureLoaded: false });
				resource._writeUpdate(id, record, fullUpdate, { isNotification: true, nodeId, version });
			}
		});
	}

	function countLookups(auditStore) {
		const counts = { lookups: 0 };
		const originals = {};
		for (const method of ['get', 'getSync', 'getRange']) {
			originals[method] = auditStore[method];
			auditStore[method] = function (...args) {
				counts.lookups++;
				return originals[method].apply(this, args);
			};
		}
		counts.restore = () => Object.assign(auditStore, originals);
		return counts;
	}

	it('reports audit lookups and time per late write', async () => {
		const results = [];
		for (let round = 0; round < ROUNDS; round++) {
			const prefix = `r${round}-`;
			const headVersion = Date.now() + 10_000_000 * (round + 1);
			for (let start = 0; start < RECORDS; start += BATCH) {
				const writes = [];
				for (let i = start; i < start + BATCH; i++)
					writes.push({
						id: prefix + i,
						record: { id: prefix + i, name: 'head', count: 1, payload: 'x'.repeat(64) },
						version: headVersion + i,
					});
				await applyBatch(writes, headOrigin, true);
			}
			const counts = countLookups(Tbl.auditStore);
			const began = performance.now();
			try {
				for (let start = 0; start < RECORDS; start += BATCH) {
					const writes = [];
					for (let i = start; i < start + BATCH; i++)
						writes.push({ id: prefix + i, record: { name: 'late' }, version: headVersion - 1_000_000 + i });
					await applyBatch(writes, lateOrigin, false);
				}
			} finally {
				counts.restore();
			}
			const elapsed = performance.now() - began;
			const sample = await Tbl.get(prefix + '7');
			assert.equal(sample.name, 'head', 'the late patch must lose to the newer put');
			results.push({ microsPerWrite: (elapsed * 1000) / RECORDS, lookupsPerWrite: counts.lookups / RECORDS });
		}
		results.sort((a, b) => a.microsPerWrite - b.microsPerWrite);
		const median = results[Math.floor(results.length / 2)];
		console.log(
			`late write vs full-put head: ${median.microsPerWrite.toFixed(1)} µs/write (median of ${ROUNDS}), ` +
				`${median.lookupsPerWrite.toFixed(2)} audit lookups/write; rounds: ${results
					.map((r) => r.microsPerWrite.toFixed(1))
					.join(', ')}`
		);
	});
});
