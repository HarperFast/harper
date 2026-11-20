/**
 * Benchmark: the per-entry and per-pass cost of reading the transaction (audit) log the way its live readers do.
 * Every worker with a subscriber in a database, every replication sender and every derived-index runner reads
 * every entry, so these costs are paid once per reader per entry.
 *
 *   npx mocha unitTests/resources/auditLogRead.bench.js                                     (built dist)
 *   NODE_OPTIONS=--conditions=typestrip npx mocha unitTests/resources/auditLogRead.bench.js (source)
 *
 * AUDIT_BENCH_ROWS (default 100000), AUDIT_BENCH_REPS (default 7), AUDIT_BENCH_PASSES (default 5000).
 */
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { transaction } = require('#src/resources/transaction');
const { addSubscription } = require('#src/resources/transactionBroadcast');
const { keyArrayToString } = require('#src/resources/Resources');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { waitFor } = require('../waitFor');
require('#src/server/serverHelpers/serverUtilities');

const ROWS = Number(process.env.AUDIT_BENCH_ROWS ?? 100_000);
const REPS = Number(process.env.AUDIT_BENCH_REPS ?? 7);
const PASSES = Number(process.env.AUDIT_BENCH_PASSES ?? 5000);
// the broadcast's routing filter
const ACTIONS_OF_INTEREST = ['put', 'patch', 'delete', 'message', 'invalidate'];

function median(values) {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
}

describe('audit log read benchmarks', function () {
	this.timeout(0);
	let A, B;
	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		const attributes = [
			{ name: 'id', isPrimaryKey: true },
			{ name: 'name' },
			{ name: 'count' },
			{ name: 'tags' },
			{ name: 'price' },
		];
		A = table({ database: 'audit_read_bench', table: 'Subscribed', schemaDefined: true, attributes });
		B = table({ database: 'audit_read_bench', table: 'Busy', schemaDefined: true, attributes });
		const batch = 100;
		for (let i = 0; i < ROWS; i += batch) {
			// most production writes carry the writer's name in the entry
			await transaction({ user: { username: 'bench-user' } }, async () => {
				for (let j = i; j < i + batch && j < ROWS; j++)
					B.put({
						id: `device/${j % 1000}/reading-${j}`,
						name: `name ${j}`,
						count: j,
						tags: ['a', 'b'],
						price: j * 1.5,
					});
			});
		}
		await waitFor(() => {
			let count = 0;
			for (const _ of B.auditStore.getRange({ start: 0 })) count++;
			return count >= ROWS;
		});
	});

	function stage(name, run) {
		run();
		run();
		const times = [];
		let count = 0;
		for (let rep = 0; rep < REPS; rep++) {
			const start = process.hrtime.bigint();
			count = run();
			times.push(Number(process.hrtime.bigint() - start) / count);
		}
		console.log('AUDIT_READ', JSON.stringify({ stage: name, entries: count, nsPerEntry: +median(times).toFixed(1) }));
	}

	it('measures each read stage per entry', () => {
		const auditStore = B.auditStore;
		const log = auditStore.log;
		assert.ok(log?.query, 'RocksDB transaction log expected');
		const subscribedTables = { [A.tableId]: new Map([['x', []]]) };
		const busyKeys = new Map([['nomatch', []]]);
		stage('raw log.query (entry objects only)', () => {
			let n = 0;
			for (const _entry of log.query({ start: 0 })) n++;
			return n;
		});
		stage('getRange (decode, no field reads)', () => {
			let n = 0;
			for (const _record of auditStore.getRange({ start: 0 })) n++;
			return n;
		});
		stage('getRange + filter (unsubscribed table)', () => {
			let n = 0;
			for (const record of auditStore.getRange({ start: 0 })) {
				n++;
				if (ACTIONS_OF_INTEREST.includes(record.type) && subscribedTables[record.tableId]) throw new Error('no match');
			}
			return n;
		});
		stage('getRange + route (recordId + key lookup)', () => {
			let n = 0;
			for (const record of auditStore.getRange({ start: 0 })) {
				n++;
				if (ACTIONS_OF_INTEREST.includes(record.type) && busyKeys.get(keyArrayToString(record.recordId)))
					throw new Error('no match');
			}
			return n;
		});
		stage('getRange peekAhead (subscription range shape)', () => {
			let n = 0;
			for (const _record of auditStore.getRange({ start: 0, peekAhead: true })) n++;
			return n;
		});
	});

	it('measures the reusable range cost of one notify pass', async () => {
		const range = B.auditStore.getRange({ peekAhead: true });
		const iterator = range[Symbol.iterator]();
		const drain = () => {
			let n = 0;
			while (!iterator.next().done) n++;
			return n;
		};
		drain();
		let oneEntryNs = 0,
			emptyNs = 0;
		for (let i = 0; i < PASSES; i++) {
			await B.put({ id: `device/${i % 1000}/pass-${i}`, name: 'p', count: i, tags: ['a'], price: i });
			let start = process.hrtime.bigint();
			assert.equal(drain(), 1);
			oneEntryNs += Number(process.hrtime.bigint() - start);
			start = process.hrtime.bigint();
			drain();
			emptyNs += Number(process.hrtime.bigint() - start);
		}
		console.log(
			'AUDIT_PASS',
			JSON.stringify({ oneEntryPassNs: Math.round(oneEntryNs / PASSES), emptyPassNs: Math.round(emptyNs / PASSES) })
		);
	});

	it('times the notify passes a commit causes for a subscription on another table', async () => {
		// times the broadcast's own passes by wrapping the setImmediate that schedules them; commits a pass finds
		// together share it, so the result is pass CPU per committed write
		const originalSetImmediate = global.setImmediate;
		let passNs = 0,
			passCount = 0;
		global.setImmediate = function (callback, ...args) {
			if (!String(callback).includes('notifyFromTransactionData')) return originalSetImmediate(callback, ...args);
			return originalSetImmediate(() => {
				const start = process.hrtime.bigint();
				try {
					callback(...args);
				} finally {
					passNs += Number(process.hrtime.bigint() - start);
					passCount++;
				}
			});
		};
		const drain = async () => {
			for (let i = 0; i < 3; i++) await new Promise((resolve) => originalSetImmediate(resolve));
		};
		let subscription;
		try {
			subscription = addSubscription(A, 'x', () => {});
			for (let i = 0; i < 500; i++) await B.put({ id: `warm-${i}`, name: 'w', count: i, tags: [], price: i });
			await drain();
			passNs = 0;
			passCount = 0;
			for (let i = 0; i < PASSES; i++)
				await B.put({ id: `device/${i % 1000}/timed-${i}`, name: 't', count: i, tags: ['a'], price: i });
			await drain();
		} finally {
			global.setImmediate = originalSetImmediate;
			subscription?.end();
		}
		console.log(
			'AUDIT_NOTIFY_PASS',
			JSON.stringify({ writes: PASSES, passCount, nsPerWrite: Math.round(passNs / PASSES) })
		);
	});
});
