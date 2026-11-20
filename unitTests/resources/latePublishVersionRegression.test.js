require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { waitFor } = require('../waitFor.js');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const { getIdOfRemoteNode } = require('#src/resources/nodeIdMapping');
const { getAuditFloor, getDatabaseGeneration, raiseAuditFloor } = require('#src/resources/auditStore');
const { Transaction } = require('@harperfast/rocksdb-js');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';
// LMDB keys a record's log by local time, so its newest message is the last to arrive, and startTime is a local
// time too
const onRocksDB = isLMDB ? it.skip : it;

describe('A publish older than its record', function () {
	this.timeout(20000);
	let Topics, peerA, peerB;
	// each case gets its own span of origin log keys (a key is one origin transaction), above the new database's
	// audit floor, which an out-of-order write below would lose to without reconciling
	let caseBase;
	let T0;
	const at = (offset) => T0 + offset;

	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
		Topics = table({
			table: 'LatePublishes',
			database: 'latePublishVersionRegression',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }, { name: 'n' }],
			audit: true,
		});
		// on a version tie the later node name wins, so peer B beats peer A
		peerA = getIdOfRemoteNode('late-publish-peer-a', Topics.auditStore);
		peerB = getIdOfRemoteNode('late-publish-peer-b', Topics.auditStore);
		const floor = getAuditFloor(Topics.auditStore);
		caseBase = Number.isFinite(floor) ? Math.max(floor, Date.now()) : Date.now();
	});
	beforeEach(() => {
		T0 = caseBase += 100_000;
	});

	function apply(key, nodeId, writes, Table = Topics) {
		const context = { source: {}, sourceApply: true, timestamp: key };
		return transaction(context, async () => {
			for (const write of writes) {
				const resource = await Table.getResource(write.id, context);
				const options = { isNotification: true, nodeId, version: write.version ?? key };
				if (write.message) resource._writePublish(write.id, write.message, options);
				else if (write.remove) await resource._writeDelete(write.id, options);
				else await resource._writeUpdate(write.id, write.record, write.fullUpdate ?? true, options);
			}
		});
	}
	const put = (id, name, version, nodeId = peerA) => apply(version, nodeId, [{ id, record: { id, name } }]);
	const patch = (id, name, version, nodeId = peerA) =>
		apply(version, nodeId, [{ id, record: { name }, fullUpdate: false }]);
	const publish = (id, n, version, nodeId = peerA) => apply(version, nodeId, [{ id, message: { n } }]);

	function recordState(id) {
		const entry = Topics.primaryStore.getEntry(id);
		return { name: entry?.value?.name, version: entry?.version - T0 };
	}
	const messagesOf = (events) => events.filter((event) => event.type === 'message').map((event) => event.value.n);
	const sorted = (values) => values.sort((a, b) => a - b);

	async function backfill(id, request) {
		const events = [];
		const subscription = await Topics.subscribe({ id, omitCurrent: true, ...request });
		subscription.on('data', (event) => events.push(event));
		try {
			await publish(id, 'end', at(90_000));
			await waitFor(() => events.some((event) => event.value?.n === 'end'), { timeout: 5000 });
		} finally {
			subscription.end();
		}
		return messagesOf(events).filter((n) => n !== 'end');
	}

	describe('the record value', () => {
		onRocksDB('keeps unaudited CRDT receipts after a burst of late publishes', async () => {
			const NoAudit = table({
				table: 'NoAuditLatePublishes',
				database: 'noAuditLatePublishes',
				attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'n' }],
				audit: false,
			});
			const origin = getIdOfRemoteNode('no-audit-late-publish-origin', NoAudit.auditStore);
			await apply(at(30_000), origin, [{ id: 'counter', record: { id: 'counter', n: 0 } }], NoAudit);
			const increment = [{ id: 'counter', record: { n: { __op__: 'add', value: 1 } }, fullUpdate: false }];
			for (let n = 1; n <= 3; n++) await apply(at(n * 1000), origin, increment, NoAudit);
			const receipts = NoAudit.primaryStore.getEntry('counter').receivedIdentityRefs;
			assert.ok(receipts.length >= 3, 'precondition: several CRDT identities are recorded');
			for (let n = 1; n <= 24; n++) await apply(at(5000 + n), origin, [{ id: 'counter', message: { n } }], NoAudit);
			const afterPublish = NoAudit.primaryStore.getEntry('counter');
			await apply(at(1000), origin, increment, NoAudit);
			assert.deepEqual(
				{ receipts: afterPublish.receivedIdentityRefs, n: (await NoAudit.get('counter')).n },
				{ receipts, n: 3 },
				'late publishes must preserve every receipt and a redelivery must not increment again'
			);
			assert.equal(afterPublish.additionalAuditRefs, undefined);
		});

		onRocksDB('keeps an unaudited late publish retry free of audit refs', async () => {
			const NoAudit = table({
				table: 'NoAuditPublishRetry',
				database: 'noAuditPublishRetry',
				attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'n' }],
				audit: false,
			});
			const origin = getIdOfRemoteNode('no-audit-retry-origin', NoAudit.auditStore);
			await apply(at(30_000), origin, [{ id: 'counter', record: { id: 'counter', n: 0 } }], NoAudit);
			const increment = [{ id: 'counter', record: { n: { __op__: 'add', value: 1 } }, fullUpdate: false }];
			await apply(at(1000), origin, increment, NoAudit);
			const context = { source: {}, sourceApply: true, timestamp: at(5000) };
			let native, receipts, publishWrite;
			await transaction(context, async () => {
				const resource = await NoAudit.getResource('counter', context);
				await resource._writePublish(
					'counter',
					{ n: 'late' },
					{ isNotification: true, nodeId: origin, version: at(5000) }
				);
				publishWrite = context.transaction.writes.find((write) => write.key === 'counter');
				await context.transaction.save(publishWrite);
				native = context.transaction.transaction;
				await apply(at(40_000), origin, increment, NoAudit);
				receipts = NoAudit.primaryStore.getEntry('counter').receivedIdentityRefs;
			});
			assert.ok(native.retries > 0, 'precondition: the publish really retried against the concurrent add');
			assert.notStrictEqual(publishWrite.loggedBase, undefined, 'precondition: the retry retains its logged base');
			assert.notStrictEqual(native.relogOnRetry, true, 'precondition: the retry uses the existing log entry');
			const entry = NoAudit.primaryStore.getEntry('counter');
			assert.equal(entry.additionalAuditRefs, undefined);
			assert.deepEqual(entry.receivedIdentityRefs, receipts);
			await apply(at(1000), origin, increment, NoAudit);
			assert.equal((await NoAudit.get('counter')).n, 2);
		});

		onRocksDB('keeps an unaudited publish head locator without adding late refs', async () => {
			const NoAudit = table({
				table: 'NoAuditPublishHead',
				database: 'noAuditPublishHead',
				attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'n' }],
				audit: false,
			});
			const origin = getIdOfRemoteNode('no-audit-head-origin', NoAudit.auditStore);
			await apply(at(40_007), origin, [{ id: 'topic', message: { n: 1 }, version: at(40_000) }], NoAudit);
			const refs = NoAudit.primaryStore.getEntry('topic').additionalAuditRefs;
			assert.deepEqual(refs, [{ version: at(40_007), nodeId: origin }]);
			await apply(at(50_000), origin, [{ id: 'topic', message: { n: 2 }, version: at(30_000) }], NoAudit);
			assert.deepEqual(NoAudit.primaryStore.getEntry('topic').additionalAuditRefs, refs);
			const events = [];
			const subscription = await NoAudit.subscribe({
				id: 'topic',
				startTime: at(39_000),
				omitCurrent: true,
				listener: (event) => events.push(event),
			});
			try {
				assert.equal(NoAudit.audit, true, 'subscribe enables auditing');
				assert.deepEqual(
					messagesOf(events),
					[1],
					'the head stays discoverable; unaudited late messages are not replayed'
				);
			} finally {
				subscription.end();
			}
		});

		it('keeps the newer put when a late put arrives (control, no publish)', async () => {
			await put('c1', 'B', at(200));
			await put('c1', 'C', at(170));
			assert.deepEqual(recordState('c1'), { name: 'B', version: 200 });
		});

		it('keeps the newer put when a late publish and then a late put arrive', async () => {
			await put('d1', 'B', at(200));
			await publish('d1', 1, at(150));
			await put('d1', 'C', at(170));
			assert.deepEqual(recordState('d1'), { name: 'B', version: 200 });
		});

		it('keeps the newer put when one transaction carried two late publishes to it', async () => {
			await put('d6', 'B', at(200));
			await apply(at(150), peerA, [
				{ id: 'd6', message: { n: 1 } },
				{ id: 'd6', message: { n: 2 } },
			]);
			await put('d6', 'C', at(170));
			assert.deepEqual(recordState('d6'), { name: 'B', version: 200 });
		});

		it('keeps the newer put when a late put arrives before a late publish', async () => {
			await put('d2', 'B', at(200));
			await put('d2', 'C', at(170));
			await publish('d2', 1, at(150));
			await put('d2', 'D', at(160));
			assert.deepEqual(recordState('d2'), { name: 'B', version: 200 });
		});

		it('keeps the newer put when a late put ties the late publish’s version', async () => {
			await put('d3', 'B', at(200));
			await publish('d3', 1, at(150));
			await put('d3', 'C', at(150), peerB);
			assert.deepEqual(recordState('d3'), { name: 'B', version: 200 });
		});

		it('keeps a put from a peer whose clock is ahead when this node publishes locally', async () => {
			const ahead = Date.now() + 60_000;
			await put('d4', 'B', ahead);
			await Topics.publish('d4', { n: 1 });
			await put('d4', 'C', ahead - 30_000, peerB);
			const entry = Topics.primaryStore.getEntry('d4');
			assert.deepEqual({ name: entry.value.name, behindPeer: ahead - entry.version }, { name: 'B', behindPeer: 0 });
		});

		it('keeps the record when a delete older than it arrives after a late publish (#3637)', async () => {
			await put('d5', 'B', at(200));
			await publish('d5', 1, at(150));
			await apply(at(170), peerA, [{ id: 'd5', remove: true }]);
			assert.deepEqual(recordState('d5'), { name: 'B', version: 200 });
		});

		it('applies a late put older than an in-order publish but newer than the record’s last write', async () => {
			await put('f1', 'B', at(200));
			await publish('f1', 1, at(300));
			await put('f1', 'C', at(250), peerB);
			// the put's origin applied C at 250 and then the publish at 300, so it holds C
			assert.equal(recordState('f1').name, 'C');
			// an LMDB merge stores the merged write's own, older version (#3388)
			if (!isLMDB) assert.equal(recordState('f1').version, 300);
		});

		it('applies a late patch older than an in-order publish but newer than the record’s last write', async () => {
			await put('f2', 'B', at(200));
			await publish('f2', 1, at(300));
			await patch('f2', 'P', at(250), peerB);
			assert.equal(recordState('f2').name, 'P');
			if (!isLMDB) assert.equal(recordState('f2').version, 300);
		});
	});

	describe('the record version and reads that start from it', () => {
		it('keeps the record version at its latest write after a late publish', async () => {
			await put('v1', 'B', at(200));
			await publish('v1', 1, at(150));
			assert.equal((await Topics.get('v1')).name, 'B');
			assert.equal(recordState('v1').version, 200);
		});

		async function topicWithLateMessage(id) {
			await publish(id, 1, at(100));
			await publish(id, 3, at(300));
			await publish(id, 2, at(200));
		}

		it('lists every message of a topic in its history after a late publish', async () => {
			await topicWithLateMessage('h1');
			assert.deepEqual(sorted(messagesOf(await Topics.getHistoryOfRecord('h1'))), [1, 2, 3]);
		});

		it('lists the put a late publish landed on in the record’s history', async () => {
			await put('h2', 'B', at(200));
			await publish('h2', 1, at(150));
			assert.deepEqual((await Topics.getHistoryOfRecord('h2')).map((entry) => entry.type).sort(), ['message', 'put']);
		});

		onRocksDB('lists a late message whose log key is far from the newer writes around it', async () => {
			await publish('h3', 1, at(1_000));
			await publish('h3', 3, at(20_000));
			await publish('h3', 2, at(10_000));
			await publish('h3', 4, at(30_000));
			assert.deepEqual(messagesOf(await Topics.getHistoryOfRecord('h3')), [1, 2, 3, 4]);
		});

		onRocksDB('backfills the newest message for previousCount: 1 after a late publish', async () => {
			await topicWithLateMessage('s1');
			assert.deepEqual(await backfill('s1', { previousCount: 1 }), [3]);
		});

		it('backfills every message for previousCount: 3 after a late publish', async () => {
			await topicWithLateMessage('s2');
			assert.deepEqual(sorted(await backfill('s2', { previousCount: 3 })), [1, 2, 3]);
		});

		onRocksDB('backfills a message newer than startTime after a late publish', async () => {
			await topicWithLateMessage('s3');
			assert.deepEqual(await backfill('s3', { startTime: at(250) }), [3]);
		});

		onRocksDB('backfills a late message after newer writes replaced the record’s refs, in version order', async () => {
			await publish('s4', 1, at(1_000));
			await publish('s4', 3, at(20_000));
			await publish('s4', 2, at(10_000));
			await publish('s4', 4, at(30_000));
			await put('s4', 'B', at(40_000));
			assert.deepEqual(await backfill('s4', { startTime: at(0) }), [1, 2, 3, 4]);
		});

		onRocksDB('backfills every late message of a burst longer than a record holds refs for', async () => {
			await publish('s5', 0, at(50_000));
			for (let n = 1; n <= 30; n++) await publish('s5', n, at(n * 1_000));
			await publish('s5', 31, at(60_000));
			const expected = Array.from({ length: 32 }, (_, n) => n);
			assert.deepEqual(sorted(messagesOf(await Topics.getHistoryOfRecord('s5'))), expected);
			assert.deepEqual(sorted(await backfill('s5', { startTime: at(0) })), expected);
		});

		onRocksDB('backfills two late messages to one topic from one origin transaction', async () => {
			await publish('s6', 3, at(30_000));
			await apply(at(20_000), peerA, [
				{ id: 's6', message: { n: 1 } },
				{ id: 's6', message: { n: 2 } },
			]);
			assert.deepEqual(sorted(await backfill('s6', { startTime: at(0) })), [1, 2, 3]);
		});

		onRocksDB('backfills a late message whose log key is above startTime while its record’s is not', async () => {
			await publish('s7', 3, at(30_000));
			await apply(at(40_000), peerB, [{ id: 's7', message: { n: 2 }, version: at(20_000) }]);
			assert.equal(recordState('s7').version, 30_000);
			assert.deepEqual(await backfill('s7', { startTime: at(35_000) }), [2]);
		});

		onRocksDB('keeps the requested live gate after replaying only a late ref', async () => {
			await publish('gate', 3, at(30_000));
			await apply(at(40_000), peerB, [{ id: 'gate', message: { n: 2 }, version: at(20_000) }]);
			const events = [];
			const subscription = await Topics.subscribe({
				id: 'gate',
				startTime: at(35_000),
				omitCurrent: true,
				listener: (event) => events.push(event),
			});
			try {
				assert.deepEqual(messagesOf(events), [2], 'the retained late message is replayed');
				await publish('gate', 'too-old', at(32_000));
				await publish('gate', 'end', at(90_000));
				await waitFor(() => events.some((event) => event.value?.n === 'end'), { timeout: 5000 });
				assert.deepEqual(messagesOf(events), [2, 'end']);
			} finally {
				subscription.end();
			}
		});

		onRocksDB('resumes from a retained late ref when the older head was pruned', async () => {
			const Retained = table({
				table: 'RetainedLatePublish',
				database: 'retainedLatePublish',
				attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'n' }],
				audit: true,
			});
			const headOrigin = getIdOfRemoteNode('retained-head', Retained.auditStore);
			const lateOrigin = getIdOfRemoteNode('retained-late', Retained.auditStore);
			await apply(at(30_000), headOrigin, [{ id: 'topic', message: { n: 3 } }], Retained);
			await apply(at(40_000), lateOrigin, [{ id: 'topic', message: { n: 2 }, version: at(20_000) }], Retained);
			const store = Retained.auditStore;
			raiseAuditFloor(store, at(35_000));
			store.rootStore.flushSync();
			await waitFor(
				() => {
					store.rootStore.purgeLogs({ name: 'retained-head', before: at(35_000) });
					return !store.getSync(at(30_000), Retained.tableId, 'topic', headOrigin, true);
				},
				{ timeout: 5000 }
			);
			assert.ok(store.getSync(at(40_000), Retained.tableId, 'topic', lateOrigin, true));
			const events = [];
			const request = {
				id: 'topic',
				startTime: at(35_000),
				databaseGeneration: getDatabaseGeneration(store).id,
				omitCurrent: true,
				listener: (event) => events.push(event),
			};
			const subscription = await Retained.subscribe({ ...request });
			try {
				assert.equal(await subscription.resumeVerified, true, events.map(String).join(', '));
				assert.equal(subscription.closed, false);
				assert.deepEqual(messagesOf(events), [2]);
			} finally {
				subscription.end();
			}
			raiseAuditFloor(store, at(45_000));
			store.rootStore.flushSync();
			await waitFor(
				() => {
					store.rootStore.purgeLogs({ name: 'retained-late', before: at(45_000) });
					return !store.getSync(at(40_000), Retained.tableId, 'topic', lateOrigin, true);
				},
				{ timeout: 5000 }
			);
			events.length = 0;
			const missing = await Retained.subscribe({ ...request });
			try {
				assert.equal(await missing.resumeVerified, false, 'a missing late ref above startTime still refuses');
				assert.equal(events[0]?.constructor.name, 'ResumeHistoryUnavailableError');
			} finally {
				missing.end();
			}
		});

		onRocksDB('replays late refs carried only by a retained head below startTime', async () => {
			await publish('head-refs', 0, at(30_000));
			await apply(at(50_000), peerB, [{ id: 'head-refs', message: { n: 1 }, version: at(20_000) }]);
			await publish('head-refs', 3, at(32_000));
			await apply(at(60_000), peerB, [{ id: 'head-refs', message: { n: 2 }, version: at(25_000) }]);
			assert.deepEqual(await backfill('head-refs', { startTime: at(40_000) }), [1, 2]);
		});

		onRocksDB('backfills a late message from a transaction that also writes thousands of other records', async () => {
			await publish('s9', 2, at(30_000));
			const writes = Array.from({ length: 3_000 }, (_, n) => ({ id: `other-${n}`, record: { id: `other-${n}` } }));
			writes.push({ id: 's9', message: { n: 1 } });
			await apply(at(20_000), peerB, writes);
			assert.deepEqual(sorted(await backfill('s9', { startTime: at(0) })), [1, 2]);
		});

		onRocksDB('follows refs only to late writes when every log key differs from its version', async () => {
			for (let n = 1; n <= 20; n++)
				await apply(at(n * 1_000 + 7), peerA, [{ id: 's8', message: { n }, version: at(n * 1_000) }]);
			await apply(at(30_000), peerB, [{ id: 's8', message: { n: 0 }, version: at(500) }]);
			const { getRange } = Topics.auditStore;
			let refReads = 0;
			Topics.auditStore.getRange = function (options) {
				if (options?.exactStart && options.readUncommitted && options.log !== undefined) refReads++;
				return getRange.call(this, options);
			};
			let newest;
			try {
				newest = await backfill('s8', { previousCount: 1 });
			} finally {
				Topics.auditStore.getRange = getRange;
			}
			assert.deepEqual(newest, [20]);
			assert.ok(refReads <= 6, `${refReads} log reads for the newest of 20 messages`);
		});

		onRocksDB('reads no log to subscribe without history to a record late messages left refs on', async () => {
			await put('r1', 'B', at(200));
			for (let n = 1; n <= 10; n++) await publish('r1', n, at(100 + n));
			assert.ok(Topics.primaryStore.getEntry('r1').additionalAuditRefs?.length > 0, 'the late messages left refs');
			const { getSync } = Topics.auditStore;
			let reads = 0;
			Topics.auditStore.getSync = function (key, tableId, id, ...rest) {
				if (tableId === Topics.tableId && id === 'r1') reads++;
				return getSync.call(this, key, tableId, id, ...rest);
			};
			// any head read precedes the first send, so each window can close on its first sends
			async function subscribeUntil(request, done) {
				const events = [];
				reads = 0;
				const subscription = await Topics.subscribe({ id: 'r1', ...request });
				subscription.on('data', (event) => events.push(event));
				try {
					await waitFor(() => done(events), { timeout: 5000 });
				} finally {
					subscription.end();
				}
				return { events, reads };
			}
			try {
				const current = await subscribeUntil({}, (events) => events.length > 0);
				assert.equal(current.events[0].value.name, 'B');
				assert.equal(current.reads, 0, `${current.reads} log reads to subscribe with no startTime`);
				const history = await subscribeUntil({ startTime: at(0) }, (events) => messagesOf(events).length >= 10);
				assert.deepEqual(sorted(messagesOf(history.events)), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
				assert.ok(history.reads > 0, 'a subscription with startTime reads the log');
			} finally {
				Topics.auditStore.getSync = getSync;
			}
		});

		onRocksDB('reaches a late message through the refs of the writes after it', async () => {
			await topicWithLateMessage('p1');
			const head = Topics.primaryStore.getEntry('p1');
			assert.equal(head.version - T0, 300);
			const late = head.additionalAuditRefs.map((ref) =>
				Topics.auditStore.getSync(ref.version, Topics.tableId, 'p1', ref.nodeId, true)
			);
			assert.deepEqual(
				late.map((entry) => entry?.version - T0),
				[300, 200]
			);
		});

		onRocksDB('finds the head in one log read after concurrent late publishes to a record', async () => {
			// a head newer than the local clock, so every concurrent publish is late
			await put('c1', 'B', at(90_000));
			for (let batch = 0; batch < 24; batch++)
				await Promise.all(Array.from({ length: 50 }, (_, n) => Topics.publish('c1', { n: batch * 50 + n })));
			const entry = Topics.primaryStore.getEntry('c1');
			assert.equal(entry.version - T0, 90_000);
			const first = entry.additionalAuditRefs[0];
			assert.equal(
				Topics.auditStore.getSync(first.version, Topics.tableId, 'c1', first.nodeId, true)?.version - T0,
				90_000
			);
			// after every write, so it finds the head and reads no history
			const startTime = Math.max(entry.version, ...(entry.additionalAuditRefs ?? []).map((ref) => ref.version)) + 1;
			const { getSync } = Topics.auditStore;
			let reads = 0;
			Topics.auditStore.getSync = function (key, tableId, id, ...rest) {
				if (tableId === Topics.tableId && id === 'c1') reads++;
				return getSync.call(this, key, tableId, id, ...rest);
			};
			try {
				(await Topics.subscribe({ id: 'c1', startTime })).end();
			} finally {
				Topics.auditStore.getSync = getSync;
			}
			assert.ok(reads <= 1, `${reads} log reads to find the head after concurrent publishes`);
		});

		onRocksDB('keeps the head first when a late publish retries with the log entry of its first attempt', async () => {
			await put('t1', 'B', at(300));
			const db = Topics.primaryStore.store.db;
			const { commit } = Transaction.prototype;
			let intercepted;
			let retried = false;
			Transaction.prototype.commit = function (...args) {
				if (this.store?.db !== db) return commit.apply(this, args);
				if (intercepted === undefined) {
					intercepted = this;
					// lands first, so this commit conflicts and retries without appending its entry again
					return publish('t1', 2, at(200)).then(() => commit.apply(this, args));
				}
				if (this === intercepted) retried = true;
				return commit.apply(this, args);
			};
			try {
				await publish('t1', 1, at(100));
			} finally {
				Transaction.prototype.commit = commit;
			}
			assert(retried, 'the late publish must have retried');
			const logged = [
				...Topics.auditStore.getRange({ start: at(100), exactStart: true, log: peerA, readUncommitted: true }),
			].filter((auditEntry) => auditEntry.txnLogKey === at(100) && auditEntry.recordId === 't1');
			assert.equal(logged.length, 1, 'the retry kept the entry its first attempt logged');
			assert.ok(!logged[0].previousAdditionalAuditRefs?.length, 'that entry predates the publish it lost to');
			const entry = Topics.primaryStore.getEntry('t1');
			assert.equal(entry.version - T0, 300);
			assert.deepEqual(
				entry.additionalAuditRefs.map((ref) => ref.version - T0),
				[300, 200, 100]
			);
			assert.deepEqual(sorted(messagesOf(await Topics.getHistoryOfRecord('t1'))), [1, 2]);
		});

		onRocksDB('keeps the head first and every late message reachable past the record’s ref budget', async () => {
			await put('b1', 'B', at(80_000));
			for (let n = 1; n <= 30; n++) await publish('b1', n, at(n * 1_000));
			const refs = Topics.primaryStore.getEntry('b1').additionalAuditRefs;
			assert.ok(refs.length < 31, `${refs.length} refs: the burst must overflow the record's ref budget`);
			assert.equal(refs[0].version - T0, 80_000);
			assert.equal(refs.at(-1).version - T0, 30_000);
			const expected = Array.from({ length: 30 }, (_, n) => n + 1);
			assert.deepEqual(sorted(messagesOf(await Topics.getHistoryOfRecord('b1'))), expected);
			assert.deepEqual(sorted(await backfill('b1', { startTime: at(0) })), expected);
		});

		onRocksDB('keeps the head first when crash replay restages a late publish', async () => {
			await put('x1', 'B', at(300));
			const context = { timestamp: at(100) };
			await transaction(context, async () => {
				context.transaction.isReplay = true;
				context.transaction.retries = 1;
				context.transaction.timestamp = at(100);
				const resource = await Topics.getResource('x1', context);
				resource._writePublish(
					'x1',
					{ n: 1 },
					{
						isReplay: true,
						nodeId: peerA,
						version: at(100),
						auditEntry: { type: 'message', version: at(100), previousVersion: at(300) },
					}
				);
			});
			const entry = Topics.primaryStore.getEntry('x1');
			assert.equal(entry.version - T0, 300);
			assert.deepEqual(
				entry.additionalAuditRefs.map((ref) => ref.version - T0),
				[300, 100]
			);
		});
	});
});
