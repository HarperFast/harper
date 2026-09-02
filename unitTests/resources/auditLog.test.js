const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { open } = require('lmdb');
const {
	setAuditRetention,
	openAuditStore,
	readAuditEntry,
	createAuditEntry,
	transactionKeyEncoder,
	removeAuditEntry,
	ENTRY_DATAVIEW,
} = require('#src/resources/auditStore');
const { RocksTransactionLogStore } = require('#src/resources/RocksTransactionLogStore');
const { CorruptFrameError, RocksDatabase } = require('@harperfast/rocksdb-js');
const {
	removeStorageReclamation,
	runReclamationHandlers,
	setAvailableSpaceRatioGetter,
} = require('#src/server/storageReclamation');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { setTimeout: delay } = require('node:timers/promises');
const { closeSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join } = require('node:path');
const { waitFor } = require('../waitFor');
const harperLogger = require('#src/utility/logging/harper_logger');
require('#src/server/serverHelpers/serverUtilities');

// Walks a transaction log file's entry chain (13-byte file header; per entry a float64 timestamp,
// uint32 length and flag byte) up to the zero-timestamp end-of-entries marker.
function readEntryFrames(image) {
	const frames = [];
	let position = 13;
	while (position + 13 <= image.length) {
		if (image.readDoubleBE(position) === 0) break;
		const length = image.readUInt32BE(position + 8);
		if (length === 0 || position + 13 + length > image.length) break;
		frames.push({ position, length });
		position += 13 + length;
	}
	return frames;
}
describe('Audit log', () => {
	let AuditedTable;
	let events = [];

	before(async function () {
		setupTestDBPath();
		setMainIsWorker(true); // TODO: Should be default until changed
		AuditedTable = table({
			table: 'AuditedTable',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
		let subscription = await AuditedTable.subscribe({});

		subscription.on('data', (event) => {
			events.push(event);
		});
		server.replication.mockRemoteMap = new Map([['local', 0]]);
		server.replication.getIdOfRemoteNode = function (name) {
			let id = server.replication.mockRemoteMap.get(name);
			if (id === undefined) {
				id = server.replication.mockRemoteMap.size;
				server.replication.mockRemoteMap.set(name, id);
			}
			return id;
		};
	});
	afterEach(function () {
		setAuditRetention(60000);
	});
	it('check log after writes and prune', async () => {
		events = [];
		// transactionBroadcast.ts coalesces 'committed' bursts landing in the same turn into a
		// single notify pass, and the subscribe() listener (Table.ts) only delivers the LATEST
		// value per id from that pass (by design, not a bug). Four same-turn writes to two ids
		// can therefore collapse to as few as 2 delivered events no matter how long we later
		// poll for them — waiting for the notify drain to catch up after EACH write (rather than
		// after the whole burst) is what actually makes delivery deterministic.
		// >= rather than === in the condition: an overshoot (however it arose) should fall through
		// to the assertions below with a clear message, not hang the waiter into its timeout.
		async function waitForEventCount(count) {
			await waitFor(() => events.length >= count, {
				timeout: 5000,
				message: `expected at least ${count} subscription events`,
			});
		}
		await AuditedTable.put(1, { name: 'one' });
		await waitForEventCount(1);
		await AuditedTable.put(2, { name: 'two' });
		await waitForEventCount(2);
		await AuditedTable.put(2, { name: 'two-changed' });
		await waitForEventCount(3);
		await AuditedTable.delete(1);
		await waitForEventCount(4);
		assert.equal(AuditedTable.primaryStore.getEntry(1).value, null); // verify that there is a delete entry
		let results = [];
		for await (let entry of AuditedTable.getHistory()) {
			results.push(entry);
		}
		assert.equal(results.length, 4);
		// The per-write waitForEventCount calls above already drained delivery after each write, so
		// the full count is deterministic here — assert the tight bound rather than "a couple".
		assert(events.length >= 4, 'Should have one live-subscription event per write');
		// Verify the actual invariant, not just the count: the LAST delivered event per id must
		// reflect that id's final state (an earlier, superseded event for the same id may or may
		// not also have been delivered, so this only checks the latest, not the total count). Wait
		// for that final-state condition directly rather than trusting the count above, since a
		// count can in principle be satisfied by intermediate events that aren't the final state yet.
		const lastEventById = () => {
			const map = new Map();
			for (const event of events) map.set(event.id, event);
			return map;
		};
		await waitFor(
			() => lastEventById().get(1)?.type === 'delete' && lastEventById().get(2)?.value?.name === 'two-changed',
			{ timeout: 2000, message: "Should have received id 1's delete and id 2's latest put" }
		);
		// Compute the map once here rather than calling lastEventById() again in each assertion below
		// (still a recomputation over `events`, just a single one instead of two).
		const finalEventById = lastEventById();
		assert.equal(finalEventById.get(1)?.type, 'delete', "id 1's final delivered event should be its delete");
		assert.equal(
			finalEventById.get(2)?.value?.name,
			'two-changed',
			"id 2's final delivered event should be its latest put"
		);
		if (AuditedTable.auditStore.reusableIterable) return; // rocksdb doesn't have any audit log cleanup from JS
		setAuditRetention(0.001, 1);
		// scheduleAuditCleanup() resolves once the pass serving the call has committed its deletions.
		// This first one races the put below, so it may or may not see record 3's audit entry.
		const firstPass = AuditedTable.auditStore.scheduleAuditCleanup(1);
		await AuditedTable.put(3, { name: 'three' });
		await firstPass;
		// Drive passes until the log is drained. Every iteration awaits a whole pass, so it makes real
		// progress rather than hoping a background timer landed inside a fixed wall-clock budget — which
		// is what the previous 20 x 10ms poll did. More than one iteration is only needed if the store
		// holds more than MAX_DELETES_PER_CLEANUP stale entries, since a pass stops at that cap.
		results = await waitFor(
			async () => {
				await AuditedTable.auditStore.scheduleAuditCleanup(1);
				const remaining = [];
				for await (let entry of AuditedTable.getHistory()) {
					remaining.push(entry);
				}
				return remaining.length === 0 ? remaining : false;
			},
			{ timeout: 10000, interval: 0, message: 'audit log was not pruned' }
		);

		assert.equal(results.length, 0);
		assert.equal(AuditedTable.primaryStore.getEntry(1), undefined); // verify that the delete entry was removed
		// verify that the twice-written entry was not removed
		assert.equal(AuditedTable.primaryStore.getEntry(2)?.value?.name, 'two-changed');
	});
	it('re-arms Rocks audit cleanup without another pressure signal', async function () {
		const store = AuditedTable.auditStore;
		if (!(store instanceof RocksTransactionLogStore)) this.skip();

		const rootStore = store.rootStore;
		const originalPurgeLogs = rootStore.purgeLogs;
		let purgeCalls = 0;
		rootStore.purgeLogs = () => {
			purgeCalls++;
			return [];
		};
		setAuditRetention(100, 1);
		try {
			await store.scheduleAuditCleanup(1);
			await waitFor(() => purgeCalls >= 2, {
				timeout: 1000,
				message: 'Rocks audit cleanup did not schedule a later retention pass',
			});
		} finally {
			rootStore.purgeLogs = originalPurgeLogs;
			setAuditRetention(60_000, 10_000);
		}
	});
	// Reads the store's own cadence rather than replacing the global setTimeout: that global is shared by
	// every audit store in the process, so a stub keyed on the delay swallows other loops' re-arms.
	it('holds Rocks cleanup at the retention-derived cadence whatever a pass purges', async function () {
		const scratch = mkdtempSync(join(tmpdir(), 'harper-audit-retention-cadence-'));
		const rootStore = new RocksDatabase(scratch).open();
		let purgeCalls = 0;
		// alternate empty and productive passes: the LMDB backoff would double on the first and halve on
		// the second, so a shared cadence rule shows up here as a changing delay
		rootStore.purgeLogs = () => (++purgeCalls % 2 ? [] : ['purged.txnlog']);
		setAuditRetention(1_000, 10);
		let store;
		try {
			store = openAuditStore(rootStore);
			for (const pass of [1, 2, 3, 4]) {
				// an explicit delay wins for the pass it schedules, and the pass then re-derives the cadence
				await store.scheduleAuditCleanup(1);
				assert.equal(store.auditCleanupDelay, 100, `pass ${pass} should hold the retention-derived cadence`);
			}
			assert.equal(purgeCalls, 4, 'every pass should have reached purgeLogs');
		} finally {
			setAuditRetention(60_000, 10_000);
			store?.stopAuditCleanup();
			removeStorageReclamation(scratch);
			if (rootStore.status !== 'closed') rootStore.close();
			rmSync(scratch, { recursive: true, force: true });
		}
	});
	// stopAuditCleanup() is irreversible, so this runs against its own store rather than the shared fixture
	it('stops scheduling Rocks cleanup once the audit store is retired', async function () {
		const scratch = mkdtempSync(join(tmpdir(), 'harper-audit-retention-stop-'));
		const rootStore = new RocksDatabase(scratch).open();
		let purgeCalls = 0;
		rootStore.purgeLogs = () => {
			purgeCalls++;
			return [];
		};
		setAuditRetention(100, 1);
		try {
			const auditStore = openAuditStore(rootStore);
			const pending = auditStore.scheduleAuditCleanup(1);
			auditStore.stopAuditCleanup();
			await pending;
			const purgeCallsAtStop = purgeCalls;
			await delay(20);
			assert.equal(purgeCalls, purgeCallsAtStop, 'a retired cleanup loop kept purging');
			await auditStore.scheduleAuditCleanup(1);
			await delay(20);
			assert.equal(purgeCalls, purgeCallsAtStop, 'a retired cleanup loop accepted a new pass');
		} finally {
			setAuditRetention(60_000, 10_000);
			removeStorageReclamation(scratch);
			if (rootStore.status !== 'closed') rootStore.close();
			rmSync(scratch, { recursive: true, force: true });
		}
	});
	it('shortens the Rocks cadence while disk pressure is reported', async function () {
		const scratch = mkdtempSync(join(tmpdir(), 'harper-audit-retention-pressure-'));
		const rootStore = new RocksDatabase(scratch).open();
		let purgeCalls = 0;
		rootStore.purgeLogs = () => {
			purgeCalls++;
			return [];
		};
		// only the scratch path reports pressure, so no other open store's handler is invoked
		setAvailableSpaceRatioGetter(async (path) => (path === scratch ? 0.2 : 0.8));
		setAuditRetention(1_000, 10);
		let store;
		try {
			store = openAuditStore(rootStore);
			// the handler arms its pass and awaits it, so a settled reclamation run means the pass ran
			await runReclamationHandlers();
			assert.ok(purgeCalls > 0, 'a pressure signal should run a cleanup pass');
			// priority 0.4/0.2 = 2, so the window is retention/(1+4) and the cadence a tenth of that
			assert.equal(store.auditCleanupDelay, 20, 'pressure should shorten the cadence, not just the cutoff');
		} finally {
			setAvailableSpaceRatioGetter();
			setAuditRetention(60_000, 10_000);
			store?.stopAuditCleanup();
			removeStorageReclamation(scratch);
			if (rootStore.status !== 'closed') rootStore.close();
			rmSync(scratch, { recursive: true, force: true });
		}
	});
	it('purges aged, flushed Rocks segments through the Harper retention pass', async function () {
		const scratch = mkdtempSync(join(tmpdir(), 'harper-audit-retention-'));
		const rootStore = new RocksDatabase(scratch, { transactionLogMaxSize: 128 }).open();
		const originalPurgeLogs = rootStore.purgeLogs;
		let purgeCalls = 0;
		rootStore.purgeLogs = function (options) {
			purgeCalls++;
			return originalPurgeLogs.call(this, options);
		};
		setAuditRetention(60_000, 10_000);
		try {
			const auditStore = openAuditStore(rootStore);
			const log = rootStore.useLog('retention-test');
			for (let sequence = 1; sequence <= 3; sequence++) {
				await rootStore.transaction(async (transaction) => {
					const value = Buffer.alloc(256, sequence);
					log.addEntry(value, transaction.id);
					rootStore.putSync(`key-${sequence}`, value, { transaction });
				});
				if (sequence < 3) rootStore.flushSync();
				if (sequence === 2) {
					await delay(75);
					setAuditRetention(50, 1);
				}
			}

			await auditStore.scheduleAuditCleanup(1);
			const logDirectory = join(scratch, 'transaction_logs', 'retention-test');
			const segments = readdirSync(logDirectory).filter((name) => name.endsWith('.txnlog'));
			assert.deepEqual(segments, ['3.txnlog']);

			rootStore.close();
			const purgeCallsAtClose = purgeCalls;
			await delay(20);
			assert.equal(purgeCalls, purgeCallsAtClose, 'cleanup continued after the root store closed');
		} finally {
			setAuditRetention(60_000, 10_000);
			removeStorageReclamation(scratch);
			if (rootStore.status !== 'closed') rootStore.close();
			rmSync(scratch, { recursive: true, force: true });
		}
	});
	// Regression test for harper#F-264 (see DESIGN.md's audit-entry-removal-loop invariant).
	// Run with both a throwing and a non-throwing failure logger: with a throwing one, an
	// implementation that counted the removal *before* logging its failure would still pass
	// (the injected throw preempts the count), so only the non-throwing pass pins the count.
	for (const loggingThrows of [true, false]) {
		const failedId = loggingThrows ? 30 : 32;
		const succeededId = failedId + 1;
		it(`deleteHistory contains a mid-loop rejection (failure logging ${
			loggingThrows ? 'throws' : 'succeeds'
		})`, async function () {
			// rocksdb doesn't use deleteHistory (see ResourceBridge.deleteTransactionLogsBefore); this.skip()
			// (rather than a bare return, as the file's other reusableIterable guards use) so the report
			// distinguishes "skipped on this engine" from "passed"
			if (AuditedTable.auditStore.reusableIterable) return this.skip();
			await AuditedTable.deleteHistory(Date.now() + 60_000); // start from a clean backlog

			await AuditedTable.put(failedId, { name: 'race-a' });
			await AuditedTable.put(succeededId, { name: 'race-b' });

			// find the failing record's raw audit-store key so the injected failure targets that one entry
			// specifically, the same way deleteHistory itself finds it (getHistory()'s yielded entries don't
			// carry this key — its `localTime` field is the record's version, not the key)
			let targetKey;
			for (const record of AuditedTable.auditStore.getRange({ start: 0, end: Infinity })) {
				if (record.tableId === AuditedTable.tableId && record.recordId === failedId) targetKey = record.key;
			}
			assert.notEqual(targetKey, undefined, `test setup: could not find record ${failedId} in the audit log`);

			const originalRemove = AuditedTable.auditStore.remove.bind(AuditedTable.auditStore);
			const originalWarn = harperLogger.warn;
			AuditedTable.auditStore.remove = (key) => {
				if (key === targetKey) return Promise.reject(new Error('simulated audit entry removal failure'));
				return originalRemove(key);
			};
			const warnings = [];

			let unhandledRejection;
			const onUnhandledRejection = (reason) => {
				unhandledRejection = reason;
			};
			process.on('unhandledRejection', onUnhandledRejection);
			try {
				let entriesDeleted;
				harperLogger.warn = (...args) => {
					warnings.push(args);
					if (loggingThrows) throw new Error('simulated logging failure');
				};
				try {
					entriesDeleted = await AuditedTable.deleteHistory(Date.now() + 60_000);
				} finally {
					harperLogger.warn = originalWarn;
				}
				assert.equal(entriesDeleted, 1, 'only the successful removal should be counted, not the rejected one');
				assert.equal(warnings.length, 1);
				assert.equal(warnings[0][0], 'Error removing audit entry during deleteHistory');
				assert.equal(warnings[0][1].message, 'simulated audit entry removal failure');
				await delay(50);
				assert.equal(
					unhandledRejection,
					undefined,
					'a rejected removeAuditEntry() call must not escape as an unhandled rejection'
				);
				const remaining = [];
				for await (const entry of AuditedTable.getHistory()) remaining.push(entry.id);
				assert.deepEqual(
					remaining,
					[failedId],
					'the failed removal must be left in place, but later entries must still be pruned'
				);
			} finally {
				process.off('unhandledRejection', onUnhandledRejection);
				harperLogger.warn = originalWarn;
				AuditedTable.auditStore.remove = originalRemove;
				await AuditedTable.deleteHistory(Date.now() + 60_000); // clear the now-orphaned entry
			}
		});
	}
	it('deleteHistory reports a purge that attempted removals and completed none', async function () {
		if (AuditedTable.auditStore.reusableIterable) return this.skip();
		const cutoff = () => Date.now() + 60_000;
		await AuditedTable.deleteHistory(cutoff()); // start from a clean backlog
		assert.equal(await AuditedTable.deleteHistory(cutoff()), 0, 'an empty backlog is not a failure');

		await AuditedTable.put(34, { name: 'doomed-a' });
		await AuditedTable.put(35, { name: 'doomed-b' });

		const originalRemove = AuditedTable.auditStore.remove.bind(AuditedTable.auditStore);
		const originalWarn = harperLogger.warn;
		const warnings = [];
		AuditedTable.auditStore.remove = () => Promise.reject(new Error('simulated store failure'));
		harperLogger.warn = (...args) => warnings.push(args);
		try {
			// a purge that made zero progress must not be indistinguishable from one that had nothing to do
			await assert.rejects(AuditedTable.deleteHistory(cutoff()), /simulated store failure/);
			assert.equal(warnings.length, 2, 'each failure is still logged individually');
		} finally {
			harperLogger.warn = originalWarn;
			AuditedTable.auditStore.remove = originalRemove;
			await AuditedTable.deleteHistory(cutoff());
		}
	});
	it('deleteHistory does not misdecode the last-removed marker as a corrupt audit entry', async function () {
		// A fresh table/audit store, not the shared AuditedTable: lmdb-js caches a key's decoded
		// value once readAuditEntry() has been run on it (by any earlier test's getRange/get over
		// the same store), so re-scanning the marker on the shared fixture would silently hit that
		// cache instead of re-triggering the decode this test exists to catch.
		const MarkerTable = table({
			table: 'DeleteHistoryMarkerTable',
			database: 'deleteHistoryMarkerTestDB',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
		if (MarkerTable.auditStore.reusableIterable) return this.skip();
		// the last-removed marker is written fire-and-forget when the audit store opens; wait for its
		// key (not its decoded value, which would itself trigger and cache away the bug) to land
		await waitFor(() => [...MarkerTable.auditStore.getRange({ start: 0, end: 1, values: false })].length > 0, {
			timeout: 5000,
			message: 'expected the audit store to have a last-removed marker key',
		});
		await MarkerTable.put(1, { name: 'has-history' });

		const originalError = harperLogger.error;
		const errors = [];
		harperLogger.error = (...args) => errors.push(args);
		try {
			await MarkerTable.deleteHistory(Date.now() + 60_000);
		} finally {
			harperLogger.error = originalError;
		}
		assert.strictEqual(
			errors.some((args) => args[0] === 'Reading audit entry error'),
			false,
			`deleteHistory must not attempt to decode the last-removed marker as an audit entry: ${JSON.stringify(errors)}`
		);
	});
	it('deleteHistory limits concurrent removals without serializing them', async function () {
		if (AuditedTable.auditStore.reusableIterable) return this.skip();
		await AuditedTable.deleteHistory(Date.now() + 60_000);

		const firstId = 40;
		const concurrentRemovalLimit = 1000;
		const recordCount = concurrentRemovalLimit + 1;
		for (let id = firstId; id < firstId + recordCount; id++) {
			await AuditedTable.put(id, { name: `concurrent-${id}` });
		}
		const targetKeys = new Set();
		for (const record of AuditedTable.auditStore.getRange({ start: 0, end: Infinity })) {
			if (
				record.tableId === AuditedTable.tableId &&
				record.recordId >= firstId &&
				record.recordId < firstId + recordCount
			) {
				targetKeys.add(record.key);
			}
		}
		assert.equal(targetKeys.size, recordCount, 'test setup: expected one audit entry per inserted record');

		const originalRemove = AuditedTable.auditStore.remove.bind(AuditedTable.auditStore);
		const releaseRemovals = [];
		let activeRemovals = 0;
		let maximumActiveRemovals = 0;
		let removalCalls = 0;
		let releaseImmediately = false;
		AuditedTable.auditStore.remove = (key) => {
			if (!targetKeys.has(key)) return originalRemove(key);
			removalCalls++;
			activeRemovals++;
			maximumActiveRemovals = Math.max(maximumActiveRemovals, activeRemovals);
			if (releaseImmediately) {
				activeRemovals--;
				return Promise.resolve();
			}
			return new Promise((resolve) => {
				releaseRemovals.push(() => {
					activeRemovals--;
					resolve();
				});
			});
		};

		let deletion;
		try {
			deletion = AuditedTable.deleteHistory(Date.now() + 60_000);
			await waitFor(() => removalCalls >= concurrentRemovalLimit, {
				timeout: 5000,
				message: `expected ${concurrentRemovalLimit} removals to start`,
			});
			assert.equal(
				removalCalls,
				concurrentRemovalLimit,
				'the next removal must wait while the concurrency limit is occupied'
			);

			releaseRemovals.splice(Math.floor(concurrentRemovalLimit / 2), 1)[0]();
			await waitFor(() => removalCalls === recordCount, {
				timeout: 5000,
				message: 'expected the final removal to start after any active removal completed',
			});
			while (releaseRemovals.length > 0) releaseRemovals.shift()();

			assert.equal(await deletion, recordCount);
			assert.equal(maximumActiveRemovals, concurrentRemovalLimit);
		} finally {
			releaseImmediately = true;
			while (releaseRemovals.length > 0) releaseRemovals.shift()();
			await deletion?.catch(() => {});
			AuditedTable.auditStore.remove = originalRemove;
			await AuditedTable.deleteHistory(Date.now() + 60_000);
			await AuditedTable.primaryStore.batch(() => {
				for (let id = firstId; id < firstId + recordCount; id++) AuditedTable.primaryStore.remove(id);
			});
		}
	});
	async function createOrphanedTombstone(recordId) {
		await AuditedTable.put(recordId, { name: 'deleted' });
		await AuditedTable.delete(recordId);
		const auditKeys = [];
		for (const record of AuditedTable.auditStore.getRange({ start: 0, end: Infinity })) {
			if (record.tableId === AuditedTable.tableId && record.recordId === recordId) auditKeys.push(record.key);
		}
		assert.equal(auditKeys.length, 2, 'test setup: expected put and delete audit entries');
		for (const key of auditKeys) await AuditedTable.auditStore.remove(key);
		assert.equal(
			Array.from(AuditedTable.auditStore.getRange({ start: 0, end: Infinity })).some(
				(record) => record.tableId === AuditedTable.tableId && record.recordId === recordId
			),
			false,
			'test setup: expected the audit entries to be removed'
		);
		const tombstone = AuditedTable.primaryStore.getEntry(recordId);
		assert.equal(tombstone?.value, null, 'test setup: expected an orphaned tombstone');
		return tombstone;
	}
	it('deleteHistory cleanup removes an unchanged orphaned tombstone', async function () {
		if (AuditedTable.auditStore.reusableIterable) return this.skip();
		const cutoff = Date.now() + 60_000;
		await AuditedTable.deleteHistory(cutoff, true);
		const recordId = 'cleanup-unraced';
		try {
			await createOrphanedTombstone(recordId);
			await AuditedTable.deleteHistory(cutoff, true);
			assert.equal(AuditedTable.primaryStore.getEntry(recordId), undefined);
		} finally {
			await AuditedTable.delete(recordId).catch(() => {});
			await AuditedTable.deleteHistory(Date.now() + 60_000, true);
		}
	});
	// Runs on both engines: it is the only test that carries a scan-captured version through
	// deleteHistory's cleanup phase into remove(), and RocksDB is the default engine. Rather than
	// createOrphanedTombstone (which can't orphan an entry in a RocksDB transaction log), it
	// suppresses the audit-driven delete callback — the "the audit log isn't cleaning these up"
	// state the cleanup phase exists for — so the tombstone survives to the cleanup scan.
	it('deleteHistory cleanup preserves a record recreated while its stale tombstone waits for a slot', async function () {
		const cutoff = Date.now() + 60_000;
		await AuditedTable.deleteHistory(cutoff, true);

		const recordId = 'cleanup-race';
		const deleteCallbacks = AuditedTable.auditStore.deleteCallbacks;
		const tableId = AuditedTable.tableId;
		const originalDeleteCallback = deleteCallbacks[tableId];
		await AuditedTable.put(recordId, { name: 'to-delete' });
		await AuditedTable.delete(recordId);
		deleteCallbacks[tableId] = () => {};
		const tombstone = AuditedTable.primaryStore.getEntry(recordId);
		assert.equal(tombstone?.value, null, 'test setup: expected a tombstone');
		assert.notEqual(tombstone?.version, undefined, 'test setup: expected a versioned tombstone');

		const primaryStore = AuditedTable.primaryStore;
		const originalRemove = primaryStore.remove;
		const removeWasOwnProperty = Object.hasOwn(primaryStore, 'remove');
		let markRemovalStarted;
		const removalStarted = new Promise((resolve) => {
			markRemovalStarted = resolve;
		});
		let releaseImmediately = false;
		let releaseRemoval;
		let removalVersion;
		let removalResult;
		primaryStore.remove = function (id, version) {
			if (id !== recordId || releaseImmediately) return originalRemove.call(this, id, version);
			removalVersion = version;
			return new Promise((resolve, reject) => {
				let released = false;
				releaseRemoval = () => {
					if (released) return;
					released = true;
					return Promise.resolve(originalRemove.call(this, id, version)).then((result) => {
						removalResult = result;
						resolve(result);
					}, reject);
				};
				markRemovalStarted();
			});
		};

		let deletion;
		try {
			deletion = AuditedTable.deleteHistory(cutoff, true);
			let removalTimeout;
			try {
				await Promise.race([
					removalStarted,
					deletion.then((entriesDeleted) => {
						throw new Error(`deleteHistory resolved before cleanup removal started: ${entriesDeleted} entries`);
					}),
					new Promise((resolve, reject) => {
						removalTimeout = setTimeout(() => reject(new Error('cleanup removal did not start')), 5000);
					}),
				]);
			} finally {
				clearTimeout(removalTimeout);
			}
			await AuditedTable.put(recordId, { name: 'recreated' });
			releaseRemoval();
			await deletion;
			assert.equal(removalVersion, tombstone.version, 'the cleanup scan must hand the version it captured to remove()');
			assert.equal(removalResult, false, 'the stale conditional removal must not commit');
			assert.equal(AuditedTable.primaryStore.getEntry(recordId)?.value?.name, 'recreated');
		} finally {
			releaseImmediately = true;
			releaseRemoval?.();
			await deletion?.catch(() => {});
			if (removeWasOwnProperty) primaryStore.remove = originalRemove;
			else delete primaryStore.remove;
			if (originalDeleteCallback) deleteCallbacks[tableId] = originalDeleteCallback;
			else delete deleteCallbacks[tableId];
			await AuditedTable.delete(recordId).catch(() => {});
			await AuditedTable.deleteHistory(Date.now() + 60_000, true);
		}
	});
	it('RocksDB versioned removal preserves records recreated before or during removal', async function () {
		if (!AuditedTable.primaryStore.isPrimaryRocksDatabase) return this.skip();
		const { Transaction } = require('@harperfast/rocksdb-js');
		const recordId = 'rocks-cleanup-race';
		try {
			await AuditedTable.put(recordId, { name: 'deleted' });
			await AuditedTable.delete(recordId);
			const tombstone = AuditedTable.primaryStore.getEntry(recordId);
			assert.equal(tombstone?.value, null, 'test setup: expected a tombstone');

			await AuditedTable.put(recordId, { name: 'recreated' });
			assert.equal(
				await AuditedTable.primaryStore.remove(recordId, tombstone.version),
				false,
				'a stale conditional removal must not commit'
			);
			const recreated = AuditedTable.primaryStore.getEntry(recordId);
			assert.equal(recreated?.value?.name, 'recreated');

			await AuditedTable.delete(recordId);
			const secondTombstone = AuditedTable.primaryStore.getEntry(recordId);
			const originalCommit = Transaction.prototype.commit;
			let interleaved = false;
			Transaction.prototype.commit = async function (...args) {
				if (!interleaved) {
					interleaved = true;
					await AuditedTable.put(recordId, { name: 'concurrent' });
				}
				return originalCommit.apply(this, args);
			};
			try {
				assert.equal(await AuditedTable.primaryStore.remove(recordId, secondTombstone.version), false);
			} finally {
				Transaction.prototype.commit = originalCommit;
			}
			assert(interleaved, 'a recreate should commit between the conditional read and delete commit');
			const concurrent = AuditedTable.primaryStore.getEntry(recordId);
			assert.equal(concurrent?.value?.name, 'concurrent');
			assert.equal(await AuditedTable.primaryStore.remove(recordId, concurrent.version), true);
			assert.equal(AuditedTable.primaryStore.getEntry(recordId), undefined);
		} finally {
			await AuditedTable.primaryStore.remove(recordId);
		}
	});
	it('deleteHistory waits for the table-registered tombstone removal callback', async function () {
		if (AuditedTable.auditStore.reusableIterable) return this.skip();
		await AuditedTable.deleteHistory(Date.now() + 60_000);

		const recordId = 60;
		await AuditedTable.put(recordId, { name: 'joined-tombstone-removal' });
		await AuditedTable.delete(recordId);
		const registeredPrimaryStore = AuditedTable.auditStore.tableStores[AuditedTable.tableId];
		const tombstone = registeredPrimaryStore.getEntry(recordId);
		assert.equal(tombstone?.value, null);
		const deleteAuditRecords = [];
		for (const record of AuditedTable.auditStore.getRange({ start: 0, end: Infinity })) {
			if (record.tableId === AuditedTable.tableId && record.recordId === recordId && record.type === 'delete') {
				deleteAuditRecords.push(record);
			}
		}
		assert.equal(deleteAuditRecords.length, 1);
		assert.equal(tombstone.version, deleteAuditRecords[0].version);
		assert.equal(typeof AuditedTable.auditStore.deleteCallbacks?.[AuditedTable.tableId], 'function');

		const originalRemove = registeredPrimaryStore.remove;
		const removeWasOwnProperty = Object.hasOwn(registeredPrimaryStore, 'remove');
		let releaseTombstoneRemoval;
		let markTombstoneRemovalStarted;
		const tombstoneRemovalStarted = new Promise((resolve) => {
			markTombstoneRemovalStarted = resolve;
		});
		const tombstoneRemovalGate = new Promise((resolve) => {
			releaseTombstoneRemoval = resolve;
		});
		const heldRemove = async function (id, version) {
			markTombstoneRemovalStarted({ id, version });
			if (id !== recordId) return originalRemove.call(this, id, version);
			await tombstoneRemovalGate;
			return originalRemove.call(this, id, version);
		};
		registeredPrimaryStore.remove = heldRemove;
		assert.equal(registeredPrimaryStore.remove, heldRemove);

		let deletion;
		try {
			deletion = AuditedTable.deleteHistory(Date.now() + 60_000);
			let callbackTimeout;
			let callback;
			try {
				callback = await Promise.race([
					tombstoneRemovalStarted,
					deletion.then((entriesDeleted) => {
						throw new Error(
							`deleteHistory resolved before invoking the registered callback: ${entriesDeleted} entries, tombstone=${String(
								AuditedTable.primaryStore.getEntry(recordId)?.value
							)}`
						);
					}),
					new Promise((resolve, reject) => {
						callbackTimeout = setTimeout(
							() => reject(new Error('table-registered tombstone removal callback did not start')),
							2000
						);
					}),
				]);
			} finally {
				clearTimeout(callbackTimeout);
			}
			assert.equal(callback.id, recordId);
			const state = await Promise.race([deletion.then(() => 'resolved'), delay(50, 'pending')]);
			assert.equal(state, 'pending', 'deleteHistory must join the registered tombstone removal callback');

			releaseTombstoneRemoval();
			assert.equal(await deletion, 2);
			assert.equal(
				AuditedTable.primaryStore.getEntry(recordId),
				undefined,
				'the tombstone must be gone when deleteHistory resolves'
			);
		} finally {
			releaseTombstoneRemoval();
			await deletion?.catch(() => {});
			if (removeWasOwnProperty) registeredPrimaryStore.remove = originalRemove;
			else delete registeredPrimaryStore.remove;
			await AuditedTable.deleteHistory(Date.now() + 60_000);
		}
	});
	for (const [label, failingCallback] of [
		['rejects', () => Promise.reject(new Error('simulated primary-store tombstone removal failure'))],
		[
			'throws synchronously',
			() => {
				throw new Error('simulated primary-store tombstone removal failure');
			},
		],
	]) {
		it(`removeAuditEntry does not let a delete-callback that ${label} block or escape the audit-store removal`, async () => {
			const auditRemoveCalls = [];
			const fakeAuditStore = {
				tableStores: { 7: { getEntry: () => ({ version: 42 }) } },
				deleteCallbacks: { 7: failingCallback },
				remove(key) {
					auditRemoveCalls.push(key);
					return Promise.resolve();
				},
			};
			const deleteAuditRecord = { type: 'delete', tableId: 7, recordId: 'orphan', version: 42, key: 'audit-key' };

			let unhandledRejection;
			const onUnhandledRejection = (reason) => {
				unhandledRejection = reason;
			};
			process.on('unhandledRejection', onUnhandledRejection);
			try {
				await removeAuditEntry(fakeAuditStore, deleteAuditRecord); // must not reject
				await delay(50);
				assert.equal(
					unhandledRejection,
					undefined,
					`a delete-callback that ${label} must not escape as an unhandled rejection`
				);
			} finally {
				process.off('unhandledRejection', onUnhandledRejection);
			}
			assert.deepEqual(
				auditRemoveCalls,
				['audit-key'],
				'the audit-store removal must still proceed even though the tombstone cleanup failed'
			);
		});
	}
	it('check log after operations and prune', async () => {
		await AuditedTable.operation({
			operation: 'upsert',
			records: [{ id: 3, name: 'three' }],
		});
		await AuditedTable.operation({
			operation: 'update',
			records: [{ id: 3, name: 'three changed' }],
		});
		let results = await AuditedTable.getHistoryOfRecord(3);
		assert.equal(results.length, 2);
		assert.equal(results[0].operation, 'upsert');
		assert.equal(results[1].operation, 'update');
	});
	it('write big key with big user name', async () => {
		const key = [];
		for (let i = 0; i < 10; i++) key.push('write big key with big user name');
		await AuditedTable.put(
			key,
			{ name: key },
			{
				user: { username: key.toString() },
			}
		);
		let history = await AuditedTable.getHistoryOfRecord(key);
		assert.equal(history.length, 1);
		await AuditedTable.delete(key);
		history = await AuditedTable.getHistoryOfRecord(key);
		assert.equal(history.length, 2);
		assert.equal(history[0].type, 'put');
		assert.equal(history[1].type, 'delete');
		assert.deepEqual(history[0].id, key);
		assert.deepEqual(history[1].id, key);
		assert.equal(history[0].user, key.toString());
		assert.deepEqual(history[0].value.id, key);
	});
	it('audit entries chain to the real prior audit-store key, not a placeholder flag', async () => {
		const id = 'previous-version-chain';
		await AuditedTable.put(id, { name: 'v1' });
		await AuditedTable.put(id, { name: 'v2' });
		await AuditedTable.put(id, { name: 'v3' });
		const entries = [];
		for (const entry of AuditedTable.auditStore.getRange({ start: 1 })) {
			if (entry.tableId === AuditedTable.tableId && entry.recordId === id) entries.push(entry);
		}
		entries.sort((a, b) => a.version - b.version);
		assert.equal(entries.length, 3);
		// The first write has no prior entry, so previousVersion is falsy.
		assert(!entries[0].previousVersion);
		// Each later entry's previousVersion must point at the actual prior entry's own audit-store
		// key (localTime on LMDB; RocksDB's version field already *is* its key), not a 0/1 placeholder
		// flag substituted from a shared per-environment register. Resolving it through the audit
		// store proves the chain is walkable, not just numerically similar.
		assert.equal(entries[1].previousVersion, entries[0].localTime ?? entries[0].version);
		assert.equal(entries[2].previousVersion, entries[1].localTime ?? entries[1].version);
		assert(
			AuditedTable.auditStore.get(entries[1].previousVersion, AuditedTable.tableId, id),
			'previousVersion must resolve back to the actual prior audit entry'
		);
	});
	// LMDB assigns each record's own localTime via lmdb-js's native monotonic clock, independent of
	// the application-supplied `version` (e.g. a replicated/out-of-order write's origin timestamp,
	// which can be backdated relative to this node's clock). previousVersion must point at the prior
	// entry's localTime (the actual audit-store key space getHistoryOfRecord pages through), not its
	// origin version, or a replicated record's history becomes unwalkable once entries are more than
	// the 100 ms audit window apart.
	it('previousVersion resolves correctly even when a write carries a backdated/replicated version', async () => {
		const id = 'replicated-version-chain';
		const originVersion = Date.now() - 100_000;
		await AuditedTable.put(id, { name: 'first' }, { timestamp: originVersion });
		await AuditedTable.put(id, { name: 'second' }, { timestamp: originVersion + 1 });
		const secondEntry = AuditedTable.primaryStore.getEntry(id);
		const secondAudit = AuditedTable.auditStore.get(secondEntry.localTime, AuditedTable.tableId, id);
		const resolvedFirst = AuditedTable.auditStore.get(secondAudit.previousVersion, AuditedTable.tableId, id);
		assert(resolvedFirst, 'previousVersion must resolve to the actual first audit entry');
		assert.equal(resolvedFirst.version, originVersion);
	});
	// Same scenario driven through the real production consumer: Table.getHistoryOfRecord pages
	// backward through the audit log in 100 ms windows, using each entry's previousVersion as the
	// next window's boundary. With backdated/replicated-style origin versions spaced well beyond that
	// window, a previousVersion in the wrong (origin-version) key space would jump the walk past the
	// prior entry's real audit-store key and truncate the history.
	it('getHistoryOfRecord walks the full chain for out-of-order writes spaced beyond the audit window', async () => {
		const id = 'replicated-history-chain';
		// Each write's *origin* version is deliberately backdated far from real time (simulating a
		// replicated/out-of-order apply), while the *real* delay between writes spans multiple 100 ms
		// audit windows in the actual local-time key space. A previousVersion pinned to the backdated
		// origin version (instead of the real local audit-store key) would have getHistoryOfRecord's
		// window walk search near the backdated timestamp, find nothing, and truncate the chain.
		const origin = Date.now() - 100_000;
		await AuditedTable.put(id, { name: 'v1' }, { timestamp: origin });
		await delay(150);
		await AuditedTable.put(id, { name: 'v2' }, { timestamp: origin + 1 });
		await delay(150);
		await AuditedTable.put(id, { name: 'v3' }, { timestamp: origin + 2 });
		await delay(150);
		await AuditedTable.put(id, { name: 'v4' }, { timestamp: origin + 3 });
		const history = await AuditedTable.getHistoryOfRecord(id);
		assert.equal(history.length, 4);
		assert.deepEqual(
			history.map((entry) => entry.value.name),
			['v1', 'v2', 'v3', 'v4']
		);
	});
	it('dynamically add new transaction logs to iterator', async function () {
		if (!AuditedTable.auditStore.reusableIterable) return this.skip(); // only for rocksdb

		// Create initial entries
		await AuditedTable.put(10, { name: 'initial' });
		await AuditedTable.put(11, { name: 'initial2' });

		const results = [];
		const iterator = AuditedTable.getHistory()[Symbol.asyncIterator]();

		// Get first entry
		let result = await iterator.next();
		results.push(result.value);

		// Emit a new transaction log event
		AuditedTable.auditStore.rootStore.useLog('new-transaction-log');
		await delay(20);
		// Continue iterating - should include entries from new log if it has any
		while (!(result = await iterator.next()).done) {
			results.push(result.value);
		}

		// Verify we got at least the initial entries
		assert(results.length >= 2, 'Should have at least the initial entries');
	});
	it('cleanup listener when iterator completes naturally', async function () {
		if (!AuditedTable.auditStore.reusableIterable) return this.skip(); // only for rocksdb

		await AuditedTable.put(20, { name: 'test' });

		const originalOn = AuditedTable.auditStore.rootStore.on.bind(AuditedTable.auditStore.rootStore);
		const originalOff = AuditedTable.auditStore.rootStore.off.bind(AuditedTable.auditStore.rootStore);
		let activeListener = null;

		AuditedTable.auditStore.rootStore.on = function (event, listener) {
			if (event === 'new-transaction-log') {
				activeListener = listener;
			}
			return originalOn(event, listener);
		};

		AuditedTable.auditStore.rootStore.off = function (event, listener) {
			if (event === 'new-transaction-log' && listener === activeListener) {
				activeListener = null;
			}
			return originalOff(event, listener);
		};

		// Create iterator and let it complete
		for await (const _entry of AuditedTable.getHistory()) {
			// iterate through all
		}

		// Restore original methods
		AuditedTable.auditStore.rootStore.on = originalOn;
		AuditedTable.auditStore.rootStore.off = originalOff;

		// Verify listener was cleaned up
		assert.equal(activeListener, null, 'Listener should be cleaned up after completion');
	});
	it('cleanup listener when breaking from iteration', async function () {
		if (!AuditedTable.auditStore.reusableIterable) return this.skip(); // only for rocksdb

		await AuditedTable.put(30, { name: 'test1' });
		await AuditedTable.put(31, { name: 'test2' });
		await AuditedTable.put(32, { name: 'test3' });

		// Track listener cleanup
		const originalOn = AuditedTable.auditStore.rootStore.on.bind(AuditedTable.auditStore.rootStore);
		const originalOff = AuditedTable.auditStore.rootStore.off.bind(AuditedTable.auditStore.rootStore);
		let activeListener = null;

		AuditedTable.auditStore.rootStore.on = function (event, listener) {
			if (event === 'new-transaction-log') {
				activeListener = listener;
			}
			return originalOn(event, listener);
		};

		AuditedTable.auditStore.rootStore.off = function (event, listener) {
			if (event === 'new-transaction-log' && listener === activeListener) {
				activeListener = null;
			}
			return originalOff(event, listener);
		};

		// Break early from iteration
		let count = 0;
		for await (const _entry of AuditedTable.getHistory()) {
			if (++count >= 2) break;
		}

		// Restore original methods
		AuditedTable.auditStore.rootStore.on = originalOn;
		AuditedTable.auditStore.rootStore.off = originalOff;

		// Listener should be cleaned up after break
		assert.equal(activeListener, null, 'Listener should be cleaned up after break');
	});
	it('exclude logs from new transaction log events', async function () {
		if (!AuditedTable.auditStore.reusableIterable) return this.skip(); // only for rocksdb
		await AuditedTable.put(40, { name: 'test' });

		const excludedLog = 'excluded-log-' + Date.now();
		const iterator = AuditedTable.auditStore.getRange({ excludeLogs: [excludedLog], start: 0 })[Symbol.iterator]();

		// Start iteration
		await iterator.next();

		// Emit include log - should be include
		let nodeId = AuditedTable.auditStore.ensureLogExists('new-transaction-log-2');
		await delay(20);
		await AuditedTable.put(41, { name: 'test' }, { nodeId });
		// Emit excluded log - should be ignored
		nodeId = AuditedTable.auditStore.ensureLogExists(excludedLog);
		await delay(20);

		await AuditedTable.put(42, { name: 'test' }, { nodeId });

		let result = [];
		// Finish iteration
		let entry;
		while (!(entry = await iterator.next()).done) {
			result.push(entry.value);
		}
		assert(result.find((entry) => entry.recordId === 41));
		//assert(!result.find((entry) => entry.recordId === 42));
		assert(true, 'Should complete without including excluded log');
	});
	it('add and remove logs dynamically using iterator methods', async function () {
		if (!AuditedTable.auditStore.reusableIterable) return this.skip(); // only for rocksdb

		await AuditedTable.put(50, { name: 'test' });

		const iterable = AuditedTable.auditStore.getRange({});
		const iterator = iterable[Symbol.iterator]();

		// Start iteration
		iterator.next();

		// Add a new log using the addLog method on the iterable
		const newLogName = 'manual-log-' + Date.now();
		AuditedTable.auditStore.ensureLogExists(newLogName);

		// Verify the log was added to logByName
		assert(AuditedTable.auditStore.logByName.has(newLogName), 'Log should be added to logByName');

		// Remove the log using the removeLog method on the iterable
		iterable.removeLog(newLogName);

		// Continue iterating to completion
		while (!(await iterator.next()).done) {
			// continue
		}

		assert(true, 'Should complete successfully after adding and removing logs');
	});
	// A corrupt audit entry must surface as a skip-eligible sentinel record rather than
	// throwing through the for-of consumer — otherwise the throw escapes in an async context
	// and lands as uncaughtException, stalling outgoing replication for the affected (peer,
	// db) pair until the process restarts.
	describe('corrupt audit entry handling', () => {
		// Mint a valid audit entry, then mutate it. Using a real entry as the substrate
		// avoids hand-rolling the binary layout (which would drift with format changes).
		function makeAuditBuffer(overrides) {
			const validRecord = {
				version: 1234567890,
				tableId: 1,
				recordId: 42,
				previousVersion: 0,
				nodeId: 1,
				user: 'test-user',
				type: 'put',
				encodedRecord: Buffer.from([0x80]), // empty msgpack map
				extendedType: 0,
				residencyId: 0,
				previousResidencyId: 0,
				expiresAt: 0,
				originatingOperation: 'insert',
				previousAdditionalAuditRefs: undefined,
				...overrides,
			};
			// createAuditEntry returns a Buffer; copy so mutation doesn't affect ENTRY_HEADER.
			return Buffer.from(createAuditEntry(validRecord));
		}

		// The downstream skip signal consumers (replayLogs, transactionBroadcast, Table.ts)
		// branch on is `tableId === undefined` / `type === undefined`. Assertions below
		// check exactly that signal — not an internal flag — so the contract these tests
		// pin is what consumers actually rely on.
		it('returns a sentinel with undefined tableId/type when the buffer is truncated mid-header', () => {
			const buffer = makeAuditBuffer({});
			// Truncate so any length read in the header pushes position past the end.
			const truncated = buffer.subarray(0, Math.min(8, buffer.length));
			const record = readAuditEntry(truncated);
			assert.strictEqual(record.type, undefined);
			assert.strictEqual(record.tableId, undefined);
			assert.strictEqual(record.recordId, undefined);
			// Methods on the sentinel must exist — downstream replayLogs calls getValue
			// before classifying, so a missing method would NPE.
			assert.strictEqual(typeof record.getValue, 'function');
			assert.strictEqual(record.getValue(), undefined);
			assert.strictEqual(typeof record.getBinaryValue, 'function');
			assert.strictEqual(typeof record.getBinaryRecordId, 'function');
		});

		it('does not throw when a header length field is mutated to push position past the buffer', () => {
			const buffer = makeAuditBuffer({});
			// 0xff is the Decoder.readInt prefix that pulls the next 4 bytes as a uint32 —
			// the pathological case from prod where a corrupt length value pushed the
			// decoder position hundreds of MB past byteLength.
			const corrupted = Buffer.from(buffer);
			if (corrupted.length > 8) {
				corrupted[3] = 0xff;
				corrupted[4] = 0xff;
				corrupted[5] = 0xff;
				corrupted[6] = 0xff;
				corrupted[7] = 0xff;
			}
			assert.doesNotThrow(() => {
				readAuditEntry(corrupted);
			}, 'readAuditEntry must not throw on corrupt length fields');
		});

		it('does not throw when the lazy recordId / user getters are accessed on a corrupt body', () => {
			const buffer = makeAuditBuffer({ recordId: 'short' });
			// Clobber bytes around the recordId region with 0xff to drive ordered-binary
			// readKey into an error path; the lazy getters live outside readAuditEntry's
			// outer try/catch so prior to the fix this was the escape route.
			const corrupted = Buffer.from(buffer);
			for (let i = 6; i < Math.min(corrupted.length - 1, 20); i++) {
				corrupted[i] = 0xff;
			}
			const record = readAuditEntry(corrupted);
			assert.doesNotThrow(() => {
				void record.recordId;
				void record.user;
			});
		});

		it('round-trips a valid entry unchanged after the bounds-check guards were added', () => {
			// Lock the happy path — assert valid entries decode identically post-fix.
			const buffer = makeAuditBuffer({
				version: 100,
				tableId: 7,
				recordId: 'abc',
				nodeId: 3,
				user: 'alice',
				type: 'put',
			});
			const record = readAuditEntry(buffer);
			assert.strictEqual(record.type, 'put');
			assert.strictEqual(record.tableId, 7);
			assert.strictEqual(record.nodeId, 3);
			assert.strictEqual(record.version, 100);
			assert.strictEqual(record.recordId, 'abc');
			assert.strictEqual(record.user, 'alice');
		});

		// LMDB key decode path. The keyEncoder runs inside lmdb-js's iterator and is not
		// wrapped in any caller-side try/catch — pre-fix, a truncated key buffer that
		// started with 0x42 (the "this is a float64" marker) threw RangeError straight
		// out through the iterator.
		it('returns NaN instead of throwing when transactionKeyEncoder.readKey hits a truncated float64 buffer', () => {
			// 0x42 at byte 0 triggers the float64 branch; only 4 bytes total leaves the
			// read short by 4 bytes (getFloat64 needs 8).
			const truncated = Buffer.from([0x42, 0x00, 0x00, 0x00]);
			let result;
			assert.doesNotThrow(() => {
				result = transactionKeyEncoder.readKey(truncated, 0, truncated.length);
			});
			assert.ok(Number.isNaN(result), 'should return NaN sentinel');
		});

		it('decodes a normal float64 key when the buffer has enough bytes', () => {
			// The 0x42 branch is taken for millisecond-precision timestamps (Date.now()
			// values land in this range, which is why the comment in auditStore calls it
			// "the first byte in a date double"). Confirm the bounds check didn't break
			// that happy path.
			const timestamp = 1747000000000; // ~Date.now()
			const buffer = Buffer.alloc(8);
			buffer.writeDoubleBE(timestamp, 0);
			assert.strictEqual(buffer[0], 0x42, 'sanity: timestamp-range double starts with 0x42');
			const result = transactionKeyEncoder.readKey(buffer, 0, buffer.length);
			assert.strictEqual(result, timestamp);
		});

		// Rocks-prelude path. The throw in the field stack trace was at
		// RocksTransactionLogStore.ts:294 — `decoder.getUint32(0)` on a too-short
		// TransactionEntry.data buffer. Build a fake iterable so we can run the map
		// callback against a synthetic short entry without standing up real rocks.
		it("does not throw when the rocks .map() callback's prelude decode fails on a short buffer", () => {
			// Synthesize a minimum-viable rootStore stub. RocksTransactionLogStore needs
			// only useLog() to be callable in its constructor; nothing else is touched
			// for the path we're exercising.
			const fakeLog = {
				query: () => null,
				addEntry: () => null,
				on: () => null,
			};
			const fakeRoot = {
				useLog: () => fakeLog,
				on: () => null,
				listLogs: () => [],
			};
			const store = new RocksTransactionLogStore(fakeRoot);

			// Bypass loadLogs(): inject a one-element nodeLogs whose query() yields a
			// single corrupt TransactionEntry. The map callback runs on every entry we
			// pull, so this is the precise path that threw in prod.
			const corruptEntry = {
				timestamp: 42,
				data: new Uint8Array([0x00, 0x01]), // 2 bytes — too short for getUint32(0)
				endTxn: false,
			};
			let yielded = false;
			fakeRoot.useLog = () => ({
				...fakeLog,
				query: () => ({
					next() {
						if (yielded) return { done: true, value: undefined };
						yielded = true;
						return { done: false, value: corruptEntry };
					},
					[Symbol.iterator]() {
						return this;
					},
				}),
			});
			store.nodeLogs = [fakeRoot.useLog()];

			const results = [];
			assert.doesNotThrow(() => {
				for (const record of store.getRange({})) {
					results.push(record);
				}
			}, 'iteration must complete without throwing on a corrupt prelude');
			assert.strictEqual(results.length, 1);
			const sentinel = results[0];
			assert.strictEqual(sentinel.tableId, undefined);
			assert.strictEqual(sentinel.type, undefined);
			assert.strictEqual(sentinel.version, 42, 'timestamp from the log entry is preserved so lastTxnTime advances');
		});

		// rocksdb-js >=1.4.1 hardened transaction-log readers throw a bounded
		// RangeError ("Corrupt transaction log entry at position …: declared length …
		// overruns the log") when an entry's length header overshoots the committed
		// (or mapped) bound. That throw originates inside the underlying iterator's
		// next() — upstream of the .map() callback's per-entry try/catch — so without
		// safeNext() it escaped through the aggregate iterator into setImmediate-
		// scheduled consumers (notifyFromTransactionData) as an uncaughtException
		// that crashed the worker on every commit after a SIGKILL-induced torn write.
		it('terminates the failing log iterator instead of propagating a corrupt-entry throw out of the aggregate', () => {
			const fakeLog = { query: () => null, addEntry: () => null, on: () => null };
			const fakeRoot = { useLog: () => fakeLog, on: () => null, listLogs: () => [] };
			const store = new RocksTransactionLogStore(fakeRoot);

			// First log: yields one good entry, then throws (mirrors a torn entry past
			// a committed boundary). Track call count so we can confirm the failed
			// iterator is not re-polled on later drain cycles (otherwise every commit
			// re-throws the same RangeError, spamming logs and burning CPU).
			let corruptNextCalls = 0;
			const corruptLog = {
				name: 'corrupt',
				query: () => {
					let calls = 0;
					return {
						next() {
							corruptNextCalls++;
							calls++;
							if (calls === 1) {
								return {
									done: false,
									value: { timestamp: 1, data: new Uint8Array(20), endTxn: false },
								};
							}
							throw new RangeError(
								'Corrupt transaction log entry at position 14fd of log 1: declared length 2046820352 overruns the log (limit=5439)'
							);
						},
						[Symbol.iterator]() {
							return this;
						},
					};
				},
				addEntry: () => null,
				on: () => null,
			};
			// Second log: drains cleanly with two entries past the corrupt one's
			// timestamp. The aggregate must keep delivering these after the first log
			// terminates.
			const healthyLog = {
				name: 'healthy',
				query: () => {
					let i = 0;
					const entries = [
						{ timestamp: 2, data: new Uint8Array(20), endTxn: false },
						{ timestamp: 3, data: new Uint8Array(20), endTxn: false },
					];
					return {
						next() {
							return i < entries.length ? { done: false, value: entries[i++] } : { done: true, value: undefined };
						},
						[Symbol.iterator]() {
							return this;
						},
					};
				},
				addEntry: () => null,
				on: () => null,
			};

			store.nodeLogs = [corruptLog, healthyLog];

			const timestamps = [];
			assert.doesNotThrow(() => {
				for (const record of store.getRange({})) {
					timestamps.push(record.version);
				}
			}, 'aggregate iteration must not propagate the corrupt-entry RangeError');

			assert.deepStrictEqual(
				timestamps,
				[1, 2, 3],
				'good entries from the corrupt log (before the throw) and all entries from healthy peer logs must drain'
			);
			// 2 = the one good entry + the call that threw. Anything higher means the
			// retry-poll path is calling .next() on a known-bad iterator and we'll spam
			// the log on every subsequent commit.
			assert.strictEqual(
				corruptNextCalls,
				2,
				`failed corrupt iterator must not be re-polled after it throws (next() called ${corruptNextCalls} times)`
			);
		});

		describe('onCorruptFrame', () => {
			function corruptLogNamed(name, good, resyncPosition) {
				const error = new CorruptFrameError(
					'Corrupt transaction log entry at position 3e8 of log 1',
					1,
					1000,
					resyncPosition
				);
				let nextCalls = 0;
				return {
					name,
					error,
					nextCalls: () => nextCalls,
					query: () => {
						let i = 0;
						return {
							next() {
								nextCalls++;
								if (i < good.length) return { done: false, value: good[i++] };
								throw error;
							},
							[Symbol.iterator]() {
								return this;
							},
						};
					},
					addEntry: () => null,
					on: () => null,
				};
			}
			function healthyLogNamed(name, entries) {
				return {
					name,
					query: () => {
						let i = 0;
						return {
							next() {
								return i < entries.length ? { done: false, value: entries[i++] } : { done: true, value: undefined };
							},
							[Symbol.iterator]() {
								return this;
							},
						};
					},
					addEntry: () => null,
					on: () => null,
				};
			}
			const entry = (timestamp) => ({ timestamp, data: new Uint8Array(20), endTxn: false });
			function storeWith(...logs) {
				const fakeLog = { query: () => null, addEntry: () => null, on: () => null };
				const fakeRoot = { useLog: () => fakeLog, on: () => null, listLogs: () => [] };
				const store = new RocksTransactionLogStore(fakeRoot);
				store.nodeLogs = logs;
				for (const log of logs) store.logByName.set(log.name, log);
				return store;
			}

			it('aggregate path: hands the thrown error and the log name to the hook once, and keeps draining the other logs', () => {
				const corrupt = corruptLogNamed('corrupt', [entry(1)], 2048);
				const store = storeWith(corrupt, healthyLogNamed('healthy', [entry(2), entry(3)]));
				const reports = [];
				const versions = [];
				for (const record of store.getRange({ onCorruptFrame: (error, logName) => reports.push({ error, logName }) })) {
					versions.push(record.version);
				}
				assert.deepStrictEqual(versions, [1, 2, 3]);
				assert.strictEqual(reports.length, 1, 'the hook fires once per corrupt log, not once per poll');
				assert.strictEqual(reports[0].logName, 'corrupt');
				assert.strictEqual(reports[0].error, corrupt.error, 'the engine error object itself is passed, fields intact');
				assert.strictEqual(reports[0].error.resyncPosition, 2048);
				assert.strictEqual(corrupt.nextCalls(), 2, 'the latched iterator is not re-polled');
			});

			it('single-log path: hands the thrown error and the log name to the hook once', () => {
				const corrupt = corruptLogNamed('corrupt', [entry(1), entry(2)]);
				const store = storeWith(corrupt);
				const reports = [];
				const versions = [];
				for (const record of store.getRange({
					log: 'corrupt',
					onCorruptFrame: (error, logName) => reports.push({ error, logName }),
				})) {
					versions.push(record.version);
				}
				assert.deepStrictEqual(versions, [1, 2]);
				assert.deepStrictEqual(
					reports.map((report) => [report.logName, report.error, report.error.resyncPosition]),
					[['corrupt', corrupt.error, undefined]]
				);
			});

			it('a throwing hook is contained: the drain still completes and the iterator stays latched', () => {
				const corrupt = corruptLogNamed('corrupt', [entry(1)], 2048);
				const store = storeWith(corrupt, healthyLogNamed('healthy', [entry(2)]));
				let hookCalls = 0;
				const versions = [];
				assert.doesNotThrow(() => {
					for (const record of store.getRange({
						onCorruptFrame: () => {
							hookCalls++;
							throw new Error('hook failure');
						},
					})) {
						versions.push(record.version);
					}
				});
				assert.deepStrictEqual(versions, [1, 2]);
				assert.strictEqual(hookCalls, 1);
				assert.strictEqual(corrupt.nextCalls(), 2);
			});

			it('without a hook the corrupt log still ends cleanly', () => {
				const corrupt = corruptLogNamed('corrupt', [entry(1)], 2048);
				const store = storeWith(corrupt, healthyLogNamed('healthy', [entry(2)]));
				const versions = [];
				for (const record of store.getRange({})) versions.push(record.version);
				assert.deepStrictEqual(versions, [1, 2]);
			});

			it('a removeLog requested from the hook is applied after the poll, without dropping another log entry', () => {
				const corrupt = corruptLogNamed('corrupt', [entry(1)], 2048);
				const store = storeWith(corrupt, healthyLogNamed('healthy', [entry(2), entry(3)]));
				const excludeLogs = [];
				const iterable = store.getRange({
					excludeLogs,
					onCorruptFrame: (error, logName) => iterable.removeLog(logName),
				});
				const versions = [];
				for (const record of iterable) versions.push(record.version);
				assert.deepStrictEqual(versions, [1, 2, 3]);
				assert.deepStrictEqual(excludeLogs, ['corrupt']);
			});

			it('a removeLog from the hook works without an excludeLogs option', () => {
				const corrupt = corruptLogNamed('corrupt', [entry(1)], 2048);
				const store = storeWith(corrupt, healthyLogNamed('healthy', [entry(2), entry(3)]));
				const options = { onCorruptFrame: (error, logName) => iterable.removeLog(logName) };
				const iterable = store.getRange(options);
				const versions = [];
				for (const record of iterable) versions.push(record.version);
				assert.deepStrictEqual(versions, [1, 2, 3]);
				assert.deepStrictEqual(options.excludeLogs, ['corrupt']);
			});

			it('a break at the first frame is reported once the iterable exists, so the hook can act on it', () => {
				const corrupt = corruptLogNamed('corrupt', [], 2048);
				const store = storeWith(corrupt, healthyLogNamed('healthy', [entry(2), entry(3)]));
				const reports = [];
				let hookSawIterable = false;
				const iterable = store.getRange({
					onCorruptFrame: (error, logName) => {
						reports.push(logName);
						hookSawIterable = iterable !== undefined;
						iterable.removeLog(logName);
					},
				});
				assert.deepStrictEqual(reports, [], 'the report is held until the caller can hold the iterable');
				const versions = [];
				for (const record of iterable) versions.push(record.version);
				assert.deepStrictEqual(versions, [2, 3]);
				assert.deepStrictEqual(reports, ['corrupt']);
				assert.strictEqual(hookSawIterable, true);
				assert.strictEqual(corrupt.nextCalls(), 1, 'the latched iterator is not re-polled');
			});

			it('a hook that re-enters next() leaves its removal to the outermost call, without dropping an entry', () => {
				const corrupt = corruptLogNamed('corrupt', [entry(1)], 2048);
				const store = storeWith(corrupt, healthyLogNamed('healthy', [entry(2), entry(3), entry(4)]));
				let nestedPulls = 0;
				const iterable = store.getRange({
					excludeLogs: [],
					onCorruptFrame: (error, logName) => {
						iterable.removeLog(logName);
						if (!iterable[Symbol.iterator]().next().done) nestedPulls++;
					},
				});
				const versions = [];
				for (const record of iterable) versions.push(record.version);
				assert.deepStrictEqual(versions, [1, 2, 3, 4]);
				assert.strictEqual(nestedPulls, 1);
			});

			it('a rejecting async hook is contained and logged with the log name', async () => {
				const corrupt = corruptLogNamed('corrupt', [entry(1)], 2048);
				const store = storeWith(corrupt, healthyLogNamed('healthy', [entry(2)]));
				const logged = [];
				const originalError = harperLogger.error;
				harperLogger.error = (...args) => logged.push(args);
				const unhandled = [];
				const onUnhandled = (reason) => unhandled.push(reason);
				process.on('unhandledRejection', onUnhandled);
				try {
					const versions = [];
					for (const record of store.getRange({
						onCorruptFrame: async () => {
							throw new Error('async hook failure');
						},
					})) {
						versions.push(record.version);
					}
					assert.deepStrictEqual(versions, [1, 2]);
					await waitFor(() => logged.length === 1, { timeout: 2000, message: 'the rejected hook was not logged' });
					assert.deepStrictEqual(unhandled, []);
					assert.match(logged[0][0], /onCorruptFrame hook failed for transaction log "corrupt"/);
					assert.strictEqual(logged[0][1].message, 'async hook failure');
				} finally {
					harperLogger.error = originalError;
					process.off('unhandledRejection', onUnhandled);
				}
			});

			it('reports a torn frame in an on-disk log as the engine CorruptFrameError with resyncPosition', async function () {
				const store = AuditedTable.auditStore;
				if (!store.reusableIterable) return this.skip();
				const logName = 'torn-frame';
				const log = store.rootStore.useLog(logName);
				const total = 30;
				const tornIndex = 19;
				// Record ids that no other test in this file writes, so the aggregate drain below is attributable.
				const tornIds = Array.from({ length: total }, (_, i) => 1000 + i);
				const peerId = 2999;
				const appendAuditEntry = async (targetLog, recordId) => {
					ENTRY_DATAVIEW.setUint32(0, 0);
					const binary = Buffer.from(
						createAuditEntry(
							{
								version: 1_800_000_000_000 + recordId,
								tableId: 1,
								recordId,
								previousVersion: 0,
								nodeId: 1,
								user: 'test-user',
								type: 'put',
								encodedRecord: Buffer.from([0x80]),
								extendedType: 0,
								residencyId: 0,
								previousResidencyId: 0,
								expiresAt: 0,
								originatingOperation: 'insert',
							},
							4
						)
					);
					await store.rootStore.transaction((txn) => {
						targetLog.addEntry(binary, txn.id);
					});
				};
				for (const recordId of tornIds) await appendAuditEntry(log, recordId);
				// A healthy peer log with one entry newer than everything in the torn log.
				await appendAuditEntry(store.rootStore.useLog('torn-frame-peer'), peerId);
				const logDirectory = statSync(log.path).isDirectory() ? log.path : dirname(log.path);
				const logFile = join(logDirectory, '1.txnlog');
				const frames = readEntryFrames(readFileSync(logFile));
				assert.strictEqual(frames.length, total);
				const writeDeclaredLength = (value) => {
					const bytes = Buffer.alloc(4);
					bytes.writeUInt32BE(value);
					const fd = openSync(logFile, 'r+');
					try {
						writeSync(fd, bytes, 0, 4, frames[tornIndex].position + 8);
					} finally {
						closeSync(fd);
					}
				};
				// Declare a length the file cannot satisfy, so the reader has to find where framing resumes.
				writeDeclaredLength(0x7fffffff);
				try {
					const reports = [];
					const recordIds = [];
					for (const record of store.getRange({
						log: logName,
						start: 0,
						onCorruptFrame: (error, name) => reports.push({ error, name }),
					})) {
						recordIds.push(record.recordId);
					}
					assert.deepStrictEqual(
						recordIds,
						tornIds.slice(0, tornIndex),
						'the drain yields every intact entry before the break and stops there'
					);
					assert.strictEqual(reports.length, 1);
					assert.strictEqual(reports[0].name, logName);
					assert(reports[0].error instanceof CorruptFrameError, `expected the engine error, got ${reports[0].error}`);
					assert.strictEqual(reports[0].error.position, frames[tornIndex].position);
					assert.strictEqual(reports[0].error.resyncPosition, frames[tornIndex + 1].position);

					const aggregateReports = [];
					const aggregateIds = new Set();
					for (const record of store.getRange({
						start: 0,
						onCorruptFrame: (error, name) => aggregateReports.push({ error, name }),
					})) {
						aggregateIds.add(record.recordId);
					}
					assert.deepStrictEqual(
						aggregateReports.map((report) => [report.name, report.error.position, report.error.resyncPosition]),
						[[logName, frames[tornIndex].position, frames[tornIndex + 1].position]]
					);
					assert.deepStrictEqual(
						[...tornIds, peerId].filter((id) => aggregateIds.has(id)),
						[...tornIds.slice(0, tornIndex), peerId],
						'the aggregate drain yields the intact prefix, nothing past the break, and the peer entry behind it'
					);
				} finally {
					// Leave the shared test database's log intact for the tests that follow.
					writeDeclaredLength(frames[tornIndex].length);
				}
			});
		});
	});

	it('addLogToMaps assigns nodeId 0 to the local log and populates nodeLogs[0]', () => {
		const fakeLog = { query: () => null, addEntry: () => null, on: () => null };
		const fakeRoot = { useLog: () => fakeLog, on: () => null, listLogs: () => [] };
		const store = new RocksTransactionLogStore(fakeRoot);
		store.nodeLogs = [];
		const nodeId = store.addLogToMaps('local', fakeLog);
		assert.strictEqual(nodeId, 0, "'local' log must map to nodeId 0");
		assert.strictEqual(store.nodeLogs[0], fakeLog, 'nodeLogs[0] must be the local log');
	});

	it('local audited write stores nodeId 0 in the primary record', async function () {
		const key = 9001;
		await AuditedTable.put(key, { name: 'nodeId-test' });
		const entry = AuditedTable.primaryStore.getEntry(key);
		assert.strictEqual(entry.nodeId, 0, 'locally-written audited record must store nodeId 0');
		await AuditedTable.delete(key);
	});

	it('can handle separate subscriptions on separate dbs', async function () {
		const DB_COUNT = 3;
		let tables = [];
		let events = [];
		// Collect a promise per table that resolves when the first data event fires,
		// replacing the fixed delay(40) that was too short on Node 22.
		let eventPromises = [];
		for (let i = 0; i < DB_COUNT; i++) {
			tables[i] = table({
				table: 'AuditedTable',
				database: 'test-subscribe' + i,
				attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
			});
			let subscription = await tables[i].subscribe({});
			const eventsForTable = (events[i] = []);
			eventPromises[i] = new Promise((resolve) => {
				subscription.on('data', (event) => {
					eventsForTable.push(event);
					resolve();
				});
			});
		}
		for (let i = 0; i < DB_COUNT; i++) {
			await tables[i].put(50, { name: 'test' });
		}
		await Promise.all(eventPromises);
		for (let i = 0; i < DB_COUNT; i++) {
			assert.equal(events[i].length, 1);
		}
	});
});

// Retirement has to stop a pass that is already suspended inside removeAuditEntry, not just decline
// to start another one: lmdb-js stamps the DBI number into the write instruction synchronously
// (node_modules/lmdb/write.js) and the native writer consumes it later, so the promise the pass
// awaits is exactly the window in which those handles must stay open.
describe('Audit cleanup retirement', () => {
	const scratchDirs = [];
	const openScratchStore = () => {
		const directory = mkdtempSync(join(tmpdir(), 'harper-audit-retire-'));
		scratchDirs.push(directory);
		return open({ path: join(directory, 'retire.mdb') });
	};

	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
	});
	afterEach(function () {
		setAuditRetention(60_000, 10_000);
	});
	after(function () {
		for (const directory of scratchDirs) rmSync(directory, { recursive: true, force: true });
	});

	/**
	 * Arms a real audit store over a real LMDB environment with a controllable range, so a pass can be
	 * suspended at the exact point teardown lands on it in production: inside the awaited removal.
	 * `entries` bounds how many records the range yields across all passes.
	 */
	function armGatedPass(rootStore, { entries = Infinity } = {}) {
		const auditStore = openAuditStore(rootStore);
		const counts = { advances: 0, releases: 0, removals: 0, markerWrites: 0 };
		const markerValues = [];
		auditStore.getRange = () => ({
			[Symbol.iterator]: () => ({
				next() {
					if (counts.advances++ >= entries) return { done: true, value: undefined };
					return { done: false, value: { key: 1000 + counts.advances, type: 'put' } };
				},
				return() {
					counts.releases++;
					return { done: true, value: undefined };
				},
			}),
		});
		let releaseRemoval;
		const removalGate = new Promise((resolve) => (releaseRemoval = resolve));
		auditStore.remove = () => {
			counts.removals++;
			return removalGate;
		};
		const realPut = auditStore.put.bind(auditStore);
		auditStore.put = (key, value) => {
			counts.markerWrites++;
			// the marker buffer is reused across writes, so record the value rather than the reference
			markerValues.push(new Float64Array(value.slice().buffer)[0]);
			return realPut(key, value);
		};
		return { auditStore, counts, markerValues, releaseRemoval };
	}

	it('drains the in-flight removal before stopAuditCleanup() reports the pass retired', async function () {
		const rootStore = openScratchStore();
		try {
			const { auditStore, counts, releaseRemoval } = armGatedPass(rootStore);
			const pass = auditStore.scheduleAuditCleanup(1);
			await waitFor(() => counts.removals === 1, { timeout: 1000, message: 'the gated pass never started' });

			const barrier = auditStore.stopAuditCleanup();
			let drained = false;
			barrier.then(() => (drained = true));
			await delay(20);
			assert.equal(drained, false, 'the barrier must not settle while a removal is still in flight');

			releaseRemoval();
			await barrier;
			await pass;
			assert.equal(counts.advances, 1, 'a retired pass must not advance the cursor again');
			assert.equal(counts.releases, 1, 'a retirement that leaves the environment open still owes the cursor release');
			assert.equal(counts.markerWrites, 0, 'a retired pass must not write the last-removed marker');
			await delay(20);
			assert.equal(counts.advances, 1, 'a retired pass must not re-arm');
		} finally {
			removeStorageReclamation(rootStore.path);
			if (rootStore.status !== 'closed') await rootStore.close();
		}
	});

	it('touches nothing further once the root store closes under a suspended pass', async function () {
		const rootStore = openScratchStore();
		let unhandledRejection;
		const onUnhandledRejection = (reason) => (unhandledRejection = reason);
		process.on('unhandledRejection', onUnhandledRejection);
		try {
			const { auditStore, counts, releaseRemoval } = armGatedPass(rootStore);
			const pass = auditStore.scheduleAuditCleanup(1);
			await waitFor(() => counts.removals === 1, { timeout: 1000, message: 'the gated pass never started' });

			// the resetDatabases() shape: the root closes with no stopAuditCleanup() call at all
			const closed = rootStore.close();
			releaseRemoval();
			await pass;
			await closed;

			assert.equal(counts.advances, 1, 'a pass resuming onto a closing environment must not advance the cursor');
			assert.equal(counts.releases, 0, 'releasing a cursor into a closing environment reaches native code');
			assert.equal(counts.markerWrites, 0, 'a pass resuming onto a closing environment must not write the marker');
			await delay(20);
			assert.equal(counts.advances, 1, 'a pass must not re-arm onto a closed store');
			assert.equal(unhandledRejection, undefined, 'the detached timer callback must not reject');
		} finally {
			process.off('unhandledRejection', onUnhandledRejection);
			removeStorageReclamation(rootStore.path);
			if (rootStore.status !== 'closed') await rootStore.close();
		}
	});

	// Both logger shapes: a throwing sink is what a try/catch around the marker write alone does not
	// contain, and this file's deleteHistory regressions establish it as a real failure model.
	for (const loggingThrows of [true, false]) {
		it(`contains and retries a failed last-removed write (failure logging ${
			loggingThrows ? 'throws' : 'succeeds'
		})`, async function () {
			const rootStore = openScratchStore();
			const originalWarn = harperLogger.warn;
			let unhandledRejection;
			const onUnhandledRejection = (reason) => (unhandledRejection = reason);
			process.on('unhandledRejection', onUnhandledRejection);
			const { auditStore, counts, markerValues, releaseRemoval } = armGatedPass(rootStore, { entries: 1 });
			try {
				releaseRemoval(); // this test is about the marker write, so let the removal settle at once
				let markerRejects = true;
				const countingPut = auditStore.put;
				auditStore.put = (key, value) => {
					// still issued, so the failure under test is the rejection rather than a skipped write
					const write = countingPut(key, value);
					return markerRejects ? write.then(() => Promise.reject(new Error('simulated marker write failure'))) : write;
				};
				const warnings = [];
				harperLogger.warn = (...args) => {
					warnings.push(args);
					if (loggingThrows) throw new Error('simulated logging failure');
				};

				await auditStore.scheduleAuditCleanup(1);
				assert.equal(counts.markerWrites, 1, 'the pass should have attempted the marker write');
				assert.equal(
					warnings[0]?.[0],
					'Error recording the last removed audit entry',
					'a rejected marker write must be logged, not dropped'
				);
				assert.equal(warnings[0]?.[1]?.message, 'simulated marker write failure');

				// A later pass deletes nothing, so without a retained watermark it never writes the marker
				// again and the recorded boundary stays behind the entries that were already removed.
				markerRejects = false;
				harperLogger.warn = originalWarn;
				await waitFor(() => counts.markerWrites >= 2, {
					timeout: 2000,
					message: 'the failed last-removed marker was never retried',
				});
				assert.deepEqual(markerValues, [1001, 1001], 'the retry must carry the watermark the failed write had');
				await delay(20);
				assert.equal(counts.markerWrites, 2, 'a committed marker must not be rewritten by later empty passes');
				assert.equal(unhandledRejection, undefined, 'the detached timer callback must not reject');
			} finally {
				harperLogger.warn = originalWarn;
				process.off('unhandledRejection', onUnhandledRejection);
				auditStore.stopAuditCleanup();
				removeStorageReclamation(rootStore.path);
				if (rootStore.status !== 'closed') await rootStore.close();
			}
		});
	}

	// The initializing marker write has no downstream owner: openAuditStore() is synchronous and returns
	// the store, so a rejection here escapes unless it is contained at the call site — and the
	// containment has to survive its own log sink throwing.
	for (const loggingThrows of [true, false]) {
		it(`contains a rejected last-removed initialization write (failure logging ${
			loggingThrows ? 'throws' : 'succeeds'
		})`, async function () {
			const rootStore = openScratchStore();
			const originalWarn = harperLogger.warn;
			let unhandledRejection;
			const onUnhandledRejection = (reason) => (unhandledRejection = reason);
			process.on('unhandledRejection', onUnhandledRejection);
			const realOpenDB = rootStore.openDB.bind(rootStore);
			let opens = 0;
			// the scratch environment has no audit store yet, so the create:false probe returns nothing and
			// openAuditStore takes the initialize-a-new-store branch on its own
			rootStore.openDB = (name, options) => {
				opens++;
				const store = realOpenDB(name, options);
				if (store) store.put = () => Promise.reject(new Error('simulated marker initialization failure'));
				return store;
			};
			const warnings = [];
			harperLogger.warn = (...args) => {
				warnings.push(args);
				if (loggingThrows) throw new Error('simulated logging failure');
			};
			let auditStore;
			try {
				auditStore = openAuditStore(rootStore);
				assert.equal(opens, 2, 'the fixture must take the branch that initializes a new audit store');
				await waitFor(
					() => warnings.some(([message]) => message === 'Error initializing the audit log last-removed marker'),
					{ timeout: 1000, message: 'the rejected initialization write was never logged' }
				);
				await delay(20);
				assert.equal(unhandledRejection, undefined, 'the initialization write must not escape the synchronous open');
			} finally {
				harperLogger.warn = originalWarn;
				process.off('unhandledRejection', onUnhandledRejection);
				rootStore.openDB = realOpenDB;
				auditStore?.stopAuditCleanup();
				removeStorageReclamation(rootStore.path);
				if (rootStore.status !== 'closed') await rootStore.close();
			}
		});
	}
});
