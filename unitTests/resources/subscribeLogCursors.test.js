const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { getDatabaseGeneration } = require('#src/resources/auditStore');
const { getIdOfRemoteNode } = require('#src/resources/nodeIdMapping');
const { ARRIVED_AFTER_SAVE, LOG_BEFORE, LOG_CURSORS, LOG_NAME } = require('#src/resources/subscriptionCheckpoint');
const { transaction } = require('#src/resources/transaction');
const { waitFor } = require('../waitFor');

const isRocksDB = process.env.HARPER_STORAGE_ENGINE !== 'lmdb';

let sequence = 0;
/** A table in a database of its own, so its transaction logs hold only what the test writes. */
function tableInOwnDatabase() {
	const name = `LogCursors${++sequence}`;
	return table({
		table: name,
		database: `log_cursors_${name}`,
		audit: true,
		attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'value' }],
	});
}

function collector() {
	const events = [];
	const listener = (event) => events.push(event);
	listener.events = events;
	listener.values = () => events.map((event) => event.value?.value).filter((value) => value !== undefined);
	return listener;
}

/** Applies a publish as replication does: logged in the origin's log under the origin's key, whenever it arrives. */
function applyFromOrigin(T, nodeId, logKey, id) {
	const context = { source: {}, sourceApply: true, timestamp: logKey };
	return transaction(context, async () => {
		const resource = await T.getResource(id, context);
		resource._writePublish(id, { value: id }, { isNotification: true, nodeId, version: logKey });
	});
}

/** A table with a peer whose log holds `keys`, appended in that order, each entry valued by its key's offset. */
async function peerLog(offsets) {
	const T = tableInOwnDatabase();
	const peerName = `peer-${sequence}`;
	const peer = getIdOfRemoteNode(peerName, T.auditStore);
	const base = Date.now();
	for (const offset of offsets) await applyFromOrigin(T, peer, base + offset, `k${offset}`);
	const store = T.auditStore;
	store.loadLogs();
	return { T, store, peer, peerName, base, log: store.logByName.get(peerName) };
}

