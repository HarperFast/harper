require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath, ensureSystemTables } = require('../testUtils');
const { loadGQLSchema } = require('#src/resources/graphql');
const { databases, table } = require('#src/resources/databases');
const { server } = require('#src/server/Server');
const env = require('#src/utility/environment/environmentManager');
const { INVALIDATED } = require('#src/resources/Table');
const {
	setResidencyPlacementGuard,
	initializeResidencySlots,
	readResidencyMap,
	prepareResidencyDeclaration,
	installResidencyMap,
	getResidencyMapTable,
	residencyDeclarationDatabases,
} = require('#src/resources/residencyMaps');
const { createResidencyMap } = require('#src/resources/residencyPolicy');
const { compareResidencyPlacement } = require('#src/resources/residencyConversion');
const { replicationConfirmation } = require('#src/resources/DatabaseTransaction');
const { transaction } = require('#src/resources/transaction');

describe('Declarative residency', function () {
	this.timeout(20_000);
	let oldShards, oldConfiguredShards, oldShard;
	before(async () => {
		setupTestDBPath();
		await ensureSystemTables();
		oldShards = server.shards;
		oldConfiguredShards = env.get('replication_shards');
		oldShard = env.get('replication_shard');
		env.setProperty('replication_shards', [1, 0]);
		env.setProperty('replication_shard', 0);
		server.shards = new Map([
			[0, [{ name: server.hostname }]],
			[1, [{ name: 'slot-owner' }]],
		]);
	});
	afterEach(() => {
		setResidencyPlacementGuard(undefined);
		replicationConfirmation(undefined);
	});
	after(() => {
		server.shards = oldShards;
		env.setProperty('replication_shards', oldConfiguredShards);
		env.setProperty('replication_shard', oldShard);
	});

	async function declare(name, directive, fields = 'tag: String @indexed\nbody: String') {
		await loadGQLSchema(`type ${name} @table(database: "slots_test") ${directive} {
			id: ID @primaryKey
			${fields}
		}`);
		return databases.slots_test[name];
	}

	it('persists the policy and places a main-thread write without an application hook', async () => {
		const Records = await declare('SlotKeys', '@residency(slots: 10, slotFrom: "Number(id.slice(-1))")');
		await Records.put('key1', { id: 'key1', tag: 'indexed', body: 'complete' });
		const entry = Records.primaryStore.getEntry('key1');
		assert.ok(entry.metadataFlags & INVALIDATED);
		assert.equal(entry.value.tag, 'indexed');
		assert.equal(entry.value.body, undefined);
		assert.equal(entry.residencyId, undefined);
		assert.equal(entry.residencySlot, undefined);
		assert.deepEqual(Records.residency, { slots: 10, slotFrom: 'Number(id.slice(-1))', byAttribute: false });
		assert.deepEqual(Records.dbisDB.getSync('SlotKeys/').residency, Records.residency);
	});

	it('refuses both function setters on a declarative table', async () => {
		const Records = await declare('SlotSetters', '@residency(slots: 10)');
		assert.throws(() => Records.setResidency(() => [server.hostname]), /@residency/);
		assert.throws(() => Records.setResidencyById(() => 0), /@residency/);
	});

	it('does not retain a non-owner row without secondary indexes', async () => {
		const Records = await declare('SlotNoIndex', '@residency(slots: 10, slotFrom: "1")', 'body: String');
		await Records.put('remote', { id: 'remote', body: 'complete' });
		assert.equal(Records.primaryStore.getEntry('remote')?.value, undefined);
	});

	it('stores attribute slot zero independently of legacy residency IDs', async () => {
		const Records = await declare(
			'SlotAttributes',
			'@residency(slots: 10, slotFrom: "region", byAttribute: true)',
			'tag: String @indexed\nregion: Int\nbody: String'
		);
		await Records.put('zero', { id: 'zero', region: 0, tag: 'zero', body: 'complete' });
		const entry = Records.primaryStore.getEntry('zero');
		assert.equal(entry.residencySlot, 0);
		assert.equal(entry.residencyId, undefined);
		assert.equal(entry.value.body, 'complete');
	});

	it('refuses an attribute-slot transition before commit without a connected new owner', async () => {
		const Records = await declare(
			'SlotOffline',
			'@residency(slots: 10, byAttribute: true, slotFrom: "region")',
			'region: Int @indexed\nbody: String'
		);
		await Records.put('moved', { id: 'moved', region: 0, body: 'retained' });
		const before = Records.primaryStore.getEntry('moved');
		await assert.rejects(
			async () => Records.put('moved', { id: 'moved', region: 1, body: 'changed' }),
			/confirmation requires a replication connection/
		);
		const after = Records.primaryStore.getEntry('moved');
		assert.equal(after.version, before.version);
		assert.equal(after.residencySlot, 0);
		assert.equal(after.value.body, 'retained');
	});

	it('waits for the new owner, records both slots, and retains only an index stub', async () => {
		const Records = await declare(
			'SlotConfirmed',
			'@residency(slots: 10, byAttribute: true, slotFrom: "region")',
			'region: Int @indexed\nbody: String'
		);
		await Records.put('moved', { id: 'moved', region: 0, body: 'complete' });
		let acknowledge, observed, admitted;
		const requested = new Promise((resolve) => {
			observed = resolve;
		});
		setResidencyPlacementGuard((database, owners, connected) => {
			if (connected) {
				assert.deepEqual(owners, ['slot-owner']);
				admitted = true;
			}
		});
		replicationConfirmation((database, version, count, groups) => {
			assert.equal(database, 'slots_test');
			assert.equal(count, 1);
			assert.deepEqual(groups, [['slot-owner']]);
			assert.ok(version > 0);
			observed();
			return new Promise((resolve) => {
				acknowledge = resolve;
			});
		});
		let completed = false;
		const write = Promise.resolve(Records.patch('moved', { region: 1 })).then(() => {
			completed = true;
		});
		try {
			await Promise.race([
				requested,
				write.then(() => {
					throw new Error('Write returned before requesting confirmation');
				}),
			]);
			assert.equal(admitted, true);
			assert.equal(completed, false);
			const entry = Records.primaryStore.getEntry('moved');
			assert.equal(entry.residencySlot, 1);
			assert.ok(entry.metadataFlags & INVALIDATED);
			assert.equal(entry.value.body, undefined);
			const rows = Array.from(Records.auditStore.getRange({ start: 1, log: 0 })).filter(
				(row) => row.tableId === Records.tableId && row.recordId === 'moved'
			);
			const moved = rows.find((row) => row.residencySlot === 1);
			assert.equal(moved.previousResidencySlot, 0);
			assert.equal(moved.type, 'put');
			assert.equal(moved.getValue(Records.primaryStore).body, 'complete');
		} finally {
			acknowledge?.();
		}
		await write;
	});

	it('preserves slot zero on an invalidation and a later delete', async () => {
		const Records = await declare(
			'SlotInvalidation',
			'@residency(slots: 10, byAttribute: true, slotFrom: "region")',
			'region: Int @indexed\nbody: String'
		);
		const context = {};
		await transaction(context, async () => {
			const resource = await Records.getResource('stub', context);
			resource._writeInvalidate('stub', { id: 'stub', region: 0 }, { residencySlot: 0 });
		});
		assert.equal(Records.primaryStore.getEntry('stub').residencySlot, 0);
		await Records.delete('stub');
		assert.equal(Records.primaryStore.getEntry('stub')?.value, undefined);
		const removed = Array.from(Records.auditStore.getRange({ start: 1, log: 0 })).find(
			(row) => row.tableId === Records.tableId && row.recordId === 'stub' && row.type === 'delete'
		);
		assert.equal(removed.residencySlot, 0);
		assert.equal(removed.previousResidencySlot, 0);
	});

	it('converts an existing by-id table with its custom map without changing any record', async () => {
		const Records = table({
			database: 'slot_conversion',
			table: 'Converted',
			schemaDefined: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'tag', indexed: true }, { name: 'body' }],
		});
		Records.setResidencyById((id) => (Number(id.slice(-1)) < 5 ? 0 : 1));
		for (let i = 0; i < 10; i++) await Records.put(`key${i}`, { id: `key${i}`, tag: 'kept', body: `body${i}` });
		const before = Array.from(Records.primaryStore.getRange({ start: true }), (entry) => ({
			id: entry.key,
			version: entry.version,
			bytes: Buffer.from(Records.primaryStore.getBinary(entry.key)),
		}));
		const policy = { slots: 10, slotFrom: 'Number(id.slice(-1))' };
		env.setProperty('replication_shards', undefined);
		try {
			await assert.rejects(
				prepareResidencyDeclaration('slot_conversion', 'Converted', policy),
				/replication.shards|custom map/
			);
			await initializeResidencySlots({
				database: 'slot_conversion',
				slots: 10,
				ranges: [
					{ start: 0, end: 5, shard: 0 },
					{ start: 5, end: 10, shard: 1 },
				],
			});
			const report = await compareResidencyPlacement(Records, policy, readResidencyMap('slot_conversion'));
			assert.equal(report.mismatches, 0);
			assert.equal(report.checked, before.length);
			assert.ok(report.checked > 0);
			const wrong = await compareResidencyPlacement(
				Records,
				{ slots: 10, slotFrom: '9 - Number(id.slice(-1))' },
				readResidencyMap('slot_conversion')
			);
			assert.equal(wrong.mismatches, wrong.checked);
			await loadGQLSchema(`type Converted @table(database: "slot_conversion")
				@residency(slots: 10, slotFrom: "Number(id.slice(-1))") { id: ID @primaryKey tag: String @indexed body: String }`);
			const converted = databases.slot_conversion.Converted;
			for (const old of before) {
				assert.deepEqual(Buffer.from(converted.primaryStore.getBinary(old.id)), old.bytes);
				assert.equal(converted.primaryStore.getEntry(old.id).version, old.version);
				assert.deepEqual(converted.getRecordResidency({ key: old.id }), [server.hostname]);
			}
			await converted.put('new2', { id: 'new2', tag: 'new', body: 'after conversion' });
			assert.equal(converted.primaryStore.getEntry('new2').residencySlot, undefined);
		} finally {
			env.setProperty('replication_shards', [1, 0]);
		}
	});

	it('refuses invalid slot results before a record is stored', async () => {
		const Records = await declare('SlotInvalidResult', '@residency(slots: 10, slotFrom: "NaN")');
		await assert.rejects(async () => Records.put('invalid', { id: 'invalid', body: 'discard' }), /slot/);
		assert.equal(Records.primaryStore.getEntry('invalid')?.value, undefined);
	});

	it('rejects attribute placement without an index', async () => {
		await assert.rejects(
			declare('SlotUnindexedAttributes', '@residency(slots: 10, byAttribute: true, slotFrom: "region")', 'region: Int'),
			/index/
		);
	});

	it('keeps the installed map after a shard-list addition and refuses an invalid local shard', async () => {
		const Records = databases.slots_test.SlotKeys;
		const before = readResidencyMap('slots_test');
		env.setProperty('replication_shards', [2, 1, 0]);
		try {
			await declare('SlotAddedShard', '@residency(slots: 10)');
			assert.equal(readResidencyMap('slots_test').digest, before.digest);
			env.setProperty('replication_shard', 3);
			await assert.rejects(
				async () => Records.put('invalid8', { id: 'invalid8', body: 'discard' }),
				/not in replication.shards/
			);
			assert.equal(Records.primaryStore.getEntry('invalid8')?.value, undefined);
		} finally {
			env.setProperty('replication_shards', [1, 0]);
			env.setProperty('replication_shard', 0);
		}
	});

	it('retains failed first declarations for status without requiring lists on legacy tables', async () => {
		env.setProperty('replication_shards', undefined);
		try {
			await assert.rejects(
				prepareResidencyDeclaration('unconfigured_slots', 'Missing', { slots: 10 }),
				/replication.shards/
			);
			assert.ok(residencyDeclarationDatabases().includes('unconfigured_slots'));
			const Legacy = table({
				database: 'legacy_no_slots',
				table: 'Legacy',
				attributes: [{ name: 'id', isPrimaryKey: true }],
			});
			await Legacy.put('ok', { id: 'ok' });
		} finally {
			env.setProperty('replication_shards', [1, 0]);
		}
	});

	it('refuses policy changes and removal, and reloads the policy from the catalog', async () => {
		await assert.rejects(declare('SlotKeys', ''), /immutable|removed/);
		await assert.rejects(declare('SlotKeys', '@residency(slots: 9)'), /changed|immutable/);
		await declare('SlotKeys', '@residency(slots: 10, slotFrom: "Number(id.slice(-1))")');
		const { resetDatabases } = require('#src/resources/databases');
		resetDatabases();
		const Records = databases.slots_test.SlotKeys;
		assert.equal(Records.getResidencySlot('key8'), 8);
		assert.throws(() => Records.setResidencyById(() => 0), /@residency/);
	});

	it('installs identical snapshots once and refuses a competing same-version snapshot before LWW', async () => {
		const snapshot = createResidencyMap('concurrent_slots', 10, [{ start: 0, end: 10, shard: 0 }]);
		await Promise.all([installResidencyMap(snapshot), installResidencyMap(snapshot)]);
		const Maps = getResidencyMapTable();
		const installedVersion = Maps.primaryStore.getEntry('concurrent_slots').version;
		await Maps.put('concurrent_slots', snapshot);
		assert.equal(Maps.primaryStore.getEntry('concurrent_slots').version, installedVersion);
		const conflict = createResidencyMap('concurrent_slots', 10, [{ start: 0, end: 10, shard: 1 }]);
		await assert.rejects(async () => Maps.put('concurrent_slots', conflict), /Conflicting residency map version/);
		assert.equal(readResidencyMap('concurrent_slots').digest, snapshot.digest);
		await assert.rejects(async () => Maps.delete('concurrent_slots'), /cannot be deleted/);
		await assert.rejects(async () => Maps.clear(), /cannot be cleared/);
		await assert.rejects(async () => Maps.dropTable(), /cannot be cleared or dropped/);
	});

	it('refuses active reassignment but extends coverage without changing existing assignments', async () => {
		const before = readResidencyMap('slots_test');
		await assert.rejects(
			initializeResidencySlots({ database: 'slots_test', slots: 10, ranges: [{ start: 0, end: 10, shard: 0 }] }),
			/cannot be reassigned/
		);
		const extended = await initializeResidencySlots({
			database: 'slots_test',
			slots: 12,
			ranges: [...before.ranges, { start: 10, end: 12, shard: 1 }],
		});
		assert.equal(extended.version, before.version + 1);
		assert.equal(extended.slots, 12);
		assert.deepEqual(extended.ranges.slice(0, -1), before.ranges.slice(0, -1));
	});

	it('round-trips slot 65535 and preserves it through local invalidation and deletion', async () => {
		await initializeResidencySlots({
			database: 'max_slot',
			slots: 65536,
			ranges: [{ start: 0, end: 65536, shard: 0 }],
		});
		await loadGQLSchema(`type MaxSlot @table(database: "max_slot") @residency(slots: 65536, byAttribute: true, slotFrom: "region") {
			id: ID @primaryKey region: Int @indexed body: String }`);
		const Records = databases.max_slot.MaxSlot;
		await Records.put('max', { id: 'max', region: 65535, body: 'body' });
		assert.equal(Records.primaryStore.getEntry('max').residencySlot, 65535);
		const context = {};
		await transaction(context, async () => (await Records.getResource('max', context)).invalidate('max'));
		const entry = Records.primaryStore.getEntry('max');
		assert.equal(entry.residencySlot, 65535);
		assert.equal(entry.value.region, 65535);
		await Records.delete('max');
		const audit = Array.from(Records.auditStore.getRange({ start: 1, log: 0 })).filter(
			(row) => row.tableId === Records.tableId
		);
		assert.ok(audit.length >= 3);
		for (const row of audit) assert.equal(row.residencySlot, 65535);
	});

	for (const slots of ['0', '65537', '1.5']) {
		it(`rejects slot count ${slots}`, async () => {
			await assert.rejects(declare('SlotInvalidCount', `@residency(slots: ${slots})`), /slots/);
		});
	}
});
