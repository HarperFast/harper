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
const {
	DatabaseTransaction,
	getOutstandingCommits,
	setMaxOutstandingTxnDuration,
	setTxnExpiration,
	trackOutstandingCommit,
} = require('#src/resources/DatabaseTransaction');
const { transaction } = require('#src/resources/transaction');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const harperLogger = require('#src/utility/logging/harper_logger');
const { table } = require('#src/resources/databases');
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
		// `true` is what YAML gives for `longTransactionReportThreshold: yes`; convertToMS returns 0 for it,
		// which is indistinguishable from the documented disable value.
		for (const invalid of ['abc', -1, Infinity, true, {}]) {
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

		// registryStatus() reports an entry with no path for an ephemeral descriptor; the rest of this
		// surface defaults it, and an operator reading "on database undefined" learns nothing.
		it('names a handle whose database has no path without printing undefined', function () {
			setRegistryStatusForTests(status(database(undefined, [7, 3600000])));
			runLongLivedTransactionSweep();
			const reported = warningsMatching('Long-lived RocksDB transaction handle');
			assert.strictEqual(reported.length, 1);
			assert.match(reported[0][0], /on database \?\./);
		});

		it('ignores a handle below the threshold', function () {
			setRegistryStatusForTests(status(database('/db/alpha', [7, 1000])));
			runLongLivedTransactionSweep();
			assert.strictEqual(warningsMatching('Long-lived RocksDB transaction handle').length, 0);
		});

		it('reports a handle that crosses the threshold after an earlier pass ignored it', function () {
			setRegistryStatusForTests(status(database('/db/alpha', [7, 1000])));
			runLongLivedTransactionSweep();
			setRegistryStatusForTests(status(database('/db/alpha', [7, 90000])));
			runLongLivedTransactionSweep();
			assert.strictEqual(warningsMatching('Long-lived RocksDB transaction handle').length, 1);
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

		// The threshold is read per pass so a live config reload takes effect, but the backoff a handle
		// accrued was pinned at first observation — so lowering it mid-incident did not bring the first
		// report forward, and raising it did not quiet one.
		it('re-measures an already-observed handle when the threshold is lowered', function () {
			env.setProperty(THRESHOLD, '1h');
			setRegistryStatusForTests(status(database('/db/alpha', [7, 120000])));
			runLongLivedTransactionSweep();
			assert.strictEqual(warningsMatching('Long-lived RocksDB transaction handle').length, 0);
			env.setProperty(THRESHOLD, '1m');
			runLongLivedTransactionSweep();
			assert.strictEqual(warningsMatching('Long-lived RocksDB transaction handle').length, 1);
		});

		it('re-measures an already-observed handle when the threshold is raised', function () {
			setRegistryStatusForTests(status(database('/db/alpha', [7, 120000])));
			runLongLivedTransactionSweep();
			assert.strictEqual(warningsMatching('Long-lived RocksDB transaction handle').length, 1);
			env.setProperty(THRESHOLD, '1h');
			runLongLivedTransactionSweep();
			assert.strictEqual(
				warningsMatching('Long-lived RocksDB transaction handle').length,
				1,
				'a handle under the raised threshold must go quiet'
			);
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
			countPendingWrites: () => 3,
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

		it('backs off like the sweep, skipping the staged-write walk on a suppressed report', function () {
			let counted = 0;
			const counting = () =>
				holder({
					countPendingWrites: () => {
						counted++;
						return 3;
					},
				});
			reportLongLivedHolder(counting());
			reportLongLivedHolder(counting());
			assert.strictEqual(warningsMatching('Harper transaction has held').length, 1);
			// The walk is O(chain x writes) and the #2471 shape holds a huge write set for hours, so a
			// suppressed report must not pay for it.
			assert.strictEqual(counted, 1, 'the suppressed report must not count staged writes');
		});

		it('re-measures an already-observed holder when the threshold changes', function () {
			env.setProperty(THRESHOLD, '1h');
			reportLongLivedHolder(holder({ ageMs: 120000 }));
			assert.strictEqual(warningsMatching('Harper transaction has held').length, 0);
			env.setProperty(THRESHOLD, '1m');
			reportLongLivedHolder(holder({ ageMs: 120000 }));
			assert.strictEqual(warningsMatching('Harper transaction has held').length, 1);
		});

		it('never throws', function () {
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

		// The verification table is one process-global slot array whose hash mixes in the database id, so a
		// holder in `system` or `oauth` parks a `data` commit at the same rate another `data` key would.
		// Filtering to the commit's own database printed nothing at all for that shape.
		it('offers a handle on another database, labelled with its path', function () {
			setRegistryStatusForTests(status(database('/db/alpha', [1, 90000]), database('/db/beta', [9, 3600000])));
			const described = describeHolderCandidates('/db/alpha', 1);
			assert.match(described, /9 \(open 1h 0m 0s on \/db\/beta\)/);
		});

		it('ranks the stuck commit’s own database ahead of an older foreign handle', function () {
			setRegistryStatusForTests(
				status(database('/db/alpha', [1, 90000], [2, 60000]), database('/db/beta', [9, 3600000]))
			);
			assert.match(
				describeHolderCandidates('/db/alpha', 1),
				/oldest first: 2 \(open 1m 0s\), 9 \(open 1h 0m 0s on \/db\/beta\)/
			);
		});

		// The cap plus same-database-first ranking would otherwise bury the foreign holder inside the
		// "and N more" count on exactly the busy database this surface is read on — which is the whole
		// point of looking across databases in the first place.
		it('always names the oldest foreign handle even when this database fills the cap', function () {
			setRegistryStatusForTests(
				status(
					database('/db/alpha', [1, 90000], [2, 80000], [3, 70000], [4, 60000]),
					database('/db/gamma', [8, 120000]),
					database('/db/beta', [9, 3600000])
				)
			);
			const described = describeHolderCandidates('/db/alpha', 1);
			assert.match(described, /9 \(open 1h 0m 0s on \/db\/beta\)/, 'the OLDEST foreign holder must take the slot');
			assert.ok(!described.includes('/db/gamma'), 'a younger foreign handle must not displace the oldest');
			assert.match(described, /2 \(open 1m 20s\)/, 'this database still ranks first');
			assert.match(described, /and 2 more\.$/);
		});

		// A registry entry with no path can never be the target, and resolve() throws on undefined —
		// inside the enumeration that dropped the candidate list for every database, not just that entry.
		it('survives a registry entry with no path', function () {
			setRegistryStatusForTests(
				status(database(undefined, [8, 3600000]), database('/db/alpha', [1, 90000], [2, 120000]))
			);
			assert.match(describeHolderCandidates('/db/alpha', 1), /2 \(open 2m 0s\)/);
		});

		it('offers nothing when reporting is disabled', function () {
			env.setProperty(THRESHOLD, 0);
			setRegistryStatusForTests(status(database('/db/alpha', [1, 90000], [2, 3600000])));
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

	// checkOverloaded() is the surface an operator actually reads during an outage, and it is the only
	// one wired to a real wedged commit. Driving it needs the queue limit lowered, because the real one
	// is 45s.
	describe('the stuck-commit log names holder candidates', () => {
		let restoreDuration, settleTrackedCommit;

		// The tracked node unlinks only when its promise settles, and the list is process-wide: leaving one
		// outstanding would 503 every write in every later suite on this thread once it aged past the limit.
		function trackAStuckCommit() {
			trackOutstandingCommit(
				new Promise((resolve) => (settleTrackedCommit = resolve)),
				{ name: 'Wedged', rootStore: { databaseName: 'data', path: '/db/wedged' } },
				{ resourceName: 'Wedged', method: 'put' },
				{ id: 4 }
			);
		}

		beforeEach(function () {
			restoreDuration = setMaxOutstandingTxnDuration(1);
			settleTrackedCommit = undefined;
		});

		afterEach(async function () {
			setMaxOutstandingTxnDuration(restoreDuration);
			settleTrackedCommit?.();
			// trackOutstandingCommit unlinks on a `.then` continuation, so yield until it has run.
			await waitFor(() => getOutstandingCommits().count === 0, 2000);
		});

		it('offers no candidates when reporting is disabled', async function () {
			if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') this.skip();
			const errorLines = [];
			const originalError = harperLogger.error;
			harperLogger.error = (...args) => errorLines.push(args);
			env.setProperty(THRESHOLD, 0);
			setRegistryStatusForTests(status(database('/db/wedged', [4, 90000], [5, 3600000])));
			try {
				trackAStuckCommit();
				await waitFor(() => {
					try {
						new DatabaseTransaction().checkOverloaded();
						return false;
					} catch {
						// The log site is rate-limited across the whole thread, so an earlier test's line can
						// hold the slot; keep shedding until this commit gets one.
						return errorLines.length > 0;
					}
				}, 4000);
			} finally {
				harperLogger.error = originalError;
			}
			assert.strictEqual(errorLines.length, 1);
			assert.ok(
				!errorLines[0][0].includes('Live transaction handles'),
				'a disabled threshold must silence this surface too'
			);
		});

		it('appends the candidates to the 503-raising error, and still raises the 503', async function () {
			if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') this.skip();
			const errorLines = [];
			const originalError = harperLogger.error;
			harperLogger.error = (...args) => errorLines.push(args);
			setRegistryStatusForTests(status(database('/db/wedged', [4, 90000], [5, 3600000])));
			try {
				trackAStuckCommit();
				await waitFor(() => {
					try {
						new DatabaseTransaction().checkOverloaded();
						return false;
					} catch (error) {
						assert.strictEqual(error.statusCode, 503, 'the shed must still be a 503');
						return errorLines.length > 0;
					}
				}, 4000);
			} finally {
				harperLogger.error = originalError;
			}
			assert.strictEqual(errorLines.length, 1, 'the stuck commit must be logged once');
			const line = errorLines[0][0];
			assert.match(line, /Live transaction handles, any of which could hold the write intent/);
			assert.match(line, /5 \(open 1h 0m 0s\)/, 'the older candidate must be named');
			assert.ok(!/oldest first: 4 /.test(line), 'the wedged commit is not its own holder');
		});

		// The suffix is a diagnostic on the failure path: it must never become the failure.
		it('still raises the 503 when the registry throws while building the suffix', async function () {
			if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') this.skip();
			const originalError = harperLogger.error;
			harperLogger.error = () => {};
			setRegistryStatusForTests(() => {
				throw new Error('boom');
			});
			try {
				trackAStuckCommit();
				await waitFor(() => {
					try {
						new DatabaseTransaction().checkOverloaded();
						return false;
					} catch (error) {
						assert.strictEqual(error.statusCode, 503);
						return true;
					}
				}, 2000);
			} finally {
				harperLogger.error = originalError;
			}
		});
	});

	// A store's rootStore.path is what checkOverloaded() hands the lookup, and registryStatus() reports
	// the database's own path — if those two ever stop being the same string, every candidate list goes
	// silently empty. Asserted against the real registry rather than a stub, which is the only way to
	// catch a drift in either producer.
	describe('the store path joins to the registry path', () => {
		it('finds a real table’s database in the real registry', function () {
			if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') this.skip();
			setRegistryStatusForTests(registryStatus);
			const JoinTable = table({
				table: 'HolderJoinTable',
				database: 'test',
				attributes: [{ name: 'id', isPrimaryKey: true }],
			});
			const storePath = JoinTable.primaryStore.rootStore.path;
			assert.ok(storePath, 'a table store must expose its database path');
			assert.ok(
				registryStatus().some((entry) => path.resolve(entry.path) === path.resolve(storePath)),
				'the path checkOverloaded() looks up must be a path the registry reports'
			);
		});
	});

	// A write to a second database attaches its OWN native handle to a `.next` link, while only the
	// chain root enters supervisedWriteRoots. A link that never reads is in neither registry, so
	// reporting the monitor's entry alone named an id the sweep's line could not be joined to whenever
	// that child was the intent holder. The monitor must reach it through the chain.
	describe('chain-link attribution', () => {
		// Drives one logical transaction across two databases and hands the test its links plus a matcher
		// for the second link's own log line. Matched on that link's table, not on its native id: ids are
		// allocated per database descriptor, so the root in `test` and this link in its own database both
		// hold id 4 here, and an id-only match silently asserts against the root's line.
		async function withChainLinks(inspect) {
			setMainIsWorker(true);
			const Primary = table({
				table: 'ChainPrimaryTable',
				database: 'test',
				attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'v' }],
			});
			const Secondary = table({
				table: 'ChainSecondaryTable',
				database: 'chain-attribution-secondary',
				attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'v' }],
			});
			setRegistryStatusForTests(registryStatus);
			env.setProperty(THRESHOLD, '0.02');
			// sourceApply is exempt from reaping, which is what keeps both links open long enough for the
			// monitor to observe them — and is the #2471 shape besides.
			const context = { sourceApply: true };
			const trackedTxns = setTxnExpiration(20);
			try {
				await transaction(context, async () => {
					await Primary.put(1, { v: 'root' }, context);
					await Secondary.put(1, { v: 'second' }, context);
					const links = [];
					for (let txn = context.transaction; txn; txn = txn.next) if (txn.db) links.push(txn);
					assert.strictEqual(links.length, 2, 'the second database must be a chain link');
					// Captured now, not at assertion time: the handle is released as soon as the logical
					// transaction settles, and the reporting window closes with it.
					const childId = links[1].transaction?.id;
					assert.ok(childId !== undefined, 'the child link must own a native handle');
					// put() reads the prior entry, which is what puts this link in trackedTxns; a link whose
					// write never reads is not. Drop it to leave it reachable only through the root's chain,
					// which is the shape the walk has to cover.
					trackedTxns.delete(links[1]);
					const childLine = () =>
						warningsMatching('Harper transaction has held').find(([message]) =>
							message.includes('ChainSecondaryTable')
						)?.[0];
					await inspect(links, childLine, childId);
				});
			} finally {
				setTxnExpiration(30000);
			}
		}

		it('names a chain link reachable only through the root under its own native id', async function () {
			this.timeout(15000);
			if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') this.skip();
			await withChainLinks(async (links, childLine, childId) => {
				resetLongLivedTransactionReportsForTests();
				warnings.length = 0;
				await waitFor(() => childLine() !== undefined, 10000);
				assert.match(
					childLine(),
					new RegExp(`transaction ${childId}\\b`),
					'the link must be named under its own native id, which is what the sweep line joins to'
				);
				// The link was just written, so its write recency is armed: hiding that would report a link
				// the application is actively using as merely over-limit.
				assert.match(childLine(), /state: [^,]*active/);
			});
		});

		// `active` for a chain link must come from `writeTimeout`, the clock chainStillActive decays, not
		// from `timeout`, which nothing decays for a link the tick never enters on — reading `timeout`
		// would report a link idle for hours as actively writing, the inverse of the diagnosis.
		it('does not call a chain link active once its write recency has decayed', async function () {
			this.timeout(15000);
			if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') this.skip();
			await withChainLinks(async (links, childLine) => {
				links[1].writeTimeout = 0;
				links[1].timeout = 60000;
				resetLongLivedTransactionReportsForTests();
				warnings.length = 0;
				await waitFor(() => childLine() !== undefined, 10000);
				assert.ok(
					!/state: [^,]*active/.test(childLine()),
					`an idle chain link must not be reported as actively writing: ${childLine()}`
				);
			});
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
