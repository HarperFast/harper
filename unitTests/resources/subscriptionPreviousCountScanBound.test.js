require('../testUtils');
const assert = require('assert');
const { setTimeout: delay } = require('timers/promises');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { logger } = require('#src/utility/logging/logger');
require('#src/server/serverHelpers/serverUtilities');

// #1786 review (heskew): a subscription's `previousCount` history backfill filters denied rows
// BEFORE decrementing `count` (the AUTHORIZED-event budget), so an all-deny row-level allowRead
// override removes count's work bound entirely — the scan would otherwise walk the full retained
// audit log. Table.ts now also bounds entries INSPECTED, independent of `count`, and logs once
// when that independent cap is what stopped the scan.
//
// The count branch uses `start: 'z'` for reverse audit log iteration, which is an lmdb-specific
// encoding ('z' compares above numeric keys) — same pre-existing rocksdb incompatibility noted in
// subscriptionReplay.test.js.
const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

describe('Subscription previousCount backfill scan bound (#1786)', () => {
	if (!isLMDB) return;

	let ScanBoundTable;
	let warnings;
	let originalWarn;

	before(async function () {
		this.timeout(0);
		setupTestDBPath();
		setMainIsWorker(true);
		ScanBoundTable = table({
			table: 'SubPrevCountScanBound',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
			audit: true,
		});
		// A record-scoped, sync, ALWAYS-DENYING override. Table.prototype.subscribe only gates its
		// row-level filter on `request.rowLevelAuthChecked` and this not being the framework default
		// — it doesn't require going through the full Resource.subscribe entry-check wrapper, so
		// setting rowLevelAuthChecked directly on the request (below) is sufficient to arm it here.
		ScanBoundTable.prototype.allowRead = function () {
			return false;
		};
	});

	beforeEach(function () {
		warnings = [];
		originalWarn = logger.warn;
		logger.warn = (...args) => warnings.push(args);
	});

	afterEach(function () {
		logger.warn = originalWarn;
	});

	it('an all-deny override stops the backfill at the inspected-entry cap, not a full log walk', async function () {
		this.timeout(0);
		// #1786's MAX_PREVIOUS_COUNT_SCAN cap in Table.ts — kept in sync here rather than exported,
		// matching this file's other magic numbers being test-local constants.
		const MAX_PREVIOUS_COUNT_SCAN = 10_000;
		const N = MAX_PREVIOUS_COUNT_SCAN + 250; // comfortably past the cap
		for (let i = 0; i < N; i++) {
			await ScanBoundTable.put(i, { name: 'v' + i });
		}

		const start = Date.now();
		const subscription = await ScanBoundTable.subscribe({
			previousCount: 5,
			isCollection: true,
			rowLevelAuthChecked: true,
		});
		const events = [];
		subscription.on('data', (e) => events.push(e));
		// Every candidate is denied, so nothing will ever arrive — wait on the diagnostic instead of
		// a data event.
		const deadline = Date.now() + 30_000;
		while (warnings.length === 0 && Date.now() < deadline) {
			await delay(20);
		}
		const elapsedMs = Date.now() - start;
		subscription.return?.();

		assert.equal(events.length, 0, `an all-deny override must not deliver any history events, got ${events.length}`);
		assert.ok(
			warnings.length > 0,
			'expected the "stopped after inspecting" diagnostic to fire — the scan either walked the whole log or never bounded'
		);
		const [message] = warnings[0];
		assert.match(message, /stopped after inspecting 10000 in-scope audit records/);
		assert.match(message, /returning 0 instead/);
		// Loose bound: proves the scan didn't walk all N (250 more than the cap) — not a tight perf
		// assertion, just a sanity check that inspecting ~10k in-memory audit entries and bailing is
		// fast, rather than the many additional seconds a full walk of the (still-growing) log would
		// take on a slower CI runner.
		assert.ok(
			elapsedMs < 10_000,
			`backfill took ${elapsedMs}ms — expected it to stop well before scanning all ${N} records`
		);
	});
});
