// On RocksDB a log key is reserved before its transaction commits, so a transaction can commit after a startTime
// replay passed a higher key; live delivery must still take it, once (harper#2311).
require('../testUtils');
const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { waitFor } = require('../waitFor.js');
const { TransactionLogUntilUnreachedError } = require('@harperfast/rocksdb-js');
const { table } = require('#src/resources/databases');
const { transaction } = require('#src/resources/transaction');
const { getDatabaseGeneration, raiseAuditFloor } = require('#src/resources/auditStore');
const { getIdOfRemoteNode } = require('#src/resources/nodeIdMapping');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');

function stageHeldTransaction(write) {
	let release;
	const mayCommit = new Promise((resolve) => (release = resolve));
	let staged;
	const isStaged = new Promise((resolve) => (staged = resolve));
	const context = {};
	const committed = transaction(context, async () => {
		await write(context);
		staged();
		await mayCommit;
	});
	return { isStaged, release, committed };
}

function countBy(events, id) {
	return events.filter((event) => event.id === id).length;
}

// a write applied as a replicated origin's, which goes to that origin's own log under the given key
function applyFromOrigin(T, id, record, nodeId, logKey) {
	const context = { source: {}, sourceApply: true, timestamp: logKey };
	return transaction(context, async () => {
		const resource = await T.getResource(id, context);
		return resource._writeUpdate(id, record, true, { isNotification: true, nodeId, version: logKey });
	});
}

// Makes the log's segments unmappable to readers created from here on, as rocksdb-js's own tests do: a reader
// first takes a mapping the log has cached, so the cache is cleared too. Readers that already hold a mapping are
// unaffected. The prototype's method is not writable, so it is shadowed by an own property.
function refuseMapping(log) {
	const injection = { refused: 0 };
	log._logBuffers?.clear();
	log._currentLogBuffer = undefined;
	Object.defineProperty(log, '_getMemoryMapOfFile', {
		configurable: true,
		value: () => {
			injection.refused++;
			return undefined;
		},
	});
	injection.restore = () => delete log._getMemoryMapOfFile;
	return injection;
}

