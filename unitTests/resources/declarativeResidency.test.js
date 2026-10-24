require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
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
	residencyIsLocal,
} = require('#src/resources/residencyMaps');
const { createResidencyMap } = require('#src/resources/residencyPolicy');
const { compareResidencyPlacement } = require('#src/resources/residencyConversion');
const { replicationConfirmation } = require('#src/resources/DatabaseTransaction');
const { transaction } = require('#src/resources/transaction');

describe('Declarative residency', function () {
	this.timeout(20_000);
	let oldShards, oldConfiguredShards, oldShard;
	before(() => {
		setupTestDBPath();
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
	for (const auditMode of ['explicit', 'default', 'disable'])
		it(`refuses declarative placement without an audit log (${auditMode})`, async () => {
			const prior = env.get('logging_auditLog');
			const name = `SlotNoAudit${auditMode}`;
			try {
				if (auditMode === 'disable') await declare(name, '@residency(slots: 10)');
				if (auditMode === 'default') env.setProperty('logging_auditLog', false);
				await assert.rejects(
					loadGQLSchema(`type ${name} @table(database: "slots_test"${auditMode === 'default' ? '' : ', audit: false'})
						@residency(slots: 10) { id: ID @primaryKey }`),
					/audit logging/
				);
			} finally {
				env.setProperty('logging_auditLog', prior);
			}
		});

	it('refuses to omit declarative records from a non-replicating table', async () => {
		await assert.rejects(
			loadGQLSchema(`type SlotNoReplication @table(database: "slots_test", replicate: false)
			@residency(slots: 10) { id: ID @primaryKey }`),
			/replication/
		);
	});

	it('refuses a nonnumeric local shard even with a custom map and no shard list', async () => {
		const list = env.get('replication_shards'),
			shard = env.get('replication_shard');
		try {
			env.setProperty('replication_shards', undefined);
			env.setProperty('replication_shard', '0');
			assert.throws(() => residencyIsLocal('slots_test', 0, 10), /replication.shard/);
		} finally {
			env.setProperty('replication_shards', list);
			env.setProperty('replication_shard', shard);
		}
	});

	for (const context of [{ onlyIfCached: true }, { replicateFrom: false }])
		it(`refuses a cold attribute patch without source access ${JSON.stringify(context)}`, async () => {
			const Records = await declare(
				`SlotCachedOnly_${context.onlyIfCached ? 'cached' : 'source_disabled'}`,
				'@residency(slots: 10, byAttribute: true, slotFrom: "region")',
				'region: Int @indexed\nbody: String'
			);
			await Records.put('remote', { id: 'remote', region: 1, body: 'complete' });
			Records.sourcedFrom(
				{ load: () => assert.fail('disabled source access must not fetch') },
				{ intermediateSource: true }
			);
			await assert.rejects(
				async () => Records.patch('remote', { body: 'changed' }, context),
				/complete resident record/
			);
		});

	it('refuses a conversion comparison after its table is dropped during a yield', async () => {
		const database = 'slot_conversion_dropped';
		const map = await initializeResidencySlots({ database, slots: 1, ranges: [{ start: 0, end: 1, shard: 0 }] });
		const Records = table({ database, table: 'Rows', audit: true, attributes: [{ name: 'id', isPrimaryKey: true }] });
		Records.setResidencyById(() => 0);
		await transaction({}, async () => {
			for (let id = 0; id < 300; id++) await Records.put(id, { id });
		});
		const comparison = compareResidencyPlacement(Records, { slots: 1 }, map);
		const dropped = Records.dropTable();
		await assert.rejects(comparison, /dropped|unloaded|changed|closed/);
		await dropped;
	});

	it('does not activate a table while a staged map reassignment can still commit', async function () {
		if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') this.skip();
		const database = 'slot_activation_race';
		await initializeResidencySlots({ database, slots: 2, ranges: [{ start: 0, end: 2, shard: 0 }] });
		const Maps = getResidencyMapTable();
		let release, staged;
		const gate = new Promise((resolve) => {
			release = resolve;
		});
		const ready = new Promise((resolve) => {
			staged = resolve;
		});
		const update = transaction({}, async () => {
			await Maps.put(database, createResidencyMap(database, 2, [{ start: 0, end: 2, shard: 1 }], 2));
			staged();
			await gate;
		});
		try {
			await ready;
			assert.throws(
				() =>
					table({
						database,
						table: 'Rows',
						schemaDefined: true,
						audit: true,
						residency: { slots: 2 },
						attributes: [{ name: 'id', isPrimaryKey: true }],
					}),
				/residency.*(?:busy|progress)|(?:busy|progress).*residency/i
			);
		} finally {
			release();
			await update;
		}
		const Rows = table({
			database,
			table: 'Rows',
			schemaDefined: true,
			audit: true,
			residency: { slots: 2 },
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		assert.equal(Rows.residency.slots, 2);
		await assert.rejects(
			initializeResidencySlots({ database, slots: 2, ranges: [{ start: 0, end: 2, shard: 0 }] }),
			/cannot be reassigned/
		);
	});

	it('releases the activation fence after a failed declaration or aborted map batch', async () => {
		const database = 'slot_activation_abort';
		await initializeResidencySlots({ database, slots: 2, ranges: [{ start: 0, end: 2, shard: 0 }] });
		const definition = {
			database,
			table: 'Rows',
			schemaDefined: true,
			audit: true,
			residency: { slots: 2 },
			attributes: [{ name: 'id', isPrimaryKey: true }],
		};
		assert.throws(() => table({ ...definition, audit: false }), /requires audit logging/);
		const Maps = getResidencyMapTable();
		await assert.rejects(
			transaction({}, async () => {
				await Maps.put(database, createResidencyMap(database, 2, [{ start: 0, end: 2, shard: 1 }], 2));
				throw new Error('abort activation fixture');
			}),
			/abort activation fixture/
		);
		assert.equal(readResidencyMap(database).version, 1);
		await transaction({}, async () => {
			await Maps.put(database, createResidencyMap(database, 2, [{ start: 0, end: 2, shard: 1 }], 2));
			await Maps.put(database, createResidencyMap(database, 2, [{ start: 0, end: 2, shard: 0 }], 3));
		});
		assert.equal(readResidencyMap(database).version, 3);
		assert.equal(table(definition).residency.slots, 2);
	});

	it('checks active slots when another thread created the database after its scan', async () => {
		const { Worker } = require('node:worker_threads');
		const worker = new Worker(
			`
			const { parentPort, workerData } = require('node:worker_threads');
			require(workerData.testUtils).setupTestDBPath();
			const { getDatabases } = require('#src/resources/databases');
			const { activeResidencySlots, validateResidencyMapWrite } = require('#src/resources/residencyMaps');
			getDatabases();
			const { onMessageByType } = require('#js/server/threads/manageThreads');
			onMessageByType('slot-catalog-check', () => {});
			parentPort.postMessage({ type: 'slot-catalog-ready' });
			parentPort.on('message', ({ type, previous, next }) => {
				if (type !== 'slot-catalog-check') return;
				let refused = false;
				try { validateResidencyMapWrite(previous.database, next, previous); } catch { refused = true; }
				parentPort.postMessage({ type: 'slot-catalog-result', slots: activeResidencySlots(previous.database), refused });
			});
			parentPort.ref();
		`,
			{
				eval: true,
				workerData: {
					testUtils: require.resolve('../testUtils'),
					noServerStart: true,
					addPorts: [],
					workerIndex: 9,
					workerCount: 10,
				},
			}
		);
		const waitForMessage = (type) =>
			new Promise((resolve, reject) => {
				const timer = setTimeout(() => finish(new Error(`Worker did not send ${type}`)), 5000);
				const exited = (code) => finish(new Error(`Catalog worker exited before ${type}: ${code}`));
				function finish(error, message) {
					clearTimeout(timer);
					worker.off('message', listener);
					worker.off('error', finish);
					worker.off('exit', exited);
					if (error) reject(error);
					else resolve(message);
				}
				const listener = (message) => {
					if (message.type !== type) return;
					finish(null, message);
				};
				worker.on('message', listener);
				worker.once('error', finish);
				worker.once('exit', exited);
			});
		try {
			await waitForMessage('slot-catalog-ready');
			const database = 'slot_late_database';
			const previous = await initializeResidencySlots({ database, slots: 2, ranges: [{ start: 0, end: 2, shard: 0 }] });
			await loadGQLSchema(`type LateTable @table(database: "${database}") @residency(slots: 2) { id: ID @primaryKey }`);
			const answer = waitForMessage('slot-catalog-result');
			worker.postMessage({
				type: 'slot-catalog-check',
				previous,
				next: createResidencyMap(database, 2, [{ start: 0, end: 2, shard: 1 }], 2),
			});
			const result = await answer;
			assert.equal(result.slots, 2, 'a cold thread must inspect the durable catalog: ' + JSON.stringify(result));
			assert.equal(result.refused, true, 'active assignments cannot be changed from a cold thread');
		} finally {
			await worker.terminate();
		}
	});

	for (const overrides of [{}, { audit: false }, { replicate: false }])
		it(`preserves a cold table policy during programmatic redeclaration ${JSON.stringify(overrides)}`, async () => {
			const { Worker } = require('node:worker_threads');
			const worker = new Worker(
				`
			const { parentPort, workerData } = require('node:worker_threads');
			require(workerData.testUtils).setupTestDBPath();
			const { getDatabases, table } = require('#src/resources/databases');
			getDatabases();
			const { onMessageByType } = require('#js/server/threads/manageThreads');
			onMessageByType('slot-redeclare-check', () => {});
			parentPort.postMessage({ type: 'slot-redeclare-ready' });
			parentPort.on('message', ({ type, database, overrides }) => {
				if (type !== 'slot-redeclare-check') return;
				let policy, error;
				try {
					policy = table({ database, table: 'LateTable', ...overrides,
						attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'extra', indexed: true }] }).residency;
				} catch (failure) { error = failure.message; }
				parentPort.postMessage({ type: 'slot-redeclare-result', policy, error });
			});
			parentPort.ref();
		`,
				{
					eval: true,
					workerData: {
						testUtils: require.resolve('../testUtils'),
						noServerStart: true,
						addPorts: [],
						workerIndex: 9,
						workerCount: 10,
					},
				}
			);
			const waitForMessage = (type) =>
				new Promise((resolve, reject) => {
					const timer = setTimeout(() => finish(new Error(`Worker did not send ${type}`)), 5000);
					const exited = (code) => finish(new Error(`Catalog worker exited before ${type}: ${code}`));
					function finish(error, message) {
						clearTimeout(timer);
						worker.off('message', listener);
						worker.off('error', finish);
						worker.off('exit', exited);
						if (error) reject(error);
						else resolve(message);
					}
					const listener = (message) => {
						if (message.type !== type) return;
						finish(null, message);
					};
					worker.on('message', listener);
					worker.once('error', finish);
					worker.once('exit', exited);
				});
			try {
				await waitForMessage('slot-redeclare-ready');
				const database = `slot_cold_redeclare_${overrides.audit === false ? 'audit' : overrides.replicate === false ? 'replicate' : 'inherit'}`;
				await initializeResidencySlots({ database, slots: 2, ranges: [{ start: 0, end: 2, shard: 0 }] });
				await loadGQLSchema(
					`type LateTable @table(database: "${database}") @residency(slots: 2) { id: ID @primaryKey }`
				);
				const answer = waitForMessage('slot-redeclare-result');
				worker.postMessage({ type: 'slot-redeclare-check', database, overrides });
				const result = await answer;
				if (Object.keys(overrides).length)
					assert.match(result.error ?? '', /requires audit logging|requires table replication/);
				else assert.deepEqual(result.policy, { slots: 2, byAttribute: false });
				assert.equal(databases[database].LateTable.dbisDB.getSync('LateTable/').residency?.slots, 2);
			} finally {
				await worker.terminate();
			}
		});

	it('confirms an index-free non-owner write using its audit entry', async () => {
		const Records = await declare('SlotNoIndexConfirmed', '@residency(slots: 10, slotFrom: "1")', 'body: String');
		const calls = [];
		replicationConfirmation((_database, position, count, owners) => {
			calls.push({ position, count, owners });
			return Promise.resolve();
		});
		await transaction({ replicatedConfirmation: 1 }, () => Records.put('remote', { id: 'remote', body: 'complete' }));
		assert.equal(Records.primaryStore.getEntry('remote')?.value, undefined);
		assert.equal(calls.length, 1, 'omitting the local primary row must not skip explicit confirmation');
		assert.deepEqual(calls[0].owners, [['slot-owner']]);
		assert.equal(calls[0].count, 1);
		const entry = [...Records.auditStore.getRange({ start: 1, log: 0 })].find(
			(entry) => entry.tableId === Records.tableId && entry.recordId === 'remote'
		);
		assert.equal(calls[0].position, entry.txnLogKey ?? entry.key);
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

	for (const byAttribute of [false, true])
		it(`returns absent records with a replication source (byAttribute=${byAttribute})`, async () => {
			const Records = await declare(
				`SlotMissing${byAttribute}`,
				`@residency(slots: 10, slotFrom: "0", byAttribute: ${byAttribute})`
			);
			Records.sourcedFrom(
				{ load: () => assert.fail('An absent local row is not an invalidation') },
				{ intermediateSource: true }
			);
			assert.equal(await Records.get('absent'), undefined);
			await Records.put('present', { id: 'present', tag: 'indexed', body: 'complete' });
			assert.equal((await Records.get('present')).body, 'complete');
		});

	for (const region of [0, 1])
		it(`publishes an event without changing attribute placement (slot=${region})`, async () => {
			const Records = await declare(
				`SlotPublished${region}`,
				'@residency(slots: 10, slotFrom: "region", byAttribute: true)',
				'region: Int @indexed\nbody: String'
			);
			await Records.put('published', { id: 'published', region, body: 'complete' });
			const before = Records.primaryStore.getEntry('published');
			await Records.publish('published', { event: 'notice' });
			const after = Records.primaryStore.getEntry('published');
			assert.equal(after.residencySlot, region);
			assert.equal(after.metadataFlags & INVALIDATED, before.metadataFlags & INVALIDATED);
			assert.deepEqual({ ...after.value }, { ...before.value });
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

	it('confirms attribute changes at their durable local audit position', async () => {
		const Records = await declare(
			'SlotAckPosition',
			'@residency(slots: 10, byAttribute: true, slotFrom: "region")',
			'region: Int @indexed'
		);
		await Records.put('moved', { id: 'moved', region: 0, body: 'complete' });
		setResidencyPlacementGuard(() => {});
		let confirmed;
		replicationConfirmation((_database, position) => {
			confirmed = position;
			return Promise.resolve();
		});
		await transaction({}, () => Records.patch('moved', { region: 1 }));
		const entry = Records.primaryStore.getEntry('moved');
		const position = process.env.HARPER_STORAGE_ENGINE === 'lmdb' ? entry.localTime : entry.version;
		assert.equal(confirmed, position, 'confirmation must include the committed audit entry');
	});
	it('confirms the original LMDB commit when another write replaces its primary row', async function () {
		if (process.env.HARPER_STORAGE_ENGINE !== 'lmdb') return this.skip();
		const Records = await declare(
			'SlotAckReplaced',
			'@residency(slots: 10, byAttribute: true, slotFrom: "region")',
			'region: Int @indexed'
		);
		await Records.put('moved', { id: 'moved', region: 0, body: 'original' });
		setResidencyPlacementGuard(() => {});
		let confirmed;
		let originalPosition;
		replicationConfirmation((_database, position) => {
			confirmed = position;
			return Promise.resolve();
		});
		const store = Records.primaryStore;
		const original = store.childTransaction;
		let first = true;
		store.childTransaction = function (...args) {
			return original.apply(this, args).then(async (committed) => {
				if (first) {
					first = false;
					originalPosition = store.getEntry('moved').localTime;
					await transaction({}, () => Records.put('moved', { id: 'moved', region: 1, body: 'later' }));
				}
				return committed;
			});
		};
		try {
			await Records.patch('moved', { region: 1 });
			assert.notEqual(store.getEntry('moved').localTime, originalPosition);
			assert.equal(confirmed, originalPosition);
		} finally {
			store.childTransaction = original;
		}
	});
	it('confirms an attribute transition followed by deletion in the same batch', async () => {
		const Records = await declare(
			'SlotAckThenDelete',
			'@residency(slots: 10, byAttribute: true, slotFrom: "region")',
			'region: Int @indexed'
		);
		await Records.put('moved', { id: 'moved', region: 0 });
		setResidencyPlacementGuard(() => {});
		const confirmations = [];
		replicationConfirmation((_database, position, count, owners) => {
			confirmations.push({ position, count, owners });
			return Promise.resolve();
		});
		await transaction({}, async () => {
			await Records.patch('moved', { region: 1 });
			await Records.delete('moved');
		});
		assert.equal(Records.primaryStore.getEntry('moved')?.value, undefined);
		assert.equal(confirmations.length, 1, 'deleting the primary row must not erase the confirmation target');
		assert.deepEqual(confirmations[0].owners, [['slot-owner']]);
		const entries = [...Records.auditStore.getRange({ start: 1, log: 0 })].filter(
			(entry) => entry.tableId === Records.tableId && entry.recordId === 'moved'
		);
		const last = entries.at(-1);
		assert.equal(confirmations[0].position, last.txnLogKey ?? last.key);
	});

	it('keeps mandatory owner confirmation through a native RocksDB TryAgain retry', async function () {
		if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return this.skip();
		const Records = await declare(
			'SlotRetryConfirmation',
			'@residency(slots: 10, byAttribute: true, slotFrom: "region")',
			'region: Int @indexed'
		);
		await Records.put('moved', { id: 'moved', region: 0 });
		const binding = Object.values(require.cache).find(
			(module) => module.filename?.endsWith('.node') && typeof module.exports.forceTryAgainForTesting === 'function'
		)?.exports;
		assert.ok(binding, 'the native engine exposes its commit-failure seam');
		const { Transaction } = require('@harperfast/rocksdb-js');
		const original = Transaction.prototype.commit;
		const attempts = [];
		Transaction.prototype.commit = function (...args) {
			if (this.store?.db === Records.primaryStore.store.db) attempts.push(this.id);
			return original.apply(this, args);
		};
		setResidencyPlacementGuard(() => {});
		const confirmations = [];
		replicationConfirmation((_database, version, count, owners) => {
			confirmations.push({ version, count, owners });
			return Promise.resolve();
		});
		try {
			await transaction({}, async () => {
				await Records.patch('moved', { region: 1 });
				binding.forceTryAgainForTesting(1);
			});
			assert.ok(attempts.length >= 2, 'native TryAgain forces a retry');
			assert.equal(new Set(attempts).size, 1, 'retry retains the native handle that owns the durable log');
			assert.equal(confirmations.length, 1);
			assert.equal(confirmations[0].count, 1);
			assert.deepEqual(confirmations[0].owners, [['slot-owner']]);
			assert.equal(confirmations[0].version, Records.primaryStore.getEntry('moved').version);
		} finally {
			binding.forceTryAgainForTesting(0);
			Transaction.prototype.commit = original;
		}
	});

	it('rolls back every write when the new owner disconnects at the final admission check', async () => {
		const Records = await declare(
			'SlotLateRefusal',
			'@residency(slots: 10, byAttribute: true, slotFrom: "region")',
			'region: Int @indexed\nbody: String'
		);
		for (const id of ['local', 'moved']) await Records.put(id, { id, region: 0, body: 'original' });
		const before = ['local', 'moved'].map((id) => ({
			id,
			version: Records.primaryStore.getEntry(id).version,
			bytes: Buffer.from(Records.primaryStore.getBinary(id)),
		}));
		let admissions = 0;
		setResidencyPlacementGuard((_database, _owners, connected) => {
			if (connected && ++admissions === 2) throw new Error('new owner disconnected before submission');
		});
		replicationConfirmation(() => assert.fail('A refused commit must not request confirmation'));
		await assert.rejects(
			transaction({}, async () => {
				await Records.patch('local', { body: 'changed' });
				await Records.patch('moved', { region: 1 });
			}),
			/new owner disconnected before submission/
		);
		assert.equal(admissions, 2, 'the refusal occurs at the final check, after staging');
		await Records.primaryStore.committed;
		for (const old of before) {
			assert.equal(Records.primaryStore.getEntry(old.id).version, old.version);
			assert.deepEqual(Buffer.from(Records.primaryStore.getBinary(old.id)), old.bytes);
		}
	});

	for (const first of ['put', 'patch'])
		for (const returnLocal of [false, true])
			it(`retains the complete same-batch attribute write through a non-owner projection (${first}, return=${returnLocal})`, async () => {
				const Records = await declare(
					`SlotChained_${first}_${returnLocal}`,
					'@residency(slots: 10, byAttribute: true, slotFrom: "region")',
					'region: Int @indexed\nbody: String\nextra: String'
				);
				await Records.put('row', { id: 'row', region: 0, body: 'original', extra: 'retained' });
				setResidencyPlacementGuard(() => {});
				replicationConfirmation(() => Promise.resolve());
				await transaction({}, async () => {
					if (first === 'put') await Records.put('row', { id: 'row', region: 1, body: 'first', extra: 'retained' });
					else await Records.patch('row', { region: 1 });
					await Records.patch('row', { body: 'second' });
					if (returnLocal) await Records.patch('row', { region: 0 });
				});
				const entry = Records.primaryStore.getEntry('row');
				assert.equal(entry.residencySlot, returnLocal ? 0 : 1);
				assert.equal(Boolean(entry.metadataFlags & INVALIDATED), !returnLocal);
				if (returnLocal) {
					assert.equal(entry.value.body, 'second');
					assert.equal(entry.value.extra, 'retained');
				} else assert.equal(entry.value.body, undefined);
				const rows = Array.from(Records.auditStore.getRange({ start: 1, log: 0 })).filter(
					(row) => row.tableId === Records.tableId && row.recordId === 'row'
				);
				assert.ok(rows.some((row) => row.getValue(Records.primaryStore)?.body === 'second'));
			});

	it('requires mandatory confirmation only for transitioning records in a mixed transaction', async () => {
		const Records = await declare(
			'SlotMixedConfirmation',
			'@residency(slots: 10, byAttribute: true, slotFrom: "region")',
			'region: Int @indexed\nbody: String'
		);
		await Records.put('moved', { id: 'moved', region: 0, body: 'original' });
		await Records.put('local', { id: 'local', region: 0, body: 'original' });
		setResidencyPlacementGuard(() => {});
		let groups;
		replicationConfirmation((_database, _version, count, owners) => {
			assert.equal(count, 1);
			groups = owners;
			return Promise.resolve();
		});
		await transaction({}, async () => {
			await Records.patch('moved', { region: 1 });
			await Records.patch('local', { body: 'changed' });
		});
		assert.deepEqual(groups, [['slot-owner']]);
		assert.equal(Records.primaryStore.getEntry('local').value.body, 'changed');
		assert.equal(Records.primaryStore.getEntry('moved').residencySlot, 1);
	});

	it('keeps explicit confirmation requirements for every record in a mixed transaction', async () => {
		const Records = await declare(
			'SlotExplicitConfirmation',
			'@residency(slots: 10, byAttribute: true, slotFrom: "region")',
			'region: Int @indexed\nbody: String'
		);
		await Records.put('moved', { id: 'moved', region: 0, body: 'original' });
		await Records.put('local', { id: 'local', region: 0, body: 'original' });
		setResidencyPlacementGuard(() => {});
		await assert.rejects(
			transaction({ replicatedConfirmation: 1 }, async () => {
				await Records.patch('moved', { region: 1 });
				await Records.patch('local', { body: 'changed' });
			}),
			/0 other owners/
		);
		assert.equal(Records.primaryStore.getEntry('local').value.body, 'original');
		assert.equal(Records.primaryStore.getEntry('moved').residencySlot, 0);
	});

	it('does not carry mandatory owner confirmation into a later commit in the same scope', async () => {
		const Records = await declare(
			'SlotConfirmationReuse',
			'@residency(slots: 10, byAttribute: true, slotFrom: "region")',
			'region: Int @indexed\nbody: String'
		);
		await Records.put('moved', { id: 'moved', region: 0, body: 'original' });
		setResidencyPlacementGuard(() => {});
		let calls = 0;
		replicationConfirmation(() => {
			calls++;
			return Promise.resolve();
		});
		await transaction({}, async (txn) => {
			await Records.patch('moved', { region: 1 });
			await txn.commit();
			await Records.put('local', { id: 'local', region: 0, body: 'complete' });
		});
		assert.equal(calls, 1);
		assert.equal(Records.primaryStore.getEntry('local').value.body, 'complete');
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
			version: Records.primaryStore.getEntry(entry.key).version,
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
			await converted.put('new6', { id: 'new6', tag: 'new', body: 'remote body' });
			const stub = converted.primaryStore.getEntry('new6');
			const cachesReplicas = process.env.HARPER_STORAGE_ENGINE !== 'lmdb';
			assert.equal(
				await converted._storeReplica(stub, {
					...stub,
					originNode: server.hostname,
					value: { id: 'new6', tag: 'new', body: 'remote body' },
				}),
				cachesReplicas
			);
			let ownerLoads = 0;
			converted.sourcedFrom(
				{
					async load() {
						assert.ok(!cachesReplicas, 'The former by-id hook must not bypass an indexed replica');
						ownerLoads++;
						return {
							key: stub.key,
							version: stub.version,
							originNode: server.hostname,
							value: { id: 'new6', tag: 'new', body: 'remote body' },
						};
					},
				},
				{ intermediateSource: true }
			);
			assert.equal((await converted.get('new6')).body, 'remote body');
			assert.equal(ownerLoads, cachesReplicas ? 0 : 1);
			if (!cachesReplicas) {
				const retained = converted.primaryStore.getEntry('new6');
				assert.ok(retained.metadataFlags & INVALIDATED);
				assert.equal(retained.value.body, undefined);
			}
		} finally {
			env.setProperty('replication_shards', [1, 0]);
		}
	});

	it('refuses attribute-policy adoption because existing rows have no stored slots', async () => {
		const Legacy = table({
			database: 'slot_attribute_adoption',
			table: 'Legacy',
			schemaDefined: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'region', indexed: true }, { name: 'body' }],
		});
		await Legacy.put('existing', { id: 'existing', region: 0, body: 'retained' });
		await initializeResidencySlots({
			database: 'slot_attribute_adoption',
			slots: 2,
			ranges: [{ start: 0, end: 2, shard: 0 }],
		});
		await assert.rejects(
			loadGQLSchema(`type Legacy @table(database: "slot_attribute_adoption")
				@residency(slots: 2, byAttribute: true, slotFrom: "region") {
				id: ID @primaryKey region: Int @indexed body: String }`),
			/existing table.*attribute|attribute.*existing table/i
		);
		assert.equal(Legacy.residency, undefined);
		assert.equal(Legacy.dbisDB.getSync('Legacy/').residency, undefined);
		assert.equal(Legacy.primaryStore.getEntry('existing').value.body, 'retained');
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

	it('keeps a newer compatible map when a lagging peer repeats the old snapshot', async () => {
		const before = createResidencyMap('slot_extension_retry', 2, [{ start: 0, end: 2, shard: 0 }]);
		await installResidencyMap(before);
		const newer = createResidencyMap(
			'slot_extension_retry',
			4,
			[
				{ start: 0, end: 2, shard: 0 },
				{ start: 2, end: 4, shard: 1 },
			],
			2
		);
		await installResidencyMap(newer);
		const Maps = getResidencyMapTable();
		const version = Maps.primaryStore.getEntry(before.database).version;
		assert.deepEqual(await installResidencyMap(before), newer);
		await Maps.put(before.database, before);
		assert.equal(readResidencyMap(before.database).digest, newer.digest);
		assert.equal(Maps.primaryStore.getEntry(before.database).version, version);
		const conflict = createResidencyMap(before.database, 2, [{ start: 0, end: 2, shard: 1 }]);
		await assert.rejects(installResidencyMap(conflict), /incompatible|reassigned|newer/);
	});

	it('refuses an attribute delete until its placement is known', async () => {
		const Records = await declare(
			'SlotAbsentDelete',
			'@residency(slots: 10, byAttribute: true, slotFrom: "region")',
			'region: Int @indexed'
		);
		await assert.rejects(Records.delete('not-yet-received'), /slot|placement/);
		assert.equal(Records.primaryStore.getEntry('not-yet-received'), undefined);
	});

	it('preserves legacy indexed fields during an invalidation without residency', async () => {
		const Legacy = table({
			database: 'legacy_projection',
			table: 'Rows',
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'tag', indexed: true }, { name: 'body' }],
		});
		await Legacy.put('row', { id: 'row', tag: 'kept', body: 'old' });
		const context = {};
		await transaction(context, async () => {
			const row = await Legacy.getResource('row', context, { ensureLoaded: false });
			row._writeInvalidate('row', {}, { nodeId: 0 });
		});
		assert.equal(Legacy.primaryStore.getEntry('row').value.tag, 'kept');
	});

	it('selects legacy count placement on a cache fill with no previous residency', async () => {
		const Legacy = table({
			database: 'legacy_count_fill',
			table: 'Rows',
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'tag', indexed: true }, { name: 'body' }],
		});
		await Legacy.put('row', { id: 'row', tag: 'kept', body: 'old' });
		const version = Legacy.primaryStore.getEntry('row').version;
		const context = {};
		await transaction(context, async () => {
			const row = await Legacy.getResource('row', context, { ensureLoaded: false });
			row._writeInvalidate('row', null);
		});
		Legacy.sourcedFrom({
			async get(_id, context) {
				context.lastModified = version + 1000;
				return { id: 'row', tag: 'kept', body: 'fresh' };
			},
		});
		const oldNodes = server.nodes;
		server.nodes = [{ name: 'legacy-fill-peer' }];
		try {
			const row = await Legacy.getResource('row', { replicateTo: 1 }, { ensureLoaded: true });
			assert.equal(row.getRecord().body, 'fresh');
			let stored;
			const deadline = Date.now() + 5000;
			do {
				stored = Legacy.primaryStore.getEntry('row');
				if (stored?.value.body === 'fresh' && stored.residencyId) break;
				await new Promise((resolve) => setTimeout(resolve, 10));
			} while (Date.now() < deadline);
			assert.equal(stored?.value.body, 'fresh', 'the source fill commits before placement is inspected');
			assert.ok(stored.residencyId, 'the committed legacy fill has count-based residency');
			assert.deepEqual(
				[...Legacy.getResidencyRecord(stored.residencyId)].sort(),
				[server.hostname, 'legacy-fill-peer'].sort()
			);
		} finally {
			server.nodes = oldNodes;
		}
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

	(process.env.HARPER_STORAGE_ENGINE === 'lmdb' ? it.skip : it)(
		'refuses branching a database with declarative ownership',
		async () => {
			const { getOrCreateBranch, removeBranches } = require('#src/resources/branchDatabase');
			try {
				await assert.rejects(getOrCreateBranch('slots_test', 'slotBranch'), /declarative residency.*branches/);
			} finally {
				await removeBranches();
			}
		}
	);

	for (const mode of ['write', 'write-unflushed-map', 'write-scan-error', 'write-system-first'])
		(process.env.HARPER_STORAGE_ENGINE === 'lmdb' ? it.skip : it)(
			`replays attribute slots before peer discovery after an unclean exit (${mode})`,
			async function () {
				this.timeout(90_000);
				const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
				const { join } = require('node:path');
				const { tmpdir } = require('node:os');
				const { spawn } = require('node:child_process');
				const root = mkdtempSync(join(tmpdir(), 'residency-replay-'));
				const marker = join(root, 'result');
				async function run(mode) {
					const child = spawn(
						process.execPath,
						[join(__dirname, 'declarativeResidency-crash.js'), root, marker, mode],
						{
							stdio: ['ignore', 'ignore', 'pipe'],
						}
					);
					let stderr = '';
					child.stderr.on('data', (chunk) => (stderr += chunk));
					const timer = setTimeout(() => child.kill('SIGTERM'), 40_000);
					try {
						return await new Promise((resolve, reject) => {
							child.once('error', reject);
							child.once('exit', (code, signal) => resolve({ code, signal, stderr }));
						});
					} finally {
						clearTimeout(timer);
					}
				}
				try {
					const written = await run(mode);
					assert.equal(written.signal, 'SIGKILL', written.stderr);
					assert.equal(readFileSync(marker, 'utf8'), 'written');
					const replay = await run(
						mode === 'write-scan-error'
							? 'replay-scan-error'
							: mode === 'write-system-first'
								? 'replay-system-first'
								: 'replay'
					);
					assert.equal(replay.code, 0, replay.stderr);
					const result = JSON.parse(readFileSync(marker, 'utf8'));
					assert.ok(result.replayed >= 4, JSON.stringify(result));
					assert.deepEqual(result.rows.local, { slot: 0, body: 'complete', region: 0 }, replay.stderr);
					assert.deepEqual(result.rows.remote, { slot: 1, region: 1 });
					assert.equal(result.rows.deleted.body, undefined);
				} finally {
					rmSync(root, { recursive: true, force: true });
				}
			}
		);

	for (const slots of ['0', '65537', '1.5']) {
		it(`rejects slot count ${slots}`, async () => {
			await assert.rejects(declare('SlotInvalidCount', `@residency(slots: ${slots})`), /slots/);
		});
	}
});
