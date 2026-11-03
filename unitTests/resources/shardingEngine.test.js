require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { loadGQLSchema } = require('#src/resources/graphql');
const { databases, table } = require('#src/resources/databases');
const { initializeResidencySlots, readResidencyMap } = require('#src/resources/residencyMaps');
const { server } = require('#src/server/Server');
const env = require('#src/utility/environment/environmentManager');

(process.env.HARPER_STORAGE_ENGINE === 'lmdb' ? describe : describe.skip)(
	'Declarative sharding refuses LMDB',
	function () {
		let previousList, previousShard, previousNodes;
		before(() => {
			setupTestDBPath();
			previousList = env.get('replication_shards');
			previousShard = env.get('replication_shard');
			previousNodes = server.shards;
			env.setProperty('replication_shards', [0]);
			env.setProperty('replication_shard', 0);
			server.shards = new Map([[0, [{ name: server.hostname }]]]);
		});
		after(() => {
			env.setProperty('replication_shards', previousList);
			env.setProperty('replication_shard', previousShard);
			server.shards = previousNodes;
		});

		it('refuses map initialization without storing a map', async () => {
			const database = 'lmdb_map_refusal';
			await assert.rejects(
				initializeResidencySlots({ database, slots: 2, ranges: [{ start: 0, end: 2, shard: 0 }] }),
				/requires RocksDB/
			);
			assert.equal(readResidencyMap(database), undefined);
		});

		for (const healthyFirst of [false, true])
			it(`isolates schema refusal to its database (healthy first=${healthyFirst})`, async () => {
				const database = `lmdb_schema_refusal_${healthyFirst}`;
				const healthy = `${database}_healthy`;
				const declarations = [
					`type Unsupported @table(database: "${database}") @sharded { id: ID @primaryKey }`,
					`type Healthy @table(database: "${healthy}") { id: ID @primaryKey body: String }`,
				];
				if (healthyFirst) declarations.reverse();
				declarations.push(`type PlainSibling @table(database: "${database}") { id: ID @primaryKey body: String }`);
				await loadGQLSchema(declarations.join('\n'));
				assert.equal(databases[database]?.Unsupported?.residency, undefined);
				assert.equal(readResidencyMap(database), undefined);
				await databases[healthy].Healthy.put('good', { id: 'good', body: 'available' });
				assert.equal((await databases[healthy].Healthy.get('good')).body, 'available');
				await assert.rejects(
					async () => databases[database].PlainSibling.put('held', { id: 'held' }),
					/requires RocksDB/
				);
				assert.equal(databases[database].PlainSibling.primaryStore.getEntry('held'), undefined);
			});

		it('checks the existing database engine even after the default changes to RocksDB', async () => {
			const database = 'lmdb_existing_refusal';
			const Existing = table({ database, table: 'Existing', attributes: [{ name: 'id', isPrimaryKey: true }] });
			assert.notEqual(Existing.primaryStore.encoder.isRocksDB, true);
			const prior = process.env.HARPER_STORAGE_ENGINE;
			try {
				process.env.HARPER_STORAGE_ENGINE = 'rocksdb';
				await assert.rejects(
					initializeResidencySlots({ database, slots: 2, ranges: [{ start: 0, end: 2, shard: 0 }] }),
					/requires RocksDB/
				);
				assert.equal(readResidencyMap(database), undefined);
			} finally {
				process.env.HARPER_STORAGE_ENGINE = prior;
			}
		});

		it('preserves legacy per-record and by-id residency on LMDB', async () => {
			const Legacy = table({
				database: 'lmdb_legacy_residency',
				table: 'Rows',
				audit: true,
				attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'body' }],
			});
			Legacy.setResidency(() => [server.hostname]);
			await Legacy.put('listed', { id: 'listed', body: 'legacy list' });
			assert.equal((await Legacy.get('listed')).body, 'legacy list');
			Legacy.setResidencyById(() => 0);
			await Legacy.put('by-id', { id: 'by-id', body: 'legacy shard' });
			assert.equal((await Legacy.get('by-id')).body, 'legacy shard');
		});
	}
);