describe('startTime replay handoff to live delivery', () => {
	let tableSequence = 0;
	function freshTable() {
		return table({
			table: `SubReplayLateCommit${++tableSequence}`,
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
			audit: true,
		});
	}
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
	});

	for (const reportProgress of [false, true]) {
		it(`delivers once a transaction that commits after the replay passed a higher key${reportProgress ? ' (reportProgress)' : ''}`, async () => {
			const T = freshTable();
			const startTime = Date.now() - 1;
			const older = stageHeldTransaction((context) => T.put('older', { name: 'older' }, context));
			let subscription;
			try {
				await older.isStaged;
				await T.put('newer', { name: 'newer' });
				subscription = await T.subscribe({ startTime, isCollection: true, reportProgress });
				const events = [];
				subscription.on('data', (event) => events.push(event));
				await waitFor(() => events.some((event) => event.id === 'newer'), { timeout: 5000 });
				// the resume cursor moves past the start once the replay has finished its one key
				await waitFor(() => subscription.replayedThrough > startTime, { timeout: 5000 });
				older.release();
				await older.committed;
				await T.put('sentinel', { name: 'sentinel' });
				await waitFor(() => events.some((event) => event.id === 'sentinel'), { timeout: 5000 });
				await waitFor(() => events.some((event) => event.id === 'older'), { timeout: 2000 }).catch(() => {});
				assert.equal(
					countBy(events, 'older'),
					1,
					`the late lower-key commit was not delivered exactly once: ${JSON.stringify(events.map((e) => e.id))}`
				);
				assert.equal(countBy(events, 'newer'), 1, 'the replayed write was not delivered exactly once');
				assert.equal(countBy(events, 'sentinel'), 1);
			} finally {
				older.release();
				await older.committed.catch(() => {});
				subscription?.end();
			}
		});
	}

	it('delivers each write exactly once while an older transaction is held open across the replay', async () => {
		const T = freshTable();
		const startTime = Date.now() - 1;
		const older = stageHeldTransaction((context) => T.put('older', { name: 'older' }, context));
		let subscription;
		const total = 300; // above the broadcast's 256-entry batch, so a pass can yield across the handoff
		try {
			await older.isStaged;
			const before = [];
			for (let i = 0; i < total / 2; i++) before.push(T.put(i, { name: 'before' + i }));
			await Promise.all(before);
			const inFlight = [];
			for (let i = total / 2; i < total; i++) inFlight.push(T.put(i, { name: 'inflight' + i }));
			subscription = await T.subscribe({ startTime, isCollection: true });
			const events = [];
			subscription.on('data', (event) => events.push(event));
			older.release();
			await Promise.all([...inFlight, older.committed]);
			await T.put('sentinel', { name: 'sentinel' });
			await waitFor(
				() => {
					const ids = new Set(events.map((event) => event.id));
					for (let i = 0; i < total; i++) if (!ids.has(i)) return false;
					return ids.has('older') && ids.has('sentinel');
				},
				{ timeout: 10000 }
			).catch(() => {});
			for (let i = 0; i < total; i++) assert.equal(countBy(events, i), 1, `id ${i} not delivered exactly once`);
			assert.equal(countBy(events, 'older'), 1, 'the held transaction was not delivered exactly once');
			assert.equal(countBy(events, 'sentinel'), 1);
		} finally {
			older.release();
			await older.committed.catch(() => {});
			subscription?.end();
		}
	});

	it('splits a transaction exactly once when the replay meets the broadcast inside it', async function () {
		// a pass another test's commit had already scheduled can still run, and it ends the hold below
		this.retries(3);
		const T = freshTable();
		if (!T.auditStore.reusableIterable) return this.skip();
		const startTime = Date.now() - 1;
		const opening = await T.subscribe({ isCollection: true });
		const registry = opening.subscriptions.tables.envs;
		let subscription;
		try {
			// no pass runs while these are set, so the broadcast stands wherever the test leaves it
			registry.passYielded = registry.notifyScheduled = true;
			const total = 8;
			await transaction({}, async (context) => {
				for (let i = 0; i < total; i++) await T.put(i, { name: 'in-one-transaction' }, context);
			});
			assert.ok(registry.notifyScheduled, 'a scheduled pass ran during the hold');
			const broadcast = registry.auditStore.subscriptionLogRange[Symbol.iterator]();
			for (let read = 0; read < total / 2;) if (broadcast.next().value.tableId === T.tableId) read++;
			subscription = await T.subscribe({ startTime, isCollection: true });
			const events = [];
			subscription.on('data', (event) => events.push(event));
			await waitFor(() => subscription.replayedThrough !== undefined, { timeout: 5000 });
			assert.ok(registry.notifyScheduled, 'a scheduled pass ran during the hold');
			assert.deepEqual(
				events.map((event) => event.id),
				[0, 1, 2, 3]
			);
			assert.ok(
				subscription.replayedThrough < events[0].localTime,
				'a partly replayed transaction became the resume cursor'
			);
			assert.equal(subscription.startTime, startTime, 'live delivery is gated at the requested start');
			registry.passYielded = registry.notifyScheduled = false;
			await T.put('sentinel', { name: 'sentinel' });
			await waitFor(() => events.some((event) => event.id === 'sentinel'), { timeout: 5000 });
			assert.deepEqual(
				events.map((event) => event.id),
				[0, 1, 2, 3, 4, 5, 6, 7, 'sentinel']
			);
		} finally {
			registry.passYielded = registry.notifyScheduled = false;
			opening.end();
			subscription?.end();
		}
	});

	it('delivers once to a subscription made from a listener, on the entry that listener is handling', async () => {
		const T = freshTable();
		const startTime = Date.now() - 1;
		const events = [];
		let replaying;
		const leaf = await T.subscribe('entry');
		leaf.on('data', () => {
			replaying ??= T.subscribe({ startTime, isCollection: true });
			replaying.then((subscription) => subscription.on('data', (event) => events.push(event)));
		});
		let subscription;
		try {
			await T.put('entry', { name: 'entry' });
			await waitFor(() => replaying, { timeout: 5000 });
			subscription = await replaying;
			await T.put('sentinel', { name: 'sentinel' });
			await waitFor(() => events.some((event) => event.id === 'sentinel'), { timeout: 5000 });
			assert.equal(countBy(events, 'entry'), 1, JSON.stringify(events.map((event) => event.id)));
		} finally {
			leaf.end();
			subscription?.end();
		}
	});

	for (const otherTable of [false, true]) {
		it(`keeps the resume cursor below a transaction the boundary splits, when a later transaction from another log follows it${otherTable ? ' on another table' : ''}`, async function () {
			// a pass another test's commit had already scheduled can still run, and it ends the hold below
			this.retries(3);
			const T = freshTable();
			if (!T.auditStore.reusableIterable) return this.skip();
			const Other = otherTable ? freshTable() : T;
			const peerId = getIdOfRemoteNode('replay-handoff-peer', T.auditStore);
			const startTime = Date.now() - 1;
			const total = 8;
			const late = stageHeldTransaction(async (context) => {
				for (let i = 0; i < total; i++) await T.put(i, { name: 'late' }, context);
			});
			const opening = await T.subscribe({ isCollection: true });
			const registry = opening.subscriptions.tables.envs;
			let subscription;
			try {
				await late.isStaged;
				registry.passYielded = registry.notifyScheduled = true;
				await applyFromOrigin(Other, 'peer', { name: 'peer' }, peerId, Date.now() + 60_000);
				const broadcast = registry.auditStore.subscriptionLogRange[Symbol.iterator]();
				// the later transaction is dispatched before the held one commits below it
				while (!broadcast.next().done);
				late.release();
				await late.committed;
				for (let read = 0; read < total / 2;) if (broadcast.next().value.tableId === T.tableId) read++;
				subscription = await T.subscribe({ startTime, isCollection: true });
				const events = [];
				subscription.on('data', (event) => events.push(event));
				await waitFor(() => subscription.replayedThrough !== undefined, { timeout: 5000 });
				assert.ok(registry.notifyScheduled, 'a scheduled pass ran during the hold');
				const lateKey = events[0].localTime;
				assert.deepEqual(
					events.map((event) => event.id),
					otherTable ? [0, 1, 2, 3] : [0, 1, 2, 3, 'peer']
				);
				assert.ok(
					subscription.replayedThrough < lateKey,
					`the resume cursor ${subscription.replayedThrough} passed the split transaction at ${lateKey}`
				);
				registry.passYielded = registry.notifyScheduled = false;
				await T.put('sentinel', { name: 'sentinel' });
				await waitFor(() => events.some((event) => event.id === 'sentinel'), { timeout: 5000 });
				for (let i = 0; i < total; i++) assert.equal(countBy(events, i), 1, `id ${i} not delivered exactly once`);
				assert.equal(countBy(events, 'peer'), otherTable ? 0 : 1);
			} finally {
				registry.passYielded = registry.notifyScheduled = false;
				late.release();
				await late.committed.catch(() => {});
				opening.end();
				subscription?.end();
			}
		});
	}

	it('delivers a write folded into a head below the start, as live delivery does', async function () {
		const T = freshTable();
		if (!T.auditStore.reusableIterable) return this.skip();
		const head = getIdOfRemoteNode('replay-fold-head', T.auditStore);
		const folded = getIdOfRemoteNode('replay-fold-late', T.auditStore);
		const base = Date.now() + 3_600_000;
		const apply = (id, record, logKey, version, nodeId) => {
			const context = { source: {}, sourceApply: true, timestamp: logKey };
			return transaction(context, async () => {
				const resource = await T.getResource(id, context);
				return resource._writeUpdate(id, record, false, { isNotification: true, nodeId, version });
			});
		};
		await apply('folded', { name: 'base', count: 0 }, base, base, head);
		await apply('folded', { name: 'newer' }, base + 5000, base + 2000, head);
		// an older version that arrives last is merged into the head, whose own entry is below the start
		await apply('folded', { count: 1 }, base + 6000, base + 1000, folded);
		const events = [];
		const subscription = await T.subscribe({
			startTime: base + 5500,
			isCollection: true,
			listener: (event) => events.push(event),
		});
		try {
			// keyed above the start, as the local clock is not
			await apply('sentinel', { name: 'sentinel' }, base + 7000, base + 7000, head);
			await waitFor(() => events.some((event) => event.id === 'sentinel'), { timeout: 5000 });
			const deliveries = events.filter((event) => event.id === 'folded');
			assert.equal(deliveries.length, 1, JSON.stringify(deliveries));
			assert.equal(deliveries[0].value.count, 1, 'the folded write was not delivered');
		} finally {
			subscription.end();
		}
	});

	describe('a log that cannot be read up to the broadcast yet', () => {
		let sequence = 0;
		function ownTable() {
			const name = `SubReplayUnreached${++sequence}`;
			return table({
				table: name,
				database: `subReplayUnreached${sequence}`,
				attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
				audit: true,
			});
		}

		it('keeps every log in place, then resumes and returns each entry once', async function () {
			const T = ownTable();
			const store = T.auditStore;
			if (!store.reusableIterable) return this.skip();
			const start = Date.now() - 1;
			const leader = store.getRange({ peekAhead: true });
			for (let i = 0; i < 3; i++) await T.put(i, { name: 'local' });
			await applyFromOrigin(T, 'peer', { name: 'peer' }, getIdOfRemoteNode('unreached-peer', store), Date.now());
			const leaderIterator = leader[Symbol.iterator]();
			while (!leaderIterator.next().done);
			const injection = refuseMapping(store.logByName.get('local'));
			let follower;
			try {
				// the peer log's first entry is read and held when the range opens
				follower = store.getRange({ start, exclusiveStart: true, until: leader });
				for (let attempt = 0; attempt < 3; attempt++) {
					assert.throws(() => follower[Symbol.iterator]().next(), TransactionLogUntilUnreachedError);
				}
				assert.ok(injection.refused > 0, 'the read never reached the unmappable segment');
				assert.equal(follower.failedLogs.size, 0, 'a log short of its bound was failed');
			} finally {
				injection.restore();
			}
			const ids = [];
			const iterator = follower[Symbol.iterator]();
			for (let result = iterator.next(); !result.done; result = iterator.next()) {
				if (result.value.tableId === T.tableId) ids.push(result.value.recordId);
			}
			// merged by key, and the peer's key comes from the wall clock rather than this process's log clock
			assert.deepEqual(ids.map(String).sort(), ['0', '1', '2', 'peer']);
		});

		it('holds the replay until the log can be read, then delivers each write once', async function () {
			const T = ownTable();
			if (!T.auditStore.reusableIterable) return this.skip();
			const startTime = Date.now() - 1;
			const dispatched = [];
			const opening = await T.subscribe({ isCollection: true, listener: (event) => dispatched.push(event.id) });
			for (let i = 0; i < 3; i++) await T.put(i, { name: 'before' });
			await waitFor(() => dispatched.length === 3, { timeout: 5000 });
			const injection = refuseMapping(T.auditStore.logByName.get('local'));
			let subscription;
			const events = [];
			try {
				subscription = await T.subscribe({ startTime, isCollection: true });
				subscription.on('data', (event) => events.push(event));
				await waitFor(() => injection.refused > 0, { timeout: 5000 });
				await T.put('during', { name: 'during' });
				await waitFor(() => dispatched.includes('during'), { timeout: 5000 });
				assert.deepEqual(events, [], 'the replay handed off without reading the log');
			} finally {
				injection.restore();
			}
			try {
				await T.put('sentinel', { name: 'sentinel' });
				await waitFor(() => events.some((event) => event.id === 'sentinel'), { timeout: 5000 });
				for (const id of [0, 1, 2, 'during', 'sentinel']) {
					assert.equal(countBy(events, id), 1, `${id} not delivered exactly once`);
				}
			} finally {
				opening.end();
				subscription?.end();
			}
		});

		it('refuses a checked resume whose history is pruned while it waits', async function () {
			const T = ownTable();
			if (!T.auditStore.reusableIterable) return this.skip();
			const positions = [];
			const opening = await T.subscribe({ isCollection: true, listener: (event) => positions.push(event.localTime) });
			for (let i = 0; i < 3; i++) await T.put(i, { name: 'before' });
			await waitFor(() => positions.length === 3, { timeout: 5000 });
			const injection = refuseMapping(T.auditStore.logByName.get('local'));
			try {
				const subscription = await T.subscribe({
					startTime: positions[0],
					isCollection: true,
					databaseGeneration: getDatabaseGeneration(T.auditStore).id,
				});
				await waitFor(() => injection.refused > 0, { timeout: 5000 });
				raiseAuditFloor(T.auditStore, positions[2]);
				// well inside the replay's wait limit, so the refusal comes from rechecking after a wait
				await waitFor(() => subscription.closed, { timeout: 2000 });
				assert.equal(await subscription.resumeVerified, false);
			} finally {
				injection.restore();
				opening.end();
			}
		});
	});

	describe('reading a log until another range', () => {
		const ids = (range, count = Infinity) => {
			const iterator = range[Symbol.iterator]();
			const found = [];
			while (found.length < count) {
				const { done, value } = iterator.next();
				if (done) break;
				found.push(value.recordId);
			}
			return found;
		};
		// the database's log is shared with other tables' setup, so only this table's writes count
		const sequenced = (T, entries) => entries.filter((entry) => entry.tableId === T.tableId).map((e) => e.recordId);

		it('stops where the other range stands, and resumes as it advances', async function () {
			const T = freshTable();
			if (!T.auditStore.reusableIterable) return this.skip();
			const start = Date.now() - 1;
			const leader = T.auditStore.getRange({ peekAhead: true });
			for (let i = 0; i < 6; i++) await T.put(i, { name: 'x' });
			const leaderIterator = leader[Symbol.iterator]();
			const led = [];
			const lead = (count) => {
				for (let n = 0; n < count; n++) led.push(leaderIterator.next().value);
			};
			const follower = T.auditStore.getRange({ start, exclusiveStart: true, until: leader });
			const followerIterator = follower[Symbol.iterator]();
			const followed = [];
			const follow = () => {
				for (let result = followerIterator.next(); !result.done; result = followerIterator.next())
					followed.push(result.value);
			};
			// nothing dispatched yet: everything is the leader's, even the entry it holds unconsumed
			follow();
			assert.deepEqual(sequenced(T, followed), []);
			while (sequenced(T, led).length < 2) lead(1);
			follow();
			assert.deepEqual(sequenced(T, followed), [0, 1]);
			while (sequenced(T, led).length < 6) lead(1);
			follow();
			assert.deepEqual(sequenced(T, followed), [0, 1, 2, 3, 4, 5]);
			await T.put(6, { name: 'x' });
			follow();
			assert.deepEqual(
				sequenced(T, followed),
				[0, 1, 2, 3, 4, 5],
				"an entry the leader has not reached is the leader's"
			);
			assert.deepEqual(ids(leader).includes(6), true);
			follow();
			assert.deepEqual(sequenced(T, followed), [0, 1, 2, 3, 4, 5, 6]);
		});

		it('leaves a log the other range has not read to it', async function () {
			// its own database: the entries written to the second log are not audit records, and no broadcast should read them
			const T = table({
				table: 'SubReplayUntilLogs',
				database: 'subReplayUntilLogs',
				attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
				audit: true,
			});
			if (!T.auditStore.reusableIterable) return this.skip();
			const store = T.auditStore;
			const start = Date.now() - 1;
			const leader = store.getRange({ peekAhead: true });
			const follower = store.getRange({ start, exclusiveStart: true, until: leader, includeLogName: true });
			const followerIterator = follower[Symbol.iterator]();
			const peer = store.rootStore.useLog('subReplayUntilPeer');
			await store.rootStore.transaction(async (txn) => peer.addEntry(Buffer.alloc(32), txn.id));
			store.ensureLogExists('subReplayUntilPeer');
			assert.equal(followerIterator.next().done, true, 'the first read of a new log belongs to the other range');
			const leaderIterator = leader[Symbol.iterator]();
			while (!leaderIterator.next().done);
			const { done, value } = followerIterator.next();
			assert.ok(!done);
			assert.equal(value.logName, 'subReplayUntilPeer');
			assert.equal(followerIterator.next().done, true);
		});

		it('reads on past a range that closed its log iterator', async function () {
			const T = freshTable();
			if (!T.auditStore.reusableIterable) return this.skip();
			const start = Date.now() - 1;
			const leader = T.auditStore.getRange({ peekAhead: true });
			await T.put('written', { name: 'x' });
			for (const log of T.auditStore.nodeLogs.filter(Boolean)) leader.sourceOf(log)?.close();
			const followed = [...T.auditStore.getRange({ start, exclusiveStart: true, until: leader })];
			assert.deepEqual(sequenced(T, followed), ['written']);
		});
	});
});
