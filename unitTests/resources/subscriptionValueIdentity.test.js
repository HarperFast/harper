const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils.js');
const { table } = require('#src/resources/databases');
const { INVALIDATED } = require('#src/resources/Table');
const { transaction } = require('#src/resources/transaction');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { waitFor } = require('../waitFor.js');
require('#src/server/serverHelpers/serverUtilities');
const { getSharedMessageEncoding } = require('#src/server/serverHelpers/sharedMessageEncoding');

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
		assert.ok(Object.isFrozen(first.value), 'a shared reconstruction is read-only, as a decoded record is');
		firstSub.end();
		secondSub.end();
	});

	// Only subscription delivery shares a reconstruction: a history read gets one of its own, unfrozen, as it always has.
	it('leaves a history read its own reconstruction of a patched version', async function () {
		const HistoryPatchTable = table({
			database: 'data',
			table: 'HistoryPatchIdentity',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'reading' }, { name: 'unit' }],
			audit: true,
		});
		await HistoryPatchTable.put({ id: 'sensor-4', reading: 1, unit: 'C' });
		await HistoryPatchTable.patch('sensor-4', { reading: 2 });
		await HistoryPatchTable.patch('sensor-4', { unit: 'F' });
		const patchedOnce = (history) => history.find((entry) => entry.value?.reading === 2 && entry.value?.unit === 'C');
		const first = patchedOnce(await HistoryPatchTable.getHistoryOfRecord('sensor-4'));
		const second = patchedOnce(await HistoryPatchTable.getHistoryOfRecord('sensor-4'));
		assert.ok(first && second, 'history includes the first patched version');
		assert.ok(!Object.isFrozen(first.value), 'a history read can change its own copy');
		assert.notStrictEqual(first.value, second.value, 'each history read reconstructs its own');
	});

	// The other half of the contract: identity is only a safe cache key because it changes when the
	// content does. If two versions of a record ever shared one object, the fan-out would serve the
	// older version's bytes for the newer one.
	// A storm of subscribers to a collection (clients reconnecting after an outage) each scan its current
	// records. Each scan decodes its own copy, which defeated the shared encoding: one serialization and one
	// packet per subscriber per record. Overlapping scans share one object per version.
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
		// three: two overlapping scans do not cache for each other (MIN_SHARING_SCANS)
		const snapshots = await Promise.all([snapshot(), snapshot(), snapshot()]);
		const last = ids[ids.length - 1];
		await waitFor(() => snapshots.every(({ values }) => values.has(last)), { message: 'the snapshots complete' });
		// sharing needs three overlapping scans, which the middle of the table has; once one finishes, the tail does not
		const middleObjects = new Set(snapshots.map(({ values }) => values.get(ids[150])));
		assert.ok(middleObjects.size < snapshots.length, 'the scans share the record object');
		for (const [i, id] of ids.entries()) {
			const seen = new Map();
			for (const { values } of snapshots) {
				const value = values.get(id);
				assert.strictEqual(value.reading, i);
				// every subscriber receives a shared value, so no subscriber may change it
				if (seen.has(value)) assert.ok(Object.isFrozen(value), `the shared value of ${id} is frozen`);
				seen.set(value, true);
			}
		}
		// the scans shared among themselves, leaving the record cache to what get() reads
		assert.strictEqual(SnapshotTable.primaryStore.cachedEntry(ids[150]), undefined, 'a scan cached a row');
		for (const { subscription } of snapshots) subscription.end();
	});

	// While scans share values, a row is decoded only when no overlapping scan has decoded its version, so the
	// tombstone check runs after the shared lookup: deleted rows must still be skipped and live ones arrive as stored.
	it('delivers every live row and no deleted one to overlapping snapshots that share values', async function () {
		if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return this.skip();
		const TombstoneTable = table({
			database: 'data',
			table: 'SubscriptionSnapshotTombstones',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'reading' }],
			audit: true,
		});
		const ids = Array.from({ length: 300 }, (_, i) => `t${String(i).padStart(3, '0')}`);
		for (const [i, id] of ids.entries()) await TombstoneTable.put({ id, reading: i });
		const deleted = new Set(ids.filter((_, i) => i % 7 === 3));
		for (const id of deleted) await TombstoneTable.delete(id);
		const live = ids.filter((id) => !deleted.has(id));
		const snapshot = async () => {
			const values = new Map();
			const subscription = await TombstoneTable.subscribe({ isCollection: true });
			subscription.on('data', (event) => event.type === 'put' && values.set(event.id, event.value));
			return { subscription, values };
		};
		const snapshots = await Promise.all([snapshot(), snapshot(), snapshot(), snapshot()]);
		await waitFor(() => snapshots.every(({ values }) => values.has(live.at(-1))), {
			message: 'the snapshots complete',
		});
		for (const { values } of snapshots) {
			assert.strictEqual(values.size, live.length, 'each snapshot delivers every live row once');
			for (const [i, id] of ids.entries()) {
				if (deleted.has(id)) assert.ok(!values.has(id), `${id} was deleted`);
				else assert.strictEqual(values.get(id).reading, i);
			}
		}
		const middleObjects = new Set(snapshots.map(({ values }) => values.get(live[150])));
		assert.ok(middleObjects.size < snapshots.length, 'the scans share the record object');
		for (const { subscription } of snapshots) subscription.end();
	});

	// A deferred row is decoded as `decode` would have, so one that can not be is skipped, not a failed scan.
	it('reads an undecodable deferred row as null, as an undecodable row is read', async function () {
		if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return this.skip();
		const Undecodable = table({
			database: 'data',
			table: 'SubscriptionUndecodableRow',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'reading' }],
		});
		// an array of two whose second element is missing
		assert.strictEqual(Undecodable.primaryStore.encoder.decodeDeferred(Buffer.from([0x92, 0x01])), null);
	});

	// A row whose flags rule it out of sharing would be decoded anyway, so it is not kept undecoded.
	it('decodes at once a row whose metadata flags rule it out of sharing', async function () {
		if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return this.skip();
		const Flagged = table({
			database: 'data',
			table: 'SubscriptionFlaggedRows',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'reading' }],
		});
		await Flagged.put({ id: 'plain', reading: 1 });
		await Flagged.put({ id: 'invalidated', reading: 2 });
		await Flagged.invalidate('invalidated');
		const entries = new Map();
		for (const entry of Flagged.primaryStore.getRange({
			versions: true,
			deferValues: () => true,
			deferExcept: INVALIDATED,
		}))
			entries.set(entry.key, entry);
		assert.strictEqual(entries.get('plain').constructor.name, 'DeferredRangeEntry', 'precondition: rows are deferred');
		assert.notStrictEqual(entries.get('invalidated').constructor.name, 'DeferredRangeEntry');
		assert.strictEqual(entries.get('plain').value.reading, 1);
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
		// three, as sharing needs; the middle of the table is where they overlap
		const snapshots = await Promise.all([snapshot(), snapshot(), snapshot()]);
		const last = ids[ids.length - 1];
		await waitFor(() => snapshots.every(({ values }) => values.has(last)), { message: 'the snapshots complete' });
		const middleObjects = new Set(snapshots.map(({ values }) => values.get(ids[150])));
		assert.strictEqual(middleObjects.size, snapshots.length, 'snapshots of a computed table shared a value');
		for (const { subscription } of snapshots) subscription.end();
	});

	// A serialized record carries its @enumerable relationships, which another record's write changes without
	// changing this record's version, so a later snapshot must not reuse an earlier one's serialization.
	it('delivers the related record as it is now to a later snapshot of a table with an enumerable relationship', async function () {
		const Owner = table({
			database: 'data',
			table: 'SubscriptionSnapshotOwner',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
		const Device = table({
			database: 'data',
			table: 'SubscriptionSnapshotDevice',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'ownerId' },
				{ name: 'owner', relationship: { from: 'ownerId' }, definition: { tableClass: Owner }, enumerable: true },
			],
			audit: true,
		});
		await Owner.put({ id: 'o1', name: 'before' });
		await Device.put({ id: 'd1', ownerId: 'o1' });
		await Device.get('d1'); // the device's record is now in the cache, as a read before the snapshots leaves it
		const snapshotPayload = async () => {
			let event;
			const subscription = await Device.subscribe({ isCollection: true });
			subscription.on('data', (data) => data.type === 'put' && (event = data));
			await waitFor(() => event, { message: 'the snapshot delivers the device' });
			subscription.end();
			// as the MQTT fan-out serializes a delivered record
			return String(await getSharedMessageEncoding(event.value, undefined, event.version).payload);
		};
		assert.match(await snapshotPayload(), /"before"/);
		await Owner.put({ id: 'o1', name: 'after' });
		const later = await snapshotPayload();
		assert.match(later, /"after"/, `the later snapshot serialized the owner's earlier name: ${later}`);
	});

	// A replay's put holds the whole record at its version, so overlapping replays share the value one of them decoded,
	// for a version since superseded or deleted too, without reading the record (which holds only the latest).
	it('shares superseded versions among overlapping replays without reading the record', async function () {
		if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return this.skip();
		const ReplayTable = table({
			database: 'data',
			table: 'SubscriptionReplaySuperseded',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'reading' }],
			audit: true,
		});
		const startTime = Date.now() - 1;
		const ids = Array.from({ length: 300 }, (_, i) => `d${String(i).padStart(3, '0')}`);
		for (const [i, id] of ids.entries()) await ReplayTable.put({ id, reading: i });
		// every first version is superseded, and half the records are then deleted
		for (const id of ids) await ReplayTable.put({ id, reading: -1 });
		for (const id of ids.filter((_, i) => i % 2 === 0)) await ReplayTable.delete(id);
		const middle = ids[151];
		// the record cache now holds the record's latest version, which is not the one the replays share
		await ReplayTable.get(middle);
		const store = ReplayTable.primaryStore;
		assert.strictEqual(store.cachedEntry(middle)?.value.reading, -1);
		const getEntry = store.getEntry;
		let reads = 0;
		store.getEntry = function (...args) {
			reads++;
			return getEntry.apply(this, args);
		};
		try {
			const replay = async () => {
				const firstVersions = new Map();
				let ended = false;
				const subscription = await ReplayTable.subscribe({
					isCollection: true,
					startTime,
					includeSuperseded: true,
					omitCurrent: true,
				});
				subscription.on('data', (event) => {
					if (event.type === 'put' && event.value?.reading !== -1) firstVersions.set(event.id, event.value);
					if (event.type === 'delete' && event.id === ids[298]) ended = true;
				});
				return { subscription, firstVersions, isEnded: () => ended };
			};
			const replays = await Promise.all([replay(), replay(), replay()]);
			await waitFor(() => replays.every(({ isEnded }) => isEnded()), { message: 'every replay reached the end' });
			assert.strictEqual(reads, 0, 'records read for sharing');
			for (const { firstVersions } of replays) assert.strictEqual(firstVersions.get(middle).reading, 151);
			const objects = new Set(replays.map(({ firstVersions }) => firstVersions.get(middle)));
			assert.ok(objects.size < replays.length, 'the replays share the superseded version');
			for (const { subscription } of replays) subscription.end();
		} finally {
			store.getEntry = getEntry;
		}
	});

	// A replay carries a run of patches forward from the version before each (ReplayReader). A put the overlapping replays
	// share never reaches that reader, so the patch after it must be built on the put, not carried from before it.
	it('builds the patches after a put that overlapping replays share on that put', async function () {
		if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return this.skip();
		const CarryTable = table({
			database: 'data',
			table: 'SubscriptionReplayCarry',
			schemaDefined: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'n' }, { name: 'phase' }],
			audit: true,
		});
		const startTime = Date.now() - 1;
		const filler = (prefix) => Array.from({ length: 300 }, (_, i) => `${prefix}${String(i).padStart(3, '0')}`);
		// records around the carried record's writes keep the replays overlapping, and keep its two puts apart: the
		// shared map holds one version per record, which a replay reading both in one turn would replace
		for (const id of filler('a')) await CarryTable.put({ id, n: -1 });
		const expected = [];
		await CarryTable.put({ id: 'carried', n: 0, phase: 'first' });
		expected.push([0, 'first']);
		for (let n = 1; n <= 6; n++) {
			await CarryTable.patch('carried', { n });
			expected.push([n, 'first']);
		}
		for (const id of filler('m')) await CarryTable.put({ id, n: -1 });
		await CarryTable.put({ id: 'carried', n: 100, phase: 'second' });
		expected.push([100, 'second']);
		for (let n = 101; n <= 106; n++) {
			await CarryTable.patch('carried', { n });
			expected.push([n, 'second']);
		}
		const after = filler('z');
		for (const id of after) await CarryTable.put({ id, n: -1 });
		const replay = async () => {
			const carried = [];
			let ended = false;
			const subscription = await CarryTable.subscribe({
				isCollection: true,
				startTime,
				includeSuperseded: true,
				omitCurrent: true,
			});
			subscription.on('data', (event) => {
				if (event.id === 'carried') carried.push(event.value);
				if (event.id === after.at(-1)) ended = true;
			});
			return { subscription, carried, isEnded: () => ended };
		};
		const replays = await Promise.all([replay(), replay(), replay()]);
		await waitFor(() => replays.every(({ isEnded }) => isEnded()), { message: 'every replay reached the end' });
		for (const { carried } of replays) {
			assert.deepStrictEqual(
				carried.map((value) => [value.n, value.phase]),
				expected
			);
		}
		const secondPut = new Set(replays.map(({ carried }) => carried[7]));
		assert.ok(secondPut.size < replays.length, 'the replays share the second put');
		for (const { subscription } of replays) subscription.end();
	});

	// A transaction gives every write one version and log position, and can write a record more than once: a replay
	// delivers each of those writes, a snapshot the record as the last left it, so neither may take the other's value
	// or the record cache's in place of an earlier write's.
	for (const cached of [false, true]) {
		it(`delivers each write of a record written more than once in a transaction${cached ? ', cached' : ''}, to overlapping replays and a snapshot`, async function () {
			if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return this.skip();
			const RepeatTable = table({
				database: 'data',
				table: `SubscriptionRepeatWrites${cached ? 'Cached' : ''}`,
				attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'step' }, { name: 'done' }],
				audit: true,
			});
			const startTime = Date.now() - 1;
			const ids = Array.from({ length: 300 }, (_, i) => `w${String(i).padStart(3, '0')}`);
			for (const id of ids) {
				await transaction({}, async (context) => {
					await RepeatTable.put(id, { step: 1 }, context);
					await RepeatTable.put(id, { step: 2 }, context);
					await RepeatTable.patch(id, { done: true }, context);
				});
			}
			// the record cache then holds each record as the transaction left it, under the version all three writes carry
			if (cached) for (const id of ids) await RepeatTable.get(id);
			const replay = async () => {
				const writes = new Map();
				const subscription = await RepeatTable.subscribe({
					isCollection: true,
					startTime,
					includeSuperseded: true,
					omitCurrent: true,
				});
				subscription.on('data', (event) => {
					if (event.type !== 'put') return;
					if (!writes.has(event.id)) writes.set(event.id, []);
					writes.get(event.id).push({ ...event.value });
				});
				return { subscription, writes };
			};
			const snapshot = async () => {
				const values = new Map();
				const subscription = await RepeatTable.subscribe({ isCollection: true });
				subscription.on('data', (event) => event.type === 'put' && values.set(event.id, event.value));
				return { subscription, values };
			};
			const [one, two, three, current] = await Promise.all([replay(), replay(), replay(), snapshot()]);
			const last = ids[ids.length - 1];
			await waitFor(
				() => [one, two, three].every(({ writes }) => writes.get(last)?.length === 3) && current.values.has(last),
				{ message: 'the replays and the snapshot complete' }
			);
			for (const id of ids) {
				for (const { writes } of [one, two, three])
					assert.deepStrictEqual(
						writes.get(id),
						[
							{ id, step: 1 },
							{ id, step: 2 },
							{ id, step: 2, done: true },
						],
						`the writes to ${id}`
					);
				assert.deepStrictEqual({ ...current.values.get(id) }, { id, step: 2, done: true }, `the record ${id}`);
			}
			for (const { subscription } of [one, two, three, current]) subscription.end();
		});
	}

	// Such a record's version names more than one write (VERSION_REUSED), so a snapshot shares none of its rows, not
	// even with replays that stored a write at that version.
	it('delivers the record as it stands to a snapshot that overlaps parked replays of records written more than once in a transaction', async function () {
		if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return this.skip();
		const RepeatTable = table({
			database: 'data',
			table: 'SubscriptionRepeatWritesParked',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'step' }, { name: 'done' }],
			audit: true,
		});
		const startTime = Date.now() - 1;
		const ids = Array.from({ length: 300 }, (_, i) => `p${String(i).padStart(3, '0')}`);
		for (const id of ids) {
			await transaction({}, async (context) => {
				await RepeatTable.put(id, { step: 1 }, context);
				await RepeatTable.put(id, { step: 2 }, context);
				await RepeatTable.patch(id, { done: true }, context);
			});
		}
		// unread, each replay parks once its queue is full, still overlapping, with the writes it decoded shared
		const replays = [];
		for (let i = 0; i < 3; i++)
			replays.push(
				await RepeatTable.subscribe({ isCollection: true, startTime, includeSuperseded: true, omitCurrent: true })
			);
		await waitFor(() => replays.every((replay) => replay.queue?.length > 100), { message: 'the replays park' });
		const values = new Map();
		const snapshot = await RepeatTable.subscribe({ isCollection: true });
		snapshot.on('data', (event) => event.type === 'put' && values.set(event.id, event.value));
		await waitFor(() => values.has(ids[ids.length - 1]), { message: 'the snapshot completes' });
		// the replays' last write shared for each record is its second put, which the patch then changed
		for (const id of ids)
			assert.deepStrictEqual({ ...values.get(id) }, { id, step: 2, done: true }, `the record ${id}`);
		for (const subscription of [...replays, snapshot]) subscription.end();
	});

	// Two overlapping scans share nothing: the one reuse does not pay for the bookkeeping per row. A snapshot's own
	// value is not frozen (a replay's is, as on main), so a frozen snapshot value is a shared one.
	it('shares nothing between just two overlapping snapshots of a table', async function () {
		if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return this.skip();
		const SnapshotTable = table({
			database: 'data',
			table: 'SubscriptionSnapshotPair',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'reading' }],
			audit: true,
		});
		// more records than a scan sends before it yields, so the second scan starts while the first is in flight
		for (let i = 0; i < 300; i++) await SnapshotTable.put({ id: `p${String(i).padStart(3, '0')}`, reading: i });
		const snapshot = async () => {
			let received = 0;
			let frozen = 0;
			const subscription = await SnapshotTable.subscribe({ isCollection: true });
			subscription.on('data', (event) => {
				if (event.type !== 'put') return;
				received++;
				if (Object.isFrozen(event.value)) frozen++;
			});
			return { subscription, received: () => received, frozen: () => frozen };
		};
		const snapshots = await Promise.all([snapshot(), snapshot()]);
		await waitFor(() => snapshots.every(({ received }) => received() >= 300), { message: 'both snapshots finished' });
		for (const { frozen } of snapshots) assert.strictEqual(frozen(), 0, 'values shared between two scans');
		for (const { subscription } of snapshots) subscription.end();
	});

	// Sharing reads no record, so scans of different records, and composite ids (which an identity-keyed lookup
	// never finds), read nothing extra, even with the three scans sharing needs.
	for (const [label, idOf, scope] of [
		['different records', (prefix, i) => `${prefix}/${String(i).padStart(3, '0')}`, (prefix) => `${prefix}/`],
		['composite ids', (prefix, i) => [prefix, i], () => undefined],
	]) {
		it(`reads nothing extra for overlapping replays of ${label}`, async function () {
			if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return this.skip();
			const ReplayTable = table({
				database: 'data',
				table: `SubscriptionReplayNoShare${label.replace(/\W/g, '')}`,
				attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'reading' }],
				audit: true,
			});
			const startTime = Date.now() - 1;
			for (const prefix of ['a', 'b', 'c'])
				for (let i = 0; i < 300; i++) await ReplayTable.put({ id: idOf(prefix, i), reading: i });
			const store = ReplayTable.primaryStore;
			const getEntry = store.getEntry;
			let reads = 0;
			store.getEntry = function (id, ...rest) {
				// subscribe() loads its own target (`a/`); only the records themselves are read for sharing
				if (typeof id !== 'string' || !id.endsWith('/')) reads++;
				return getEntry.call(this, id, ...rest);
			};
			try {
				const replay = async (prefix) => {
					let received = 0;
					const subscription = await ReplayTable.subscribe({
						id: scope(prefix),
						isCollection: true,
						startTime,
						includeSuperseded: true,
						omitCurrent: true,
					});
					subscription.on('data', (event) => event.type === 'put' && received++);
					return { subscription, received: () => received };
				};
				// different prefixes for different records; the same records for composite ids
				const prefixes = scope('a') ? ['a', 'b', 'c'] : ['a', 'a', 'a'];
				const replays = await Promise.all(prefixes.map(replay));
				const expected = scope('a') ? 300 : 900;
				await waitFor(() => replays.every(({ received }) => received() >= expected), {
					message: 'both replays finished',
				});
				assert.strictEqual(reads, 0, 'records read for sharing that no other scan could share');
				for (const { subscription } of replays) subscription.end();
			} finally {
				store.getEntry = getEntry;
			}
		});
	}

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
		store.cache.setValue(id, preMerge.value);
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
