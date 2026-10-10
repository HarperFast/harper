const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils.js');
const { table } = require('#src/resources/databases');
const { transaction } = require('#src/resources/transaction');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { waitFor } = require('../waitFor.js');
require('#src/server/serverHelpers/serverUtilities');

// server/serverHelpers/sharedMessageEncoding.ts encodes a message once and reuses it across every
// subscriber of a topic, keyed on the message object's identity. That is only sound because a
// fan-out delivers ONE object instance to every subscription — this pins that premise. If a change
// makes each subscription decode its own copy, the MQTT fan-out silently reverts to one
// serialization per subscriber with no other test noticing (byte equality holds either way).
describe('subscription value identity across subscribers', () => {
	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
	});

	it('delivers the same value object instance to every subscriber of a record write', async function () {
		const IdentityTable = table({
			database: 'data',
			table: 'SubscriptionValueIdentity',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'reading' }],
			audit: true,
		});
		const firstEvents = [];
		const secondEvents = [];
		const firstSub = await IdentityTable.subscribe({});
		firstSub.on('data', (event) => firstEvents.push(event));
		const secondSub = await IdentityTable.subscribe({});
		secondSub.on('data', (event) => secondEvents.push(event));

		await IdentityTable.put({ id: 'sensor-1', reading: 21.5 });

		const isPut = (event) => event.type === 'put' && event.id === 'sensor-1';
		await waitFor(() => firstEvents.some(isPut), { message: 'first subscriber receives the put' });
		await waitFor(() => secondEvents.some(isPut), { message: 'second subscriber receives the put' });

		const first = firstEvents.find(isPut);
		const second = secondEvents.find(isPut);
		assert.notStrictEqual(first, second, 'each subscription builds its own event object');
		assert.strictEqual(
			first.value,
			second.value,
			'both subscribers must receive the SAME record object — the shared MQTT encoding keys on it'
		);
		assert.strictEqual(first.value.reading, 21.5);
	});

	// A subscriber that includes superseded versions (an MQTT QoS 1 durable session) gets a patch as the
	// full record at that version, rebuilt from the record's history. One rebuild must serve the whole
	// fan-out: rebuilding per subscriber walked the transaction log once per subscriber, and the fresh
	// objects also defeated the shared encoding.
	it('delivers one reconstruction of a patched record to every subscriber that includes superseded versions', async function () {
		const PatchTable = table({
			database: 'data',
			table: 'SubscriptionPatchIdentity',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'reading' }, { name: 'unit' }],
			audit: true,
		});
		await PatchTable.put({ id: 'sensor-3', reading: 1, unit: 'C' });
		const firstEvents = [];
		const secondEvents = [];
		const firstSub = await PatchTable.subscribe({ includeSuperseded: true, omitCurrent: true });
		firstSub.on('data', (event) => firstEvents.push(event));
		const secondSub = await PatchTable.subscribe({ includeSuperseded: true, omitCurrent: true });
		secondSub.on('data', (event) => secondEvents.push(event));

		await PatchTable.patch('sensor-3', { reading: 2 });

		const isPatched = (event) => event.id === 'sensor-3' && event.value?.reading === 2;
		await waitFor(() => firstEvents.some(isPatched), { message: 'first subscriber receives the patch' });
		await waitFor(() => secondEvents.some(isPatched), { message: 'second subscriber receives the patch' });
		const first = firstEvents.find(isPatched);
		const second = secondEvents.find(isPatched);
		assert.strictEqual(first.value.unit, 'C', 'the patch arrives as the full record');
		assert.strictEqual(first.value, second.value, 'both subscribers must receive the SAME reconstructed record');
		firstSub.end();
		secondSub.end();
	});

	// The other half of the contract: identity is only a safe cache key because it changes when the
	// content does. If two versions of a record ever shared one object, the fan-out would serve the
	// older version's bytes for the newer one.
	// A storm of subscribers to a collection (clients reconnecting after an outage) each scan its current
	// records. Each scan decodes its own copy, which defeated the shared encoding: one serialization and one
	// packet per subscriber per record. Overlapping scans share one object per version through the record cache.
	it('delivers one value object per record version to snapshots of a collection that overlap', async function () {
		if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return this.skip();
		const SnapshotTable = table({
			database: 'data',
			table: 'SubscriptionSnapshotIdentity',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'reading' }],
			audit: true,
		});
		// more records than a scan sends before it yields, so the second scan starts while the first is in flight
		const ids = Array.from({ length: 250 }, (_, i) => `r${String(i).padStart(3, '0')}`);
		for (const [i, id] of ids.entries()) await SnapshotTable.put({ id, reading: i });
		const snapshot = async () => {
			const values = new Map();
			const subscription = await SnapshotTable.subscribe({ isCollection: true });
			subscription.on('data', (event) => event.type === 'put' && values.set(event.id, event.value));
			return { subscription, values };
		};
		const [first, second] = await Promise.all([snapshot(), snapshot()]);
		const last = ids[ids.length - 1];
		await waitFor(() => first.values.has(last) && second.values.has(last), { message: 'both snapshots complete' });
		assert.strictEqual(first.values.get(last), second.values.get(last), 'the scans share the record object');
		assert.strictEqual(first.values.get(last).reading, ids.length - 1);
		for (const [i, id] of ids.entries()) {
			assert.strictEqual(first.values.get(id).reading, i);
			assert.strictEqual(second.values.get(id).reading, i);
		}
		first.subscription.end();
		second.subscription.end();
	});

	// A computed attribute's resolver may read the subscriber's context while the value is serialized, so
	// one subscriber's serialization must not be shared with another's.
	it('shares no value object across snapshots of a table that surfaces a computed attribute', async function () {
		if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return this.skip();
		const ComputedTable = table({
			database: 'data',
			table: 'SubscriptionSnapshotComputed',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'reading' },
				{ name: 'label', enumerable: true, computed: true },
			],
			audit: true,
		});
		ComputedTable.setComputedAttribute('label', (record) => `reading ${record.reading}`);
		const ids = Array.from({ length: 250 }, (_, i) => `c${String(i).padStart(3, '0')}`);
		for (const [i, id] of ids.entries()) await ComputedTable.put({ id, reading: i });
		const snapshot = async () => {
			const values = new Map();
			const subscription = await ComputedTable.subscribe({ isCollection: true });
			subscription.on('data', (event) => event.type === 'put' && values.set(event.id, event.value));
			return { subscription, values };
		};
		const [first, second] = await Promise.all([snapshot(), snapshot()]);
		const last = ids[ids.length - 1];
		await waitFor(() => first.values.has(last) && second.values.has(last), { message: 'both snapshots complete' });
		assert.notStrictEqual(first.values.get(last), second.values.get(last));
		first.subscription.end();
		second.subscription.end();
	});

	// The record cache is per thread, and an out-of-order write merged into a record keeps its version
	// (VERSION_REUSED), so another thread can still cache the record's pre-merge value under that version.
	it('delivers the stored record to a snapshot, not an older value another thread caches under its version', async function () {
		if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return this.skip();
		const MergeTable = table({
			database: 'data',
			table: 'SubscriptionSnapshotMerge',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }, { name: 'other' }],
			audit: true,
		});
		const store = MergeTable.primaryStore;
		const id = 'merged-1';
		await MergeTable.put(id, { name: 'v0' });
		// an older transaction that commits after a newer one is merged in under the newer version
		let release;
		let staged;
		const isStaged = new Promise((resolve) => (staged = resolve));
		const olderCommitted = transaction({}, async (context) => {
			await MergeTable.patch(id, { other: 'older' }, context);
			staged();
			await new Promise((resolve) => (release = resolve));
		});
		await isStaged;
		await MergeTable.patch(id, { name: 'newer' });
		store.getEntry(id);
		const preMerge = store.cachedEntry(id);
		release();
		await olderCommitted;
		assert.strictEqual(store.getEntry(id).version, preMerge.version, 'the merged write reuses the version');
		// the write cleared only this thread's cache; any other thread that read the record still holds this
		store.cacheEntry(preMerge);
		const values = new Map();
		const subscription = await MergeTable.subscribe({ isCollection: true });
		subscription.on('data', (event) => event.type === 'put' && values.set(event.id, event.value));
		await waitFor(() => values.has(id), { message: 'the snapshot delivers the record' });
		assert.deepStrictEqual({ ...values.get(id) }, { id, name: 'newer', other: 'older' });
		subscription.end();
	});

	it('delivers a distinct value object for each version of a record', async function () {
		const VersionTable = table({
			database: 'data',
			table: 'SubscriptionValueVersions',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'reading' }],
			audit: true,
		});
		const events = [];
		const subscription = await VersionTable.subscribe({});
		subscription.on('data', (event) => events.push(event));

		await VersionTable.put({ id: 'sensor-2', reading: 1 });
		await waitFor(() => events.some((e) => e.value?.reading === 1), { message: 'first version delivered' });
		await VersionTable.put({ id: 'sensor-2', reading: 2 });
		await waitFor(() => events.some((e) => e.value?.reading === 2), { message: 'second version delivered' });

		const first = events.find((e) => e.value?.reading === 1);
		const second = events.find((e) => e.value?.reading === 2);
		assert.notStrictEqual(first.value, second.value, 'a new version must be a new object, or bytes go stale');
		assert.notStrictEqual(first.version, second.version);
	});
});
