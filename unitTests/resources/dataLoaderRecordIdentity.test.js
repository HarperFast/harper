'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { setupTestDBPath } = require('../testUtils');
const { loadGQLSchema } = require('#src/resources/graphql');
const { table, tables, databases } = require('#src/resources/databases');
const { loadDataFile, computeRecordHash } = require('#src/resources/dataLoader');

// The hash earlier versions stored (top-level keys sorted only), frozen here so legacy fixtures
// do not move with computeRecordHash
function legacyHash(record) {
	const sortedRecord = {};
	for (const key of Object.keys(record).sort()) sortedRecord[key] = record[key];
	return createHash('sha256').update(JSON.stringify(sortedRecord)).digest('hex');
}

function load(data) {
	return loadDataFile(
		{ contents: Buffer.from(JSON.stringify(data)), absolutePath: `/dataloader-identity/${data.table}.json` },
		tables,
		databases
	);
}

describe('Data loader record identity', function () {
	let hashTable;

	before(async function () {
		setupTestDBPath();
		hashTable = table({
			database: 'system',
			table: 'hdb_dataloader_hash',
			attributes: [
				{ name: 'id', type: 'string', isPrimaryKey: true },
				{ name: 'hash', type: 'string' },
			],
		});
		await loadGQLSchema(`
		type DlIdSku @table {
			sku: String @primaryKey
			name: String
			price: Int
		}
		type DlIdShared @table {
			id: ID @primaryKey
			label: String
		}
		type DlIdDefault @table {
			id: ID @primaryKey
			label: String
		}
		type DlIdNested @table {
			id: ID @primaryKey
		}
		type DlIdLegacy @table {
			id: ID @primaryKey
		}
		type DlIdSkuWithId @table {
			sku: String @primaryKey
			id: Int
			value: Int
		}
		type DlIdLegacySku @table {
			sku: String @primaryKey
			value: Int
		}
		type DlIdUndefinedKey @table {
			sku: String @primaryKey
			value: Int
		}`);
	});

	async function storedHash(key) {
		return (await hashTable.get(key))?.hash;
	}

	describe('custom primary key', function () {
		const v1 = [
			{ sku: 'SKU-100', name: 'Widget', price: 10 },
			{ sku: 'SKU-200', name: 'Gadget', price: 50 },
			{ sku: 'SKU-300', name: 'Doohickey', price: 5 },
		];

		it('loads records under their primary key and tracks each one separately', async function () {
			const result = await load({ table: 'DlIdSku', records: v1 });
			assert.equal(result.status, 'success');
			assert.equal((await tables.DlIdSku.get('SKU-200')).price, 50);
			for (const record of v1) assert.equal(await storedHash(`DlIdSku:${record.sku}`), computeRecordHash(record));
			assert.ok(!(await hashTable.get('DlIdSku:undefined')));
		});

		it('keeps user edits on reload and applies a data file change to an untouched record', async function () {
			await tables.DlIdSku.patch('SKU-100', { userNote: 'custom-note' });
			await tables.DlIdSku.patch('SKU-200', { price: 99 });
			const untouchedVersion = (await tables.DlIdSku.get('SKU-300')).getUpdatedTime();

			const reload = await load({ table: 'DlIdSku', records: v1 });
			assert.equal(reload.status, 'skipped');
			assert.equal((await tables.DlIdSku.get('SKU-100')).userNote, 'custom-note');
			assert.equal((await tables.DlIdSku.get('SKU-200')).price, 99);
			assert.equal((await tables.DlIdSku.get('SKU-300')).getUpdatedTime(), untouchedVersion);

			const v2 = v1.map((record) => (record.sku === 'SKU-300' ? { ...record, price: 6 } : record));
			const update = await load({ table: 'DlIdSku', records: v2 });
			assert.equal(update.status, 'success');
			assert.equal((await tables.DlIdSku.get('SKU-300')).price, 6);
			assert.equal((await tables.DlIdSku.get('SKU-200')).price, 99);
			assert.equal((await tables.DlIdSku.get('SKU-100')).userNote, 'custom-note');
		});
	});

	it('creates the table in the named database instead of using a same-named table in data', async function () {
		await tables.DlIdShared.put({ id: 'item-1', label: 'data-owned' });
		await load({ database: 'dl_identity_tenant', table: 'DlIdShared', records: [{ id: 'item-2', label: 'tenant' }] });

		assert.equal((await databases.dl_identity_tenant.DlIdShared.get('item-2')).label, 'tenant');
		assert.ok(!(await tables.DlIdShared.get('item-2')));
		assert.equal((await tables.DlIdShared.get('item-1')).label, 'data-owned');
	});

	describe('default database spelling', function () {
		it('updates a record loaded without a database from a file naming "data"', async function () {
			await load({ table: 'DlIdDefault', records: [{ id: 'd-1', label: 'v1' }] });
			await load({ database: 'data', table: 'DlIdDefault', records: [{ id: 'd-1', label: 'v2' }] });
			assert.equal((await tables.DlIdDefault.get('d-1')).label, 'v2');
		});

		it('updates a record loaded from a file naming "data" from a file without a database', async function () {
			await load({ database: 'data', table: 'DlIdDefault', records: [{ id: 'd-2', label: 'v1' }] });
			await load({ table: 'DlIdDefault', records: [{ id: 'd-2', label: 'v2' }] });
			assert.equal((await tables.DlIdDefault.get('d-2')).label, 'v2');
		});
	});

	describe('nested content', function () {
		const v1 = { id: 'n-1', meta: { a: 1, deep: { x: 1, y: 2 } }, items: [{ p: 1, q: 2 }, { p: 3 }] };

		it('skips a reload whose only difference is nested key order', async function () {
			await load({ table: 'DlIdNested', records: [v1] });
			const version = (await tables.DlIdNested.get('n-1')).getUpdatedTime();

			const reordered = { items: [{ q: 2, p: 1 }, { p: 3 }], meta: { deep: { y: 2, x: 1 }, a: 1 }, id: 'n-1' };
			const result = await load({ table: 'DlIdNested', records: [reordered] });
			assert.equal(result.status, 'skipped');
			assert.equal((await tables.DlIdNested.get('n-1')).getUpdatedTime(), version);
		});

		it('applies a nested value change and an array reorder', async function () {
			const changed = { ...v1, meta: { a: 1, deep: { x: 3, y: 2 } } };
			assert.equal((await load({ table: 'DlIdNested', records: [changed] })).status, 'success');
			assert.equal((await tables.DlIdNested.get('n-1')).meta.deep.x, 3);

			const reordered = { ...changed, items: [{ p: 3 }, { p: 1, q: 2 }] };
			assert.equal((await load({ table: 'DlIdNested', records: [reordered] })).status, 'success');
			assert.equal((await tables.DlIdNested.get('n-1')).items[0].p, 3);
		});
	});

	describe('hashes stored by earlier versions', function () {
		it('honors a hash stored under the "data:" spelling when the file names no database', async function () {
			const old = { id: 'l-1', label: 'v1' };
			await tables.DlIdLegacy.put(old);
			await hashTable.put({ id: 'data:DlIdLegacy:l-1', hash: legacyHash(old) });

			await load({ table: 'DlIdLegacy', records: [{ id: 'l-1', label: 'v2' }] });
			assert.equal((await tables.DlIdLegacy.get('l-1')).label, 'v2');
			assert.equal(await storedHash('DlIdLegacy:l-1'), computeRecordHash({ id: 'l-1', label: 'v2' }));
		});

		it('honors a top-level-only hash of nested content without rewriting the record', async function () {
			const old = { id: 'l-2', meta: { z: 1, a: 2 } };
			await tables.DlIdLegacy.put(old);
			await hashTable.put({ id: 'DlIdLegacy:l-2', hash: legacyHash(old) });
			const version = (await tables.DlIdLegacy.get('l-2')).getUpdatedTime();

			assert.equal((await load({ table: 'DlIdLegacy', records: [old] })).status, 'skipped');
			assert.equal((await tables.DlIdLegacy.get('l-2')).getUpdatedTime(), version);
			assert.notEqual(await storedHash('DlIdLegacy:l-2'), legacyHash(old));

			await load({ table: 'DlIdLegacy', records: [{ id: 'l-2', meta: { z: 5, a: 2 } }] });
			assert.equal((await tables.DlIdLegacy.get('l-2')).meta.z, 5);
		});

		it('honors a hash stored under the id field of a record with another primary key', async function () {
			const old = { sku: 'a', id: 17, value: 1 };
			await tables.DlIdSkuWithId.put({ ...old, userNote: 'keep' });
			await hashTable.put({ id: 'DlIdSkuWithId:17', hash: legacyHash(old) });

			await load({ table: 'DlIdSkuWithId', records: [{ sku: 'a', id: 17, value: 2 }] });
			const record = await tables.DlIdSkuWithId.get('a');
			assert.equal(record.value, 2);
			assert.equal(record.userNote, 'keep');
		});

		describe('custom primary key without an id field', function () {
			before(async function () {
				// What an earlier version left behind: every record put, one shared hash slot holding the
				// last record's hash, and a user edit to b since that load
				for (const sku of ['a', 'b', 'c']) await tables.DlIdLegacySku.put({ sku, value: 1 });
				await hashTable.put({ id: 'DlIdLegacySku:undefined', hash: legacyHash({ sku: 'c', value: 1 }) });
				await tables.DlIdLegacySku.patch('b', { value: 7 });
			});

			it('updates only the record the shared hash belongs to and preserves the rest', async function () {
				const v2 = ['a', 'b', 'c'].map((sku) => ({ sku, value: 2 }));
				await load({ table: 'DlIdLegacySku', records: v2 });

				assert.equal((await tables.DlIdLegacySku.get('c')).value, 2);
				assert.equal((await tables.DlIdLegacySku.get('a')).value, 1);
				assert.equal((await tables.DlIdLegacySku.get('b')).value, 7);
				assert.equal(await storedHash('DlIdLegacySku:c'), computeRecordHash({ sku: 'c', value: 2 }));
				assert.ok(!(await hashTable.get('DlIdLegacySku:a')));
			});

			it('never adopts a record created outside the data loader, even with identical content', async function () {
				await tables.DlIdLegacySku.put({ sku: 'd', value: 9 });
				await load({ table: 'DlIdLegacySku', records: [{ sku: 'd', value: 9 }] });
				await load({ table: 'DlIdLegacySku', records: [{ sku: 'd', value: 10 }] });
				assert.equal((await tables.DlIdLegacySku.get('d')).value, 9);
			});
		});

		it('does not treat the hash of a record keyed "undefined" as evidence for other records', async function () {
			await load({ table: 'DlIdUndefinedKey', records: [{ sku: 'undefined', value: 1 }] });
			await tables.DlIdUndefinedKey.put({ sku: 'x', value: 1 });

			await load({
				table: 'DlIdUndefinedKey',
				records: [
					{ sku: 'undefined', value: 1 },
					{ sku: 'x', value: 2 },
				],
			});
			assert.equal((await tables.DlIdUndefinedKey.get('x')).value, 1);
		});
	});

	describe('computeRecordHash', function () {
		it('ignores key order at every depth but not array order', function () {
			const hash = computeRecordHash({ a: 1, b: { c: 2, d: [{ e: 3, f: 4 }] } });
			assert.equal(computeRecordHash({ b: { d: [{ f: 4, e: 3 }], c: 2 }, a: 1 }), hash);
			assert.notEqual(computeRecordHash({ a: 1, b: { c: 2, d: [{ e: 4, f: 3 }] } }), hash);
			assert.notEqual(computeRecordHash({ list: [1, 2] }), computeRecordHash({ list: [2, 1] }));
		});

		it('matches the earlier hash for records without nested objects', function () {
			const record = { name: 'x', id: 1, when: new Date(0), tags: ['b', 'a'] };
			assert.equal(computeRecordHash(record), legacyHash(record));
		});

		it('includes a nested __proto__ key', function () {
			const one = JSON.parse('{"meta": {"__proto__": {"x": 1}}}');
			const two = JSON.parse('{"meta": {"__proto__": {"x": 2}}}');
			assert.notEqual(computeRecordHash(one), computeRecordHash(two));
		});
	});
});
