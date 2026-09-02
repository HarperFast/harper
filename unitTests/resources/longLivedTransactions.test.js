require('../testUtils');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { Worker } = require('node:worker_threads');
const { logger } = require('#src/utility/logging/logger');
const env = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS, CONFIG_PARAM_MAP } = require('#src/utility/hdbTerms');
const {
	describeHolderCandidates,
	getReportThresholdMs,
	reportLongLivedHolder,
	resetLongLivedTransactionReportsForTests,
	runLongLivedTransactionSweep,
	setRegistryStatusForTests,
	startLongLivedTransactionReporting,
} = require('#src/resources/longLivedTransactions');
const { registryStatus } = require('@harperfast/rocksdb-js');
const { waitFor } = require('../waitFor.js');

const THRESHOLD = CONFIG_PARAMS.STORAGE_LONGTRANSACTIONREPORTTHRESHOLD;

// Covers harper#2471: a transaction holding staged writes stayed open for hours on a production node
// with nothing reporting it. These pin the three reporting surfaces and, above all, the load-bearing
// claim that one main-thread sweep of the process-global registry sees a worker thread's handles.
describe('Long-lived transaction reporting (#2471)', () => {
	let warnings, errors, originalWarn, originalError, originalThreshold;

	const warningsMatching = (fragment) => warnings.filter(([message]) => String(message).includes(fragment));

	beforeEach(function () {
		warnings = [];
		errors = [];
		originalWarn = logger.warn;
		originalError = logger.error;
		logger.warn = (...args) => warnings.push(args);
		logger.error = (...args) => errors.push(args);
		originalThreshold = env.get(THRESHOLD);
		env.setProperty(THRESHOLD, '1m');
		resetLongLivedTransactionReportsForTests();
	});

	afterEach(function () {
		logger.warn = originalWarn;
		logger.error = originalError;
		env.setProperty(THRESHOLD, originalThreshold);
		setRegistryStatusForTests(registryStatus);
		resetLongLivedTransactionReportsForTests();
	});

	const status =
		(...databases) =>
		() =>
			databases;
	const database = (dbPath, ...handles) => ({
		path: dbPath,
		transactionDetails: handles.map(([id, ageMs]) => ({ id, ageMs })),
	});

	describe('configuration', () => {
		// New CONFIG_PARAMS entries are folded into CONFIG_PARAM_MAP by the loop in hdbTerms, which is
		// what makes the parameter reachable from a config file / set_configuration rather than only
		// from a literal lookup.
		it('is reachable through the canonical config parameter map', function () {
			assert.strictEqual(CONFIG_PARAM_MAP[THRESHOLD.toLowerCase()], THRESHOLD);
		});

		it('defaults to five minutes when unset', function () {
			env.setProperty(THRESHOLD, undefined);
			assert.strictEqual(getReportThresholdMs(), 300000);
		});

		it('treats a bare number as seconds', function () {
			env.setProperty(THRESHOLD, 90);
			assert.strictEqual(getReportThresholdMs(), 90000);
		});

		it('disables reporting at 0', function () {
			env.setProperty(THRESHOLD, 0);
			assert.strictEqual(getReportThresholdMs(), 0);
			setRegistryStatusForTests(status(database('/db/a', [1, 99999999])));
			runLongLivedTransactionSweep();
			assert.strictEqual(warnings.length, 0, 'a disabled threshold must not sweep or report');
		});

		// 'abc' -> convertToMS -> NaN, and a negative is not a duration. Falling through to the
		// default matters: the alternative is silently disabling the reporting the operator asked for.
		for (const invalid of ['abc', -1, Infinity]) {
			it(`falls back to the default for ${String(invalid)} and warns once`, function () {
				env.setProperty(THRESHOLD, invalid);
				assert.strictEqual(getReportThresholdMs(), 300000);
				assert.strictEqual(getReportThresholdMs(), 300000);
				assert.strictEqual(warningsMatching('Invalid storage.longTransactionReportThreshold').length, 1);
			});
		}
	});

	describe('registry sweep', () => {
		it('reports a handle open past the threshold, with its database and age', function () {
			setRegistryStatusForTests(status(database('/db/alpha', [7, 3600000])));
			runLongLivedTransactionSweep();
			const reported = warningsMatching('Long-lived RocksDB transaction handle');
			assert.strictEqual(reported.length, 1);
			assert.match(reported[0][0], /id 7\b/);
			assert.match(reported[0][0], /\/db\/alpha/);
			assert.match(reported[0][0], /1h/);
		});

		it('ignores a handle below the threshold', function () {
			setRegistryStatusForTests(status(database('/db/alpha', [7, 1000])));
			runLongLivedTransactionSweep();
			assert.strictEqual(warningsMatching('Long-lived RocksDB transaction handle').length, 0);
		});

		it('backs off rather than repeating every pass, and reports again once the age doubles', function () {
			setRegistryStatusForTests(status(database('/db/alpha', [7, 3600000])));
			runLongLivedTransactionSweep();
			runLongLivedTransactionSweep();
			assert.strictEqual(warningsMatching('Long-lived RocksDB transaction handle').length, 1, 'second pass repeats');
			setRegistryStatusForTests(status(database('/db/alpha', [7, 7200001])));
			runLongLivedTransactionSweep();
			assert.strictEqual(warningsMatching('Long-lived RocksDB transaction handle').length, 2);
		});

		// The native id is allocated per database descriptor, so two databases commonly both have
		// transaction 2. Keying suppression on the id alone would silence one of them.
		it('does not let one database suppress the same id in another', function () {
			setRegistryStatusForTests(status(database('/db/alpha', [2, 3600000]), database('/db/beta', [2, 3600000])));
			runLongLivedTransactionSweep();
			const reported = warningsMatching('Long-lived RocksDB transaction handle');
			assert.strictEqual(reported.length, 2);
			assert.ok(reported.some(([message]) => message.includes('/db/alpha')));
			assert.ok(reported.some(([message]) => message.includes('/db/beta')));
		});

		// The counter restarts when a descriptor is reopened, so (path, id) can come back on a brand
		// new handle without the old one ever being observed as gone.
		it('reports a reused id whose age went backwards', function () {
			setRegistryStatusForTests(status(database('/db/alpha', [2, 3600000])));
			runLongLivedTransactionSweep();
			setRegistryStatusForTests(status(database('/db/alpha', [2, 3599000])));
			runLongLivedTransactionSweep();
			assert.strictEqual(warningsMatching('Long-lived RocksDB transaction handle').length, 2);
		});

		it('caps a pass and states how many it left out', function () {
			const handles = Array.from({ length: 25 }, (unused, index) => [index + 1, 3600000 + index]);
			setRegistryStatusForTests(status(database('/db/alpha', ...handles)));
			runLongLivedTransactionSweep();
			assert.strictEqual(warningsMatching('Long-lived RocksDB transaction handle').length, 10);
			assert.strictEqual(warningsMatching('15 further RocksDB transaction handle(s)').length, 1);
		});

		// The cap must not mean the same ten handles forever: reporting one pushes its next report out
		// past its current age, so the pass after it names the ones it had to skip.
		it('rotates the cap across passes so a skipped handle is still named', function () {
			const handles = Array.from({ length: 12 }, (unused, index) => [index + 1, 3600000 + index]);
			setRegistryStatusForTests(status(database('/db/alpha', ...handles)));
			runLongLivedTransactionSweep();
			const first = new Set(warningsMatching('Long-lived RocksDB transaction handle').map(([m]) => m));
			runLongLivedTransactionSweep();
			const named = warningsMatching('Long-lived RocksDB transaction handle').map(([m]) => m);
			assert.strictEqual(named.length, 12, 'the two skipped handles should be named on the next pass');
			assert.strictEqual(named.filter((message) => !first.has(message)).length, 2);
		});

		it('forgets a handle that is gone, so a later id reuse is not suppressed', function () {
			setRegistryStatusForTests(status(database('/db/alpha', [2, 3600000])));
			runLongLivedTransactionSweep();
			setRegistryStatusForTests(status(database('/db/alpha')));
			runLongLivedTransactionSweep();
			setRegistryStatusForTests(status(database('/db/alpha', [2, 3600000])));
			runLongLivedTransactionSweep();
			assert.strictEqual(warningsMatching('Long-lived RocksDB transaction handle').length, 2);
		});

		it('warns once when the binding predates transactionDetails, and does not throw', function () {
			setRegistryStatusForTests(() => [{ path: '/db/alpha', transactions: 3 }]);
			assert.doesNotThrow(() => runLongLivedTransactionSweep());
			runLongLivedTransactionSweep();
			assert.strictEqual(warningsMatching('does not expose registryStatus().transactionDetails').length, 1);
		});

		it('swallows and logs a registry failure', function () {
			setRegistryStatusForTests(() => {
				throw new Error('boom');
			});
			assert.doesNotThrow(() => runLongLivedTransactionSweep());
			assert.strictEqual(errors.length, 1);
		});

		it('arms the sweep at most once', function () {
			startLongLivedTransactionReporting();
			startLongLivedTransactionReporting();
			// Two armed intervals would double every future report; the reset seam clears exactly one.
			resetLongLivedTransactionReportsForTests();
			setRegistryStatusForTests(status(database('/db/alpha', [7, 3600000])));
			runLongLivedTransactionSweep();
			assert.strictEqual(warningsMatching('Long-lived RocksDB transaction handle').length, 1);
		});
	});

	describe('holder attribution', () => {
		const holder = (overrides) => ({
			databasePath: '/db/alpha',
			nativeId: 12,
			ageMs: 3600000,
			databaseName: 'data',
			tableName: 'Orders',
			pendingWrites: 3,
			states: ['source-apply'],
			startedFrom: { resourceName: 'Orders', method: 'put' },
			...overrides,
		});

		it('names the native id, the table, the state and where it started', function () {
			reportLongLivedHolder(holder());
			const reported = warningsMatching('Harper transaction has held RocksDB transaction');
			assert.strictEqual(reported.length, 1);
			assert.match(reported[0][0], /transaction 12\b/);
			assert.match(reported[0][0], /data\.Orders/);
			assert.match(reported[0][0], /3 staged write\(s\)/);
			assert.match(reported[0][0], /state: source-apply/);
			assert.match(reported[0][0], /started from Orders\.put/);
		});

		it('joins to the sweep on the same native id', function () {
			setRegistryStatusForTests(status(database('/db/alpha', [12, 3600000])));
			runLongLivedTransactionSweep();
			reportLongLivedHolder(holder());
			assert.ok(warningsMatching('Long-lived RocksDB transaction handle').some(([m]) => m.includes('id 12')));
			assert.ok(warningsMatching('Harper transaction has held').some(([m]) => m.includes('transaction 12')));
		});

		it('reports every state that is keeping it alive, not just the first', function () {
			reportLongLivedHolder(holder({ states: ['source-apply', 'commit-phase'] }));
			assert.match(warningsMatching('Harper transaction has held')[0][0], /state: source-apply\+commit-phase/);
		});

		it('backs off like the sweep and never throws', function () {
			reportLongLivedHolder(holder());
			reportLongLivedHolder(holder());
			assert.strictEqual(warningsMatching('Harper transaction has held').length, 1);
			assert.doesNotThrow(() => reportLongLivedHolder(holder({ states: null })));
		});
	});

	describe('holder candidates for a stuck commit', () => {
		it('names the live handles on the same database, oldest first, excluding the victim', function () {
			setRegistryStatusForTests(status(database('/db/alpha', [1, 60000], [2, 3600000], [3, 120000])));
			const described = describeHolderCandidates('/db/alpha', 1);
			assert.match(described, /oldest first: 2 \(open 1h 0m 0s\), 3 \(open 2m 0s\)/);
			assert.ok(!described.includes(' 1 ('), 'the stuck commit must not be offered as its own holder');
		});

		// A coordinated retry parks on whoever holds the verification-table slot when the commit gets
		// there, which can be a transaction younger than the commit — filtering by age would drop it.
		it('keeps a candidate younger than the stuck commit', function () {
			setRegistryStatusForTests(status(database('/db/alpha', [1, 90000], [2, 10])));
			assert.match(describeHolderCandidates('/db/alpha', 1), /2 \(open 0s\)/);
		});

		it('only offers handles from the stuck commit’s own database', function () {
			setRegistryStatusForTests(status(database('/db/alpha', [1, 90000]), database('/db/beta', [9, 3600000])));
			assert.strictEqual(describeHolderCandidates('/db/alpha', 1), '');
		});

		it('bounds the list and says how many it left out', function () {
			const handles = Array.from({ length: 9 }, (unused, index) => [index + 1, 3600000 + index]);
			setRegistryStatusForTests(status(database('/db/alpha', ...handles)));
			assert.match(describeHolderCandidates('/db/alpha', 1), /and 5 more\.$/);
		});

		// The suffix is diagnostic: its failure must not turn the caller's rate-limited error plus 503
		// into an uncaught throw.
		it('returns nothing rather than throwing when the registry fails', function () {
			setRegistryStatusForTests(() => {
				throw new Error('boom');
			});
			assert.strictEqual(describeHolderCandidates('/db/alpha', 1), '');
		});

		it('returns nothing when the database has no path', function () {
			assert.strictEqual(describeHolderCandidates(undefined, 1), '');
		});
	});

	// The whole design rests on registryStatus() being process-global rather than thread-local: one
	// main-thread sweep must see a handle that only a worker ever created, and see it once. Nothing
	// else in the suite proves that, and if it stops holding, the feature silently reports nothing.
	describe('cross-thread visibility', () => {
		it('reports a worker thread’s handle from the main thread, exactly once', async function () {
			this.timeout(20000);
			if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') this.skip();
			const dbPath = path.join(os.tmpdir(), `harper-2471-${process.pid}-${Date.now()}`);
			const worker = new Worker(
				`const { RocksDatabase, Transaction, parentPort } = { ...require('@harperfast/rocksdb-js'), ...require('node:worker_threads') };
				const db = RocksDatabase.open(${JSON.stringify(dbPath)});
				const txn = new Transaction(db.store, { coordinatedRetry: true });
				txn.putSync('held', 'by the worker');
				parentPort.postMessage(txn.id);
				setInterval(() => {}, 1000);`,
				{ eval: true }
			);
			try {
				const nativeId = await new Promise((resolve, reject) => {
					worker.once('message', resolve);
					worker.once('error', reject);
				});
				setRegistryStatusForTests(registryStatus);
				env.setProperty(THRESHOLD, '0.05');
				await waitFor(() => {
					runLongLivedTransactionSweep();
					return warningsMatching('Long-lived RocksDB transaction handle').length > 0;
				}, 10000);
				const reported = warningsMatching('Long-lived RocksDB transaction handle').filter(([message]) =>
					message.includes(dbPath)
				);
				assert.strictEqual(reported.length, 1, 'the worker-only handle must be reported exactly once');
				assert.match(reported[0][0], new RegExp(`id ${nativeId}\\b`));
			} finally {
				await worker.terminate();
				fs.rmSync(dbPath, { recursive: true, force: true });
			}
		});
	});
});
