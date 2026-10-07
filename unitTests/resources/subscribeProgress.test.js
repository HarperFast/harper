const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { getDatabaseGeneration, readAuditEntry } = require('#src/resources/auditStore');
const { transaction } = require('#src/resources/transaction');
const { IterableEventQueue } = require('#src/resources/IterableEventQueue');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
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
