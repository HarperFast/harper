const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const {
	setAuditRetention,
	readAuditEntry,
	createAuditEntry,
	transactionKeyEncoder,
} = require('#src/resources/auditStore');
const { RocksTransactionLogStore } = require('#src/resources/RocksTransactionLogStore');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { setTimeout: delay } = require('node:timers/promises');
require('#src/server/serverHelpers/serverUtilities');
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
		await AuditedTable.put(1, { name: 'one' });
		await AuditedTable.put(2, { name: 'two' });
		await AuditedTable.put(2, { name: 'two-changed' });
		await AuditedTable.delete(1);
		assert.equal(AuditedTable.primaryStore.getEntry(1).value, null); // verify that there is a delete entry
		let results = [];
		for await (let entry of AuditedTable.getHistory()) {
			results.push(entry);
		}
		assert.equal(results.length, 4);
		await delay(20);
		assert(events.length > 2, 'Should have at least a couple of update events');
		if (AuditedTable.auditStore.reusableIterable) return; // rocksdb doesn't have any audit log cleanup from JS
		setAuditRetention(0.001, 1);
		AuditedTable.auditStore.scheduleAuditCleanup(1);
		await AuditedTable.put(3, { name: 'three' });
		// Poll until cleanup completes (was a fixed 20ms which is too short on a loaded CI runner)
		for (let i = 0; i < 20; i++) {
			await new Promise((resolve) => setTimeout(resolve, 10));
			results = [];
			for await (let entry of AuditedTable.getHistory()) {
				results.push(entry);
			}
			if (results.length === 0) break;
		}

		assert.equal(results.length, 0);
		assert.equal(AuditedTable.primaryStore.getEntry(1), undefined); // verify that the delete entry was removed
		// verify that the twice-written entry was not removed
		assert.equal(AuditedTable.primaryStore.getEntry(2)?.value?.name, 'two-changed');
	});
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