describe('Subscription positions per transaction log (harper#3790)', function () {
	if (!isRocksDB) return;
	this.timeout(30_000);
	before(setupTestDBPath);

	describe('finding a position in a log', () => {
		it("gives the log's last complete transaction as its tail, whatever its key", async () => {
			const { store, log, base } = await peerLog([10, 50, 40, 30]);
			assert.strictEqual(store.highestKey(log), base + 50);
			assert.strictEqual(store.tailKey(log), base + 30, 'the last one appended, not the highest key');
			assert.strictEqual(store.tailKey((await peerLog([10, 20])).log) > 0, true);
		});

		it('gives 0 as the tail of a log with no entry', async () => {
			const { T, store } = await peerLog([10]);
			getIdOfRemoteNode(`empty-${sequence}`, T.auditStore);
			store.ensureLogExists(`empty-${sequence}`);
			assert.strictEqual(store.tailKey(store.logByName.get(`empty-${sequence}`)), 0);
		});

		it('finds the transaction before one, for one that raised the highest key and for one that arrived late', async () => {
			const { store, log, base } = await peerLog([10, 20, 50, 40, 60, 30]);
			const before = (offset) => store.predecessorKey(log, base + offset) - base;
			assert.strictEqual(store.predecessorKey(log, base + 10), 0, 'the first entry has none');
			assert.strictEqual(before(20), 10);
			assert.strictEqual(before(50), 20);
			assert.strictEqual(before(40), 50, 'a late key follows a higher one');
			assert.strictEqual(before(60), 40, 'and a new highest key follows the late one');
			assert.strictEqual(before(30), 60);
		});

		it('refuses to anchor past more entries than a scan may read, and the subscription then keeps no positions', async () => {
			const { T, store, peer, log, base } = await peerLog([10]);
			const context = { source: {}, sourceApply: true, timestamp: base + 20 };
			await transaction(context, async () => {
				const resource = await T.getResource('bulk', context);
				for (let index = 0; index < 65_540; index++)
					resource._writePublish('bulk', { value: index }, { isNotification: true, nodeId: peer, version: base + 20 });
			});
			assert.throws(() => store.tailKey(log), /too many/);
			const listener = collector();
			const subscription = await T.subscribe({
				omitCurrent: true,
				reportProgress: true,
				listener,
				[LOG_CURSORS]: true,
			});
			assert.strictEqual(subscription.logCursors, undefined);
			await T.put('live', { value: 'live' });
			await waitFor(() => listener.values().includes('live'));
			subscription.end();
		});

		it('says whether a log holds a transaction', async () => {
			const { store, peerName, base } = await peerLog([10, 30, 20]);
			assert.strictEqual(store.holdsTransaction(peerName, base + 20), true);
			assert.strictEqual(store.holdsTransaction(peerName, base + 25), false);
			assert.strictEqual(store.holdsTransaction(peerName, 0), false);
			assert.strictEqual(store.holdsTransaction('no-such-log', base + 20), false, 'and creates no log to answer');
			assert.strictEqual(store.logByName.has('no-such-log'), false);
		});
	});

	describe('a range that tracks its position in each log', () => {
		it('starts at the tail of each log when it stands at their end, then follows what it returns', async () => {
			const { T, store, peer, peerName, base } = await peerLog([10, 50, 40]);
			const range = store.getRange({ peekAhead: true });
			const iterator = range[Symbol.iterator]();
			assert.strictEqual(iterator.next().done, true);
			range.trackPositions(true);
			assert.strictEqual(range.logPositions().get(peerName), base + 40);
			await applyFromOrigin(T, peer, base + 20, 'k20');
			await applyFromOrigin(T, peer, base + 70, 'k70');
			const first = iterator.next().value;
			assert.deepStrictEqual(
				[first.txnLogKey, range.lastLogName(), range.lastKeyBefore()],
				[base + 20, peerName, base + 40]
			);
			assert.strictEqual(range.logPositions().get(peerName), base + 20);
			assert.strictEqual(iterator.next().value.txnLogKey, base + 70);
			assert.strictEqual(range.lastKeyBefore(), base + 20);
			assert.strictEqual(range.logPositions().get(peerName), base + 70);
		});

		it('starts before an entry the range has not returned yet', async () => {
			const { T, store, peer, peerName, base } = await peerLog([10, 30]);
			const range = store.getRange({ peekAhead: true });
			const iterator = range[Symbol.iterator]();
			assert.strictEqual(iterator.next().done, true);
			await applyFromOrigin(T, peer, base + 20, 'k20');
			await applyFromOrigin(T, peer, base + 40, 'k40');
			range.trackPositions(true);
			assert.strictEqual(range.logPositions().get(peerName), base + 30, 'the late entry it has yet to return');
			assert.strictEqual(iterator.next().value.txnLogKey, base + 20);
			assert.strictEqual(range.lastKeyBefore(), base + 30);
		});

		it('reads a log that appears later from its start', async () => {
			const { T, store } = await peerLog([10]);
			const range = store.getRange({ peekAhead: true });
			const iterator = range[Symbol.iterator]();
			assert.strictEqual(iterator.next().done, true);
			range.trackPositions(true);
			const joinedName = `joined-${sequence}`;
			const key = Date.now() + 5;
			await applyFromOrigin(T, getIdOfRemoteNode(joinedName, T.auditStore), key, 'joined');
			assert.strictEqual(range.logPositions().get(joinedName), 0);
			assert.strictEqual(iterator.next().value.txnLogKey, key);
			assert.deepStrictEqual([range.lastLogName(), range.lastKeyBefore()], [joinedName, 0]);
			assert.strictEqual(range.logPositions().get(joinedName), key);
		});

		it('tracks nothing until asked, and stops when told', async () => {
			const { T, store, peer, base } = await peerLog([10]);
			const range = store.getRange({ peekAhead: true });
			const iterator = range[Symbol.iterator]();
			iterator.next();
			await applyFromOrigin(T, peer, base + 20, 'k20');
			iterator.next();
			assert.strictEqual(range.lastLogName(), undefined);
			range.trackPositions(true);
			range.trackPositions(false);
			await applyFromOrigin(T, peer, base + 30, 'k30');
			iterator.next();
			assert.strictEqual(range.lastLogName(), undefined);
		});

		it('resumes each log after its exact start, and continues one whose start is gone from the fallback key', async () => {
			const { store, peerName, base } = await peerLog([10, 50, 40, 30, 60]);
			const failures = [];
			const read = (cursor, fallback) => {
				const range = store.getRange({
					startByLog: new Map([[peerName, cursor]]),
					exactStart: true,
					resumeAfterExactStart: true,
					trackPositions: true,
					exactStartFallback: (logName, failure) => {
						failures.push([logName, failure]);
						return fallback;
					},
				});
				const read = [];
				for (const entry of range) {
					if (range.lastLogName() === peerName) read.push([entry.txnLogKey - base, range.lastKeyBefore() - base]);
				}
				return read;
			};
			assert.deepStrictEqual(read(base + 50), [
				[40, 50],
				[30, 40],
				[60, 30],
			]);
			assert.deepStrictEqual(failures, []);
			// by key from 35: the late 30 is not read, so 60 follows 40 here, and the first one read knows what preceded it
			assert.deepStrictEqual(read(base + 45, base + 35), [
				[50, 10],
				[40, 50],
				[60, 40],
			]);
			assert.deepStrictEqual(failures, [[peerName, 'missing']]);
			assert.deepStrictEqual(
				read(base + 45, 0).map(([key]) => key),
				[10, 50, 40, 30, 60],
				'from its first retained entry'
			);
			assert.deepStrictEqual(read(base + 45, undefined), [], 'or not at all');
		});
	});

	describe('a subscription resumed from its position in each log', () => {
		/** A subscription that read `read` from the peer and this node's `local`, with its positions as it ended. */
		async function subscribedThrough(offsets) {
			const T = tableInOwnDatabase();
			const peerName = `peer-${sequence}`;
			const peer = getIdOfRemoteNode(peerName, T.auditStore);
			const base = Date.now();
			await T.put('seed', { value: 'seed' });
			const first = collector();
			const subscription = await T.subscribe({
				omitCurrent: true,
				reportProgress: true,
				listener: first,
				[LOG_CURSORS]: true,
			});
			for (const offset of offsets) await applyFromOrigin(T, peer, base + offset, `k${offset}`);
			await T.put('local', { value: 'local' });
			await waitFor(() => first.values().includes('local'));
			let positions;
			await waitFor(() => (positions = subscription.logCursors()));
			// a saved start above everything written so far, and above every key the peer uses below
			const position = Math.max(base, Date.now()) + 100;
			subscription.end();
			const logs = new Map();
			for (const [log, key] of positions) logs.set(log, { cursor: key, readThrough: key });
			const resume = (cursors, options) =>
				T.subscribe({
					startTime: cursors.takenThrough,
					databaseGeneration: getDatabaseGeneration(T.auditStore).id,
					reportProgress: true,
					omitCurrent: true,
					[LOG_CURSORS]: cursors,
					...options,
				});
			return { T, peer, peerName, base, first, position, logs, resume };
		}

		async function replayed(T, resume, cursors) {
			const listener = collector();
			const subscription = await resume(cursors, { listener });
			const verified = await subscription.resumeVerified;
			if (verified) {
				await T.put('live', { value: 'live' });
				await waitFor(() => listener.values().includes('live'));
			}
			subscription.end();
			return { verified, values: listener.values(), events: listener.events, subscription };
		}

		it('tags every event with its log and the position before it', async () => {
			const { first, peerName, base } = await subscribedThrough([10, 20]);
			const tags = first.events.map((event) => [event.value.value, event[LOG_NAME], event[LOG_BEFORE]]);
			// one pass can return this node's entry between the peer's
			assert.deepStrictEqual(
				tags.filter(([, log]) => log === peerName),
				[
					['k10', peerName, 0],
					['k20', peerName, base + 10],
				]
			);
			const local = tags.find(([, log]) => log === 'local');
			assert.ok(local[2] > 0, "after the seed in this node's own log");
		});

		it('delivers what arrived after the saved positions, whatever its key, and nothing read before them', async () => {
			const { T, peer, base, position, logs, resume } = await subscribedThrough([10, 30]);
			await applyFromOrigin(T, peer, base + 20, 'k20');
			const { values, events } = await replayed(T, resume, { takenThrough: position, logs });
			assert.deepStrictEqual(values, ['k20', 'live']);
			assert.strictEqual(events[0][ARRIVED_AFTER_SAVE], true);
			assert.strictEqual(events[0][LOG_BEFORE], base + 30);
		});

		it('reads again what a held cursor left unread, above what was taken, and marks what is new', async () => {
			const { T, peer, peerName, base, logs, resume } = await subscribedThrough([10, 40, 20, 50]);
			// the delivery of k40 was never taken: the cursor is before it, and what was taken stops below it
			logs.set(peerName, { cursor: base + 10, readThrough: base + 50 });
			await applyFromOrigin(T, peer, base + 30, 'k30');
			const { values, events } = await replayed(T, resume, { takenThrough: base + 39, logs });
			assert.deepStrictEqual(values, ['k40', 'k50', 'k30', 'live'], 'k20 was read before the save and taken');
			assert.deepStrictEqual(
				events.slice(0, 3).map((event) => event[ARRIVED_AFTER_SAVE] === true),
				[false, false, true]
			);
		});

		it('reads a log by key above the start when its saved position is not in it, and still resumes', async () => {
			const { T, peer, peerName, base, logs, resume } = await subscribedThrough([10, 40]);
			logs.set(peerName, { cursor: base + 15, readThrough: base + 15 });
			await applyFromOrigin(T, peer, base + 20, 'k20');
			const { verified, values, events } = await replayed(T, resume, { takenThrough: base + 30, logs });
			assert.strictEqual(verified, true);
			assert.deepStrictEqual(values, ['k40', 'live'], 'as a resume by key reads it');
			assert.strictEqual(events[0][ARRIVED_AFTER_SAVE], undefined);
			assert.strictEqual(events[0][LOG_BEFORE], base + 10, 'and its events still know their position');
		});

		/** The peer's log reports that a purge removed files holding keys up to `purgedThrough`. */
		function purged(T, peerName, purgedThrough) {
			const store = T.auditStore;
			const log = store.logByName.get(peerName);
			const index = store.nodeLogs.indexOf(log);
			// a native log takes no property of its own, so the store's entry for it is stood in for
			const reporting = {
				name: log.name,
				query: (options) => log.query(options),
				getStats: () => log.getStats(),
				getPurgeWatermark: () => ({ known: true, purgedThrough }),
			};
			store.logByName.set(peerName, reporting);
			store.nodeLogs[index] = reporting;
			return () => {
				store.logByName.set(peerName, log);
				store.nodeLogs[index] = log;
			};
		}

		it('reads a log from its first retained entry when its saved position was purged with nothing above the start', async () => {
			const { T, peerName, base, logs, resume } = await subscribedThrough([10, 40]);
			logs.set(peerName, { cursor: base + 5, readThrough: base + 5 });
			const restore = purged(T, peerName, base + 5);
			try {
				const { verified, values } = await replayed(T, resume, { takenThrough: base + 30, logs });
				assert.strictEqual(verified, true);
				assert.deepStrictEqual(values, ['k10', 'k40', 'live'], 'everything retained is after the position');
			} finally {
				restore();
			}
		});

		it('refuses the resume when a purge removed an entry above the start', async () => {
			const { T, peerName, base, logs, resume } = await subscribedThrough([10, 40]);
			logs.set(peerName, { cursor: base + 5, readThrough: base + 5 });
			const restore = purged(T, peerName, base + 35);
			try {
				const listener = collector();
				const subscription = await resume({ takenThrough: base + 30, logs }, { listener });
				assert.strictEqual(await subscription.resumeVerified, false);
				assert.strictEqual(subscription.closedWith?.statusCode, 410);
			} finally {
				restore();
			}
		});

		it('ignores positions that leave out this node’s own log, or that are malformed', async () => {
			const { T, peer, peerName, base, position, logs, resume } = await subscribedThrough([10, 30]);
			await applyFromOrigin(T, peer, base + 20, 'k20');
			const withoutLocal = new Map([[peerName, logs.get(peerName)]]);
			const malformed = new Map([...logs, [peerName, { cursor: -1, readThrough: base }]]);
			for (const unusable of [withoutLocal, malformed]) {
				const { values } = await replayed(T, resume, { takenThrough: position, logs: unusable });
				assert.deepStrictEqual(values, ['live'], 'a resume by key: nothing below the start');
			}
		});

		it('does not skip a late entry of this node’s own log either', async () => {
			const { T, logs, position, resume } = await subscribedThrough([10]);
			// a local commit that took its key before the start and lands after it
			await applyFromOrigin(T, 0, position - 1, 'local-late');
			const { values } = await replayed(T, resume, { takenThrough: position, logs });
			assert.deepStrictEqual(values, ['local-late', 'live']);
		});

		it('keeps no positions for a single record, or on a request that does not ask', async () => {
			const T = tableInOwnDatabase();
			await T.put('one', { value: 'one' });
			const record = await T.subscribe({ id: 'one', omitCurrent: true, reportProgress: true });
			const collection = await T.subscribe({ omitCurrent: true, reportProgress: true });
			assert.strictEqual(collection.logCursors, undefined);
			assert.strictEqual(record.logCursors, undefined);
			record.end();
			collection.end();
		});
	});

	it('replays only direct children to a subscription for direct children, as it delivers them live', async () => {
		const T = tableInOwnDatabase();
		await T.put('seed', { value: 0 });
		const start = [...T.auditStore.getRange({ start: 1 })].at(-1).txnLogKey;
		const live = collector();
		const subscription = await T.subscribe({
			isCollection: true,
			onlyChildren: true,
			omitCurrent: true,
			listener: live,
		});
		await T.put('child', { value: 'child' });
		await T.put(['child', 'grandchild'], { value: 'grandchild' });
		await T.put('last', { value: 'last' });
		await waitFor(() => live.values().includes('last'));
		assert.deepStrictEqual(live.values(), ['child', 'last']);
		subscription.end();
		const replay = collector();
		const replayed = await T.subscribe({
			isCollection: true,
			onlyChildren: true,
			omitCurrent: true,
			startTime: start,
			listener: replay,
		});
		await waitFor(() => replay.values().includes('last'));
		assert.deepStrictEqual(replay.values(), ['child', 'last']);
		replayed.end();
	});
});
