require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { initializeResidencySlots, readResidencyMap } = require('#src/resources/residencyMaps');
const env = require('#src/utility/environment/environmentManager');

(process.env.HARPER_STORAGE_ENGINE === 'lmdb' ? describe.skip : describe)(
	'Existing-owner sharding assertion',
	function () {
		let Rows, snapshot, priorShard;
		const database = 'shardingAssertion';
		const receiptKey = [Symbol.for('sharding-existing-owner'), database];
		before(async () => {
			setupTestDBPath();
			priorShard = env.get('replication_shard');
			env.setProperty('replication_shard', 0);
			Rows = table({ database, table: 'Rows', audit: true, attributes: [{ name: 'id', isPrimaryKey: true }] });
			await Rows.put('legacy', { id: 'legacy' });
			snapshot = await initializeResidencySlots({ database, slots: 2, ranges: [{ start: 0, end: 2, shard: 0 }] });
		});
		after(() => env.setProperty('replication_shard', priorShard));
		it('refuses malformed assertions and mismatched digests before writing a receipt or map', async () => {
			for (const fields of [
				{ existing_owner: 'false', expected_digest: snapshot.digest },
				{ existing_owner: false, expected_digest: snapshot.digest },
				{ existing_owner: true, expected_digest: 123 },
				{ existing_owner: true, expected_digest: 'different' },
				{ existing_owner: true, expected_digest: snapshot.digest, slots: 2, ranges: snapshot.ranges },
			]) {
				await assert.rejects(
					initializeResidencySlots({ database, ...fields }),
					(error) => error.statusCode >= 400 && error.statusCode < 500
				);
				assert.equal(Rows.dbisDB.getSync(receiptKey), undefined);
				assert.equal(readResidencyMap(database).digest, snapshot.digest);
			}
		});
		it('records an idempotent local assertion without declaring a table', async () => {
			const request = { database, existing_owner: true, expected_digest: snapshot.digest };
			await initializeResidencySlots(request);
			const receipt = Rows.dbisDB.getSync(receiptKey);
			assert.equal(receipt.digest, snapshot.digest);
			assert.equal(receipt.shard, 0);
			assert.equal(receipt.roots.length, 1);
			assert.equal(receipt.roots[0].generation, Rows.auditStore.databaseGeneration.id);
			assert.ok(receipt.roots[0].tables.some((entry) => entry.name === 'Rows'));
			assert.equal(Rows.residency, undefined);
			assert.equal(Rows.primaryStore.getSync('legacy').id, 'legacy');
			await initializeResidencySlots(request);
			assert.deepEqual(Rows.dbisDB.getSync(receiptKey), receipt);
		});
		it('converts an existing unsharded table without rewriting rows and withholds completeness until asserted', async () => {
			const { hasExistingOwnerAssertion, shardingConvertedTables } = require('#src/resources/shardingCompleteness');
			const attributes = [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'tag', indexed: true },
			];
			const Plain = table({ database, table: 'Plain', audit: true, attributes });
			await Plain.put('present', { id: 'present', tag: 'kept' });
			const before = Plain.primaryStore.getEntry('present');
			const version = before.version;
			const localTime = before.localTime;
			table({ database, table: 'Plain', audit: true, residency: { slots: 2 }, attributes });
			assert.equal(Plain.residency.slots, 2);
			assert.equal(Plain.primaryStore.getEntry('present').version, version);
			assert.equal(Plain.primaryStore.getEntry('present').localTime, localTime);
			assert.equal(Plain.primaryStore.getSync('present').tag, 'kept');
			assert.ok(shardingConvertedTables(database).some((root) => root.tables.some((entry) => entry.name === 'Plain')));
			assert.equal(hasExistingOwnerAssertion(database), false, 'an earlier receipt did not capture this table');
			const previous = Rows.dbisDB.getSync(receiptKey);
			await assert.rejects(
				initializeResidencySlots({ database, existing_owner: true, expected_digest: 'wrong' }),
				/differs/
			);
			assert.deepStrictEqual(Rows.dbisDB.getSync(receiptKey), previous);
			assert.equal(hasExistingOwnerAssertion(database), false);
			await initializeResidencySlots({ database, existing_owner: true, expected_digest: snapshot.digest });
			assert.equal(hasExistingOwnerAssertion(database), true);
		});

		it('does not reuse an assertion after the local root generation changes', async () => {
			const { hasExistingOwnerAssertion } = require('#src/resources/shardingCompleteness');
			const { stampDatabaseGeneration, establishDatabaseGeneration } = require('#src/resources/auditStore');
			assert.equal(hasExistingOwnerAssertion(database), true);
			stampDatabaseGeneration(Rows.auditStore, { carriesLog: true });
			establishDatabaseGeneration(Rows.auditStore);
			assert.equal(hasExistingOwnerAssertion(database), false);
			await initializeResidencySlots({ database, existing_owner: true, expected_digest: snapshot.digest });
			assert.equal(hasExistingOwnerAssertion(database), true);
		});
	}
);
