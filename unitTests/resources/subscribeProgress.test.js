const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { getDatabaseGeneration, readAuditEntry } = require('#src/resources/auditStore');
const { transaction } = require('#src/resources/transaction');
const { IterableEventQueue } = require('#src/resources/IterableEventQueue');
const { deliveryCertified, setOriginCaptureIntervalForTests } = require('#src/resources/transactionBroadcast');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { waitFor } = require('../waitFor');
require('#src/server/serverHelpers/serverUtilities');

const isRocksDB = process.env.HARPER_STORAGE_ENGINE !== 'lmdb';

let sequence = 0;
function tableInOwnDatabase(name = `Progress${++sequence}`) {
	return table({
		table: name,
		database: `progress_${name}`,
		audit: true,
		attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'value' }],
	});
}

const registry = (subscription) => subscription.subscriptions.tables.envs;

describe('Certified subscription progress', function () {
	if (!isRocksDB) return;
	this.timeout(60_000);
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
	});

	it('changes nothing for a subscription that does not ask for it', async () => {
		const T = tableInOwnDatabase();
		const subscription = await T.subscribe({ omitCurrent: true });
		assert.strictEqual(subscription.progress, undefined);
		assert.strictEqual(subscription.sentCount, undefined);
		assert.strictEqual(subscription.send, IterableEventQueue.prototype.send);
		assert.ok(!registry(subscription).progressConsumers);
		subscription.end();
	});

	it('reports the lowest late event the consumer has not consumed, and keeps only what a consumer has not taken', async () => {
		const T = tableInOwnDatabase();
		const send = (subscription, localTime) => subscription.send({ type: 'put', id: `k${localTime}`, localTime });
		const queued = await T.subscribe({ omitCurrent: true, reportProgress: true });
		// 15 and 12 arrive below 20, 18 below 30; 12 follows 15, so 15 can never be the lowest
		for (const key of [10, 20, 15, 12, 30, 18]) send(queued, key);
		// a scan row and a control event carry no log position
		queued.send({ type: 'put', id: 'scan', localTime: 1, fromScan: true });
		queued.send({ type: 'checkpoint' });
		assert.strictEqual(queued.lowestLateUnconsumed(0), 12);
		assert.strictEqual(queued.lowestLateUnconsumed(3), 12);
		assert.strictEqual(queued.lowestLateUnconsumed(4), 18, 'consumed through 12');
		assert.strictEqual(queued.lowestLateUnconsumed(6), undefined, 'every late event consumed');
		queued.end();
		// a callback consumer takes each event as it is sent: only the last one taken can still be in hand
		const listened = await T.subscribe({ omitCurrent: true, reportProgress: true, listener: () => {} });
		for (const key of [100, 50, 60, 70]) send(listened, key);
		assert.strictEqual(listened.lowestLateUnconsumed(0), 60);
		listened.end();
	});

	it('runs one follow-up pass, not a chain, while a key from another origin is ahead of this clock', async () => {
		const T = tableInOwnDatabase();
		await T.put('seed', { value: 0 });
		const delivered = [];
		const subscription = await T.subscribe({
			omitCurrent: true,
			reportProgress: true,
			listener: (event) => delivered.push(event.id),
		});
		const databaseRegistry = registry(subscription);
		await waitFor(() => !databaseRegistry.notifyScheduled && !databaseRegistry.recheckPending);
		// stands in for a replicated entry whose origin's clock leads this node's by a minute
		const ahead = T.primaryStore.rootStore.getMonotonicTimestamp() + 60_000;
		databaseRegistry.dispatchedThrough = ahead;
		await T.put('local', { value: 'local' });
		await waitFor(() => delivered.includes('local'));
		await waitFor(() => !databaseRegistry.notifyScheduled && !databaseRegistry.recheckPending, {
			timeout: 1_000,
			message: 'notify passes kept following each other while the remote key was ahead',
		});
		assert.ok(!(databaseRegistry.certifiedThrough >= ahead), 'nothing certifies past this clock');
		subscription.end();
	});

	it('follows the watermark once live, which a yield inside one transaction does not advance', async () => {
		const T = tableInOwnDatabase();
		await T.put('seed', { value: 0 });
		const samples = [];
		let subscription;
		subscription = await T.subscribe({
			omitCurrent: true,
			reportProgress: true,
			listener: (event) => {
				if (event.value?.value !== 'bulk') return;
				samples.push({ key: event.localTime, progress: subscription.progress() });
			},
		});
		await transaction({}, async (context) => {
			for (let i = 0; i < 300; i++) await T.put(`t${i}`, { value: 'bulk' }, context);
		});
		await waitFor(() => samples.length === 300);
		const key = samples[0].key;
		assert.ok(
			samples.every((sample) => sample.key === key && !(sample.progress >= key)),
			'no sample taken while the transaction was being dispatched certifies it'
		);
		await waitFor(() => subscription.progress() >= key);
		assert.strictEqual(subscription.sentCount, 300);
		const databaseRegistry = registry(subscription);
		assert.strictEqual(databaseRegistry.progressConsumers, 1);
		subscription.end();
		subscription.end();
		assert.strictEqual(databaseRegistry.progressConsumers, 0, 'ending twice uncounts once');
	});

	it('a same-thread progress subscription follows its watermark, held below a write this thread still has open', async () => {
		const T = tableInOwnDatabase();
		await T.put('seed', { value: 0 });
		const subscription = await T.subscribe({ omitCurrent: true, reportProgress: true, crossThreads: false });
		let commitHeld;
		const held = transaction({}, async (context) => {
			await T.put('held', { value: 'held' }, context);
			await new Promise((resolve) => (commitHeld = resolve));
		});
		await waitFor(() => commitHeld);
		await T.put('a', { value: 1 });
		const key = T.primaryStore.getEntry('a').version;
		await waitFor(() => subscription.progress() !== undefined);
		assert.ok(subscription.progress() < key, `progress ${subscription.progress()} passed the held write below ${key}`);
		commitHeld();
		await held;
		await waitFor(() => subscription.progress() >= key, {
			message: () => `progress ${subscription.progress()} < ${key}`,
		});
		subscription.end();
	});

	it('a held same-thread registry leaves every write to the cross-thread subscriber on its thread', async () => {
		const T = tableInOwnDatabase();
		await T.put('seed', { value: 0 });
		const crossThread = [];
		const across = await T.subscribe({
			omitCurrent: true,
			reportProgress: true,
			listener: (event) => crossThread.push(event.id),
		});
		const sameThread = await T.subscribe({ omitCurrent: true, reportProgress: true, crossThreads: false });
		let commitHeld;
		const held = transaction({}, async (context) => {
			await T.put('held', { value: 'held' }, context);
			await new Promise((resolve) => (commitHeld = resolve));
		});
		await waitFor(() => commitHeld);
		await T.put('a', { value: 1 });
		await T.put('b', { value: 2 });
		commitHeld();
		await held;
		await T.put('c', { value: 3 });
		await waitFor(() => ['a', 'b', 'held', 'c'].every((id) => crossThread.includes(id)), {
			message: () => `the cross-thread subscriber received ${crossThread}`,
		});
		const key = T.primaryStore.getEntry('c').version;
		await waitFor(() => across.progress() >= key && sameThread.progress() >= key);
		across.end();
		sameThread.end();
	});

	it('a same-thread registry re-captures on its own timer when a held write aborts', async () => {
		setOriginCaptureIntervalForTests(50);
		try {
			const T = tableInOwnDatabase();
			await T.put('seed', { value: 0 });
			const subscription = await T.subscribe({ omitCurrent: true, reportProgress: true, crossThreads: false });
			let abort;
			const aborted = transaction({}, async (context) => {
				await T.put('doomed', { value: 'doomed' }, context);
				await new Promise((resolve) => (abort = resolve));
				throw new Error('abort the held write');
			}).catch(() => {});
			await waitFor(() => abort);
			await T.put('a', { value: 1 });
			const key = T.primaryStore.getEntry('a').version;
			await waitFor(() => subscription.progress() !== undefined);
			assert.ok(subscription.progress() < key, 'the held write holds progress');
			abort();
			await aborted;
			await waitFor(() => subscription.progress() >= key, {
				timeout: 5_000,
				message: 'progress did not catch up after the abort',
			});
			subscription.end();
		} finally {
			setOriginCaptureIntervalForTests();
		}
	});

	it('does not register a new subscription at a watermark left from earlier tracking', async () => {
		const T = tableInOwnDatabase();
		await T.put('seed', { value: 0 });
		const first = await T.subscribe({ omitCurrent: true, reportProgress: true });
		await T.put('a', { value: 1 });
		await waitFor(() => first.progress() !== undefined);
		first.end();
		// a plain subscription keeps the broadcaster dispatching while nothing tracks progress
		const keys = [];
		const plain = await T.subscribe({ omitCurrent: true, listener: (event) => keys.push(event.localTime) });
		await T.put('b', { value: 2 });
		await waitFor(() => keys.length === 1);
		const next = await T.subscribe({ omitCurrent: true, reportProgress: true });
		assert.ok(!(next.registeredThrough < keys[0]), 'the registration position covers the write dispatched before it');
		next.end();
		plain.end();
	});

	it('keeps a registration drain inside its transaction until the remaining batch is dispatched', async () => {
		const T = tableInOwnDatabase();
		const rows = [];
		const ends = [];
		const first = await T.subscribe({
			omitCurrent: true,
			reportProgress: true,
			supportsTransactions: true,
			listener: (event) => {
				if (event.type === 'end_txn') ends.push(event);
				else rows.push(event);
			},
		});
		let second;
		try {
			await transaction({}, async (context) => {
				for (let i = 0; i < 300; i++) await T.put(`bulk${i}`, { value: i }, context);
			});
			second = await T.subscribe({ omitCurrent: true, reportProgress: true });
			assert.strictEqual(rows.length, 256, 'registration drains only one notify batch');
			const key = rows[0].localTime;
			assert.ok(!(first.progress() >= key), 'an incomplete transaction is not certified');
			assert.strictEqual(ends.length, 0, 'the transaction is still open');
			await waitFor(() => rows.length === 300 && ends.length === 1 && first.progress() >= key);
			assert.strictEqual(new Set(rows.map((event) => event.id)).size, 300);
		} finally {
			first.end();
			second?.end();
		}
	});

	it('tracks a failed log read on the iterator restarted after an idle interval', async () => {
		const T = tableInOwnDatabase();
		const first = await T.subscribe({ omitCurrent: true });
		const previousRange = T.auditStore.subscriptionLogRange;
		first.end();
		const subscription = await T.subscribe({ omitCurrent: true, reportProgress: true });
		const range = T.auditStore.subscriptionLogRange;
		assert.notStrictEqual(range, previousRange);
		range.failedLogs.add('unreadable');
		try {
			await T.put('after-restart', { value: 1 });
			await waitFor(() => registry(subscription).progressStopped);
			assert.strictEqual(subscription.progress(), undefined);
		} finally {
			range.failedLogs.delete('unreadable');
			subscription.end();
		}
	});

	for (const crossThreads of [true, false]) {
		it(`certifies a held scalar replay after release without another commit (crossThreads: ${crossThreads})`, async () => {
			setOriginCaptureIntervalForTests(60_000);
			const name = `Replay${++sequence}`;
			const T = tableInOwnDatabase(name);
			const Other = table({
				table: 'Other',
				database: `progress_${name}`,
				audit: true,
				attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'value' }],
			});
			let release;
			let held;
			let subscription;
			let other;
			try {
				await T.put('seed', { value: 0 });
				const startTime = T.primaryStore.getEntry('seed').version;
				held = transaction({}, async (context) => {
					await T.put('held', { value: 'held' }, context);
					await new Promise((resolve) => (release = resolve));
				});
				await waitFor(() => release);
				await T.put('higher', { value: 'higher' });
				const higher = T.primaryStore.getEntry('higher').version;
				other = await Other.subscribe({ omitCurrent: true, reportProgress: true });
				subscription = await T.subscribe({
					databaseGeneration: getDatabaseGeneration(T.auditStore).id,
					startTime,
					reportProgress: true,
					crossThreads,
					listener: () => {},
				});
				assert.strictEqual(await subscription.resumeVerified, true);
				assert.ok(!(subscription.progress() >= higher), 'replay cannot override the reservation ceiling');
				assert.ok(!(other.progress() >= higher), 'the sibling table shares the held certificate');
				if (!crossThreads) {
					assert.strictEqual(subscription.progress(), undefined, 'same-thread replay uses only its live certificate');
					assert.strictEqual(
						registry(subscription).dispatchedThrough,
						undefined,
						'cross-thread history is not injected'
					);
				}
				release();
				await held;
				if (crossThreads) {
					await waitFor(() => subscription.progress() >= higher && other.progress() >= higher, {
						message: 'completed replay did not catch up without an unrelated write or capture tick',
					});
				} else {
					await T.put('own-live', { value: 'own-live' });
					await waitFor(() => subscription.progress() >= T.primaryStore.getEntry('own-live').version);
				}
			} finally {
				release?.();
				await held;
				subscription?.end();
				other?.end();
				setOriginCaptureIntervalForTests();
			}
		});
	}

	it('completes scalar replay while a notify pass is yielded without certifying its partial transaction', async () => {
		const T = tableInOwnDatabase();
		await T.put('seed', { value: 0 });
		let startTime;
		let replay;
		let replayTask;
		let sawYield = false;
		const seen = [];
		const live = await T.subscribe({
			omitCurrent: true,
			reportProgress: true,
			listener: (event) => {
				seen.push(event);
				if (seen.length === 1)
					replayTask = new Promise((resolve, reject) =>
						setImmediate(async () => {
							try {
								sawYield = registry(live).passYielded;
								assert.ok(sawYield, 'the first transaction is only partly dispatched');
								replay = await T.subscribe({
									startTime,
									databaseGeneration: getDatabaseGeneration(T.auditStore).id,
									reportProgress: true,
									listener: () => {},
								});
								assert.strictEqual(await replay.resumeVerified, true);
								assert.ok(registry(live).passYielded, 'the short replay completed before the pending drain');
								assert.ok(!(live.progress() >= event.localTime), 'a yielded pass cannot certify a partial transaction');
								resolve();
							} catch (error) {
								reject(error);
							}
						})
					);
			},
		});
		try {
			await waitFor(() => !registry(live).notifyScheduled);
			registry(live).notifyScheduled = true;
			await transaction({}, async (context) => {
				for (let i = 0; i < 300; i++) await T.put(`bulk${i}`, { value: i }, context);
			});
			startTime = [...T.auditStore.getRange({ start: 1 })].find((entry) => entry.recordId === 'bulk0').txnLogKey;
			await T.put('tail', { value: 'tail' });
			registry(live).notifyScheduled = false;
			await T.put('trigger', { value: 'trigger' });
			await waitFor(() => Boolean(replayTask));
			await replayTask;
			await waitFor(() => seen.length === 302 && live.progress() >= seen[0].localTime);
			assert.ok(sawYield);
			assert.strictEqual(seen.length, 302, 'the replay did not start an overlapping live drain');
		} finally {
			registry(live).notifyScheduled = false;
			replay?.end();
			live.end();
		}
	});

	it('does not inject replay progress after a failed live range read', async () => {
		const T = tableInOwnDatabase();
		await T.put('seed', { value: 0 });
		const startTime = T.primaryStore.getEntry('seed').version;
		await T.put('higher', { value: 1 });
		const live = await T.subscribe({ omitCurrent: true, reportProgress: true });
		const range = T.auditStore.subscriptionLogRange;
		range.failedLogs.add('unreadable');
		let replay;
		try {
			replay = await T.subscribe({
				startTime,
				databaseGeneration: getDatabaseGeneration(T.auditStore).id,
				reportProgress: true,
				listener: () => {},
			});
			await replay.resumeVerified;
			assert.strictEqual(deliveryCertified(replay), false);
			assert.strictEqual(registry(live).dispatchedThrough, undefined);
		} finally {
			range.failedLogs.delete('unreadable');
			replay?.end();
			live.end();
		}
	});

	it('follows a checked replay, then the watermark', async () => {
		const T = tableInOwnDatabase();
		const positions = [];
		const live = await T.subscribe({ omitCurrent: true, listener: (event) => positions.push(event.localTime) });
		for (let i = 0; i < 3; i++) await T.put(`r${i}`, { value: i });
		await waitFor(() => positions.length === 3);
		live.end();
		const seen = [];
		let subscription;
		subscription = await T.subscribe({
			databaseGeneration: getDatabaseGeneration(T.auditStore).id,
			startTime: positions[0],
			reportProgress: true,
			listener: () => seen.push(subscription?.progress()),
		});
		assert.strictEqual(await subscription.resumeVerified, true);
		assert.ok(subscription.progress() >= positions[2], 'the replay handled through the last write');
		subscription.end();
	});

	for (const includeSuperseded of [false, true]) {
		it(`keeps an update to an already-scanned row (includeSuperseded: ${includeSuperseded})`, async () => {
			const T = tableInOwnDatabase();
			for (let i = 0; i < 150; i++) await T.put(`r${String(i).padStart(3, '0')}`, { value: i });
			const received = [];
			let wrote = false;
			const subscription = await T.subscribe({
				reportProgress: true,
				includeSuperseded,
				listener: (event) => {
					received.push(event);
					if (!wrote && event.id === 'r050') {
						wrote = true;
						// r000 is already scanned; r149 is scanned later, with a newer time
						T.put('r000', { value: 'updated' });
						T.put('r149', { value: 'later' });
					}
				},
			});
			await waitFor(() => received.some((event) => event.id === 'r000' && event.value?.value === 'updated'));
			assert.ok(
				received.filter((event) => event.fromScan).length >= 150,
				'the scan events are tagged as state, not history'
			);
			subscription.end();
		});
	}

	it('ends rather than re-snapshotting at a reload marker', async () => {
		const T = tableInOwnDatabase();
		await T.put('seed', { value: 0 });
		const events = [];
		const subscription = await T.subscribe({
			omitCurrent: true,
			reportProgress: true,
			listener: (e) => events.push(e),
		});
		await T.writeReloadMarker();
		await waitFor(() => subscription.closed);
		assert.strictEqual(events.at(-1)?.code, 'RESUME_HISTORY_UNAVAILABLE');
	});

	it('stops advancing for good once its log range records a failed read', async () => {
		const T = tableInOwnDatabase();
		await T.put('seed', { value: 0 });
		const subscription = await T.subscribe({ omitCurrent: true, reportProgress: true });
		await T.put('a', { value: 1 });
		await waitFor(() => subscription.progress() !== undefined);
		const stopped = subscription.progress();
		T.auditStore.subscriptionLogRange.failedLogs.add('unreadable');
		try {
			await T.put('b', { value: 2 });
			await T.put('c', { value: 3 });
			await new Promise((resolve) => setTimeout(resolve, 50));
			assert.strictEqual(subscription.progress(), stopped);
			assert.strictEqual(registry(subscription).progressStopped, true);
		} finally {
			T.auditStore.subscriptionLogRange.failedLogs.delete('unreadable');
			subscription.end();
		}
	});

	it('stops certifying delivery once its log range records a failed read', async () => {
		const T = tableInOwnDatabase();
		await T.put('seed', { value: 0 });
		const subscription = await T.subscribe({ omitCurrent: true, reportProgress: true });
		const uncertified = await T.subscribe({ omitCurrent: true });
		assert.strictEqual(deliveryCertified(subscription), true);
		assert.strictEqual(deliveryCertified(uncertified), false, 'only a subscription that tracks progress');
		// no record follows the failure, so no drain advances progress past it
		T.auditStore.subscriptionLogRange.failedLogs.add('unreadable');
		try {
			assert.strictEqual(deliveryCertified(subscription), false);
			assert.strictEqual(registry(subscription).progressStopped, true);
		} finally {
			T.auditStore.subscriptionLogRange.failedLogs.delete('unreadable');
			subscription.end();
			uncertified.end();
		}
		assert.strictEqual(deliveryCertified(subscription), false, 'an ended subscription');
	});

	it('stops advancing at an entry it cannot decode', async () => {
		const T = tableInOwnDatabase();
		await T.put('seed', { value: 0 });
		const subscription = await T.subscribe({ omitCurrent: true, reportProgress: true });
		const range = T.auditStore.subscriptionLogRange;
		const iterate = range[Symbol.iterator];
		let injected = false;
		range[Symbol.iterator] = function () {
			const iterator = iterate.call(this);
			return {
				next() {
					if (!injected) {
						injected = true;
						return { value: readAuditEntry(new Uint8Array(12).fill(0xff)), done: false };
					}
					return iterator.next();
				},
				[Symbol.iterator]() {
					return this;
				},
			};
		};
		try {
			await T.put('a', { value: 1 });
			await waitFor(() => injected);
			await T.put('b', { value: 2 });
			await new Promise((resolve) => setTimeout(resolve, 50));
			assert.strictEqual(registry(subscription).progressStopped, true);
		} finally {
			range[Symbol.iterator] = iterate;
			subscription.end();
		}
	});
});

describe('Certified subscription progress on LMDB', () => {
	if (isRocksDB) return;
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
	});

	it('is not offered, since LMDB has no reusable log range to certify from', async () => {
		const T = tableInOwnDatabase();
		const subscription = await T.subscribe({ omitCurrent: true, reportProgress: true });
		assert.strictEqual(subscription.progress, undefined);
		assert.strictEqual(subscription.sentCount, undefined);
		subscription.end();
	});
});
