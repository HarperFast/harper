'use strict';

const assert = require('node:assert/strict');
const testUtils = require('../testUtils.js');
const { loadGQLSchema } = require('#src/resources/graphql');
const { databases, dropDatabase } = require('#src/resources/databases');
const search = require('#src/dataLayer/search');
const { ResourceBridge } = require('#src/dataLayer/harperBridge/ResourceBridge');
const serverUtilities = require('#src/server/serverHelpers/serverUtilities');
const { isHDBError } = require('#src/utility/errors/hdbError');

const TEST_DB = 'search_by_value_400_test';
const TEST_TABLE = 'Product';
const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

const superUser = {
	username: 'admin',
	role: {
		id: 'super_user',
		role: 'super_user',
		permission: { super_user: true },
	},
};

describe('search_by_value and search_by_hash validation errors (400)', () => {
	const resourceBridge = new ResourceBridge();
	let ProductTable;

	before(async function () {
		testUtils.setupTestDBPath();
		await dropDatabase(TEST_DB).catch(() => {});

		await loadGQLSchema(`
			type ${TEST_TABLE} @table(database: "${TEST_DB}", audit: true) {
				id: ID @primaryKey
				title: String @indexed
				category: String
				${isLMDB ? '' : 'catalogSearch: FullText @fullText(fields: [{ name: "title" }])'}
			}
		`);

		ProductTable = databases[TEST_DB][TEST_TABLE];
		if (isLMDB) {
			ProductTable.fullTextIndexes = [{ name: 'catalogSearch', fields: [{ name: 'title', weight: 1 }] }];
		}
		await ProductTable.put({ id: 'shoe-1', title: 'Trail Runner Shoe', category: 'footwear' });
		await ProductTable.put({ id: 'hat-1', title: 'Sun Hat', category: 'headwear' });
	});

	after(async () => {
		await dropDatabase(TEST_DB).catch(() => {});
	});

	it('returns a 400 HdbError for a super_user when search_by_value specifies an unknown search_attribute', async () => {
		const payload = {
			operation: 'search_by_value',
			database: TEST_DB,
			table: TEST_TABLE,
			search_attribute: 'nonexistent_attr',
			search_value: 'Trail Runner Shoe',
			get_attributes: ['*'],
			hdb_user: superUser,
		};

		await assert.rejects(
			() => search.searchByValue({ ...payload }),
			(err) => {
				assert.equal(isHDBError(err), true);
				assert.equal(err.statusCode, 400);
				assert.equal(err.http_resp_msg, "unknown attribute 'nonexistent_attr'");
				assert.equal(err.stack, undefined);
				return true;
			}
		);

		await assert.rejects(
			() => serverUtilities.operation({ ...payload }, { user: superUser }, true),
			(err) => {
				assert.equal(isHDBError(err), true);
				assert.equal(err.statusCode, 400);
				assert.equal(err.http_resp_msg, "unknown attribute 'nonexistent_attr'");
				assert.equal(err.stack, undefined);
				return true;
			}
		);
	});

	it('returns a 400 HdbError for a super_user when search_by_value specifies a FullText index name as search_attribute', async () => {
		// Verify that the FullText index is registered on fullTextIndexes rather than table.attributes
		assert.equal(
			ProductTable.fullTextIndexes.some((idx) => idx.name === 'catalogSearch'),
			true,
			'expected FullText index catalogSearch to exist'
		);
		assert.equal(
			ProductTable.attributes.some((a) => (a.attribute ?? a.name) === 'catalogSearch'),
			false,
			'FullText index name should not be a regular table attribute'
		);

		const payload = {
			operation: 'search_by_value',
			database: TEST_DB,
			table: TEST_TABLE,
			search_attribute: 'catalogSearch',
			search_value: 'Shoe',
			get_attributes: ['*'],
			hdb_user: superUser,
		};

		await assert.rejects(
			() => search.searchByValue({ ...payload }),
			(err) => {
				assert.equal(isHDBError(err), true);
				assert.equal(err.statusCode, 400);
				assert.equal(err.http_resp_msg, "unknown attribute 'catalogSearch'");
				assert.equal(err.stack, undefined);
				return true;
			}
		);

		await assert.rejects(
			() => serverUtilities.operation({ ...payload }, { user: superUser }, true),
			(err) => {
				assert.equal(isHDBError(err), true);
				assert.equal(err.statusCode, 400);
				assert.equal(err.http_resp_msg, "unknown attribute 'catalogSearch'");
				assert.equal(err.stack, undefined);
				return true;
			}
		);
	});

	it('returns a 400 HdbError for a super_user when search_by_value fails schema validation', async () => {
		const payload = {
			operation: 'search_by_value',
			database: TEST_DB,
			table: TEST_TABLE,
			search_attribute: 'bad/attr',
			search_value: 'Shoe',
			get_attributes: ['*'],
			hdb_user: superUser,
		};

		await assert.rejects(
			() => serverUtilities.operation({ ...payload }, { user: superUser }, true),
			(err) => {
				assert.equal(isHDBError(err), true);
				assert.equal(err.statusCode, 400);
				assert.match(err.http_resp_msg, /attribute/);
				assert.equal(err.stack, undefined);
				return true;
			}
		);
	});

	it('returns a 400 HdbError when searchByValue is called with an invalid comparator', () => {
		const payload = {
			operation: 'search_by_value',
			database: TEST_DB,
			table: TEST_TABLE,
			search_attribute: 'title',
			search_value: 'Trail Runner Shoe',
			get_attributes: ['*'],
		};

		assert.throws(
			() => resourceBridge.searchByValue(payload, '$$'),
			(err) => {
				assert.equal(isHDBError(err), true);
				assert.equal(err.statusCode, 400);
				assert.equal(err.http_resp_msg, 'Value search comparator - $$ - is not valid');
				assert.equal(err.stack, undefined);
				return true;
			}
		);
	});

	it('returns a 400 HdbError for a super_user when search_by_hash fails validation', async () => {
		const invalidHashesPayload = {
			operation: 'search_by_hash',
			database: TEST_DB,
			table: TEST_TABLE,
			hash_values: 'not-an-array',
			get_attributes: ['*'],
			hdb_user: superUser,
		};

		await assert.rejects(
			() => serverUtilities.operation({ ...invalidHashesPayload }, { user: superUser }, true),
			(err) => {
				assert.equal(isHDBError(err), true);
				assert.equal(err.statusCode, 400);
				assert.match(err.http_resp_msg, /hash_values/);
				assert.equal(err.stack, undefined);
				return true;
			}
		);

		const unknownGetAttrPayload = {
			operation: 'search_by_hash',
			database: TEST_DB,
			table: TEST_TABLE,
			hash_values: ['shoe-1'],
			get_attributes: ['nonexistent_attr'],
			hdb_user: superUser,
		};

		await assert.rejects(
			() => search.searchByHash({ ...unknownGetAttrPayload }),
			(err) => {
				assert.equal(isHDBError(err), true);
				assert.equal(err.statusCode, 400);
				assert.equal(err.http_resp_msg, "unknown attribute 'nonexistent_attr'");
				assert.equal(err.stack, undefined);
				return true;
			}
		);
	});

	it('leaves valid search_by_value searches unchanged for a super_user', async () => {
		const exactRes = [];
		for await (const rec of await serverUtilities.operation(
			{
				operation: 'search_by_value',
				database: TEST_DB,
				table: TEST_TABLE,
				search_attribute: 'title',
				search_value: 'Trail Runner Shoe',
				get_attributes: ['id', 'title'],
			},
			{ user: superUser },
			true
		)) {
			exactRes.push(rec);
		}
		assert.deepEqual(exactRes, [{ id: 'shoe-1', title: 'Trail Runner Shoe' }]);

		const wildcardRes = [];
		for await (const rec of await serverUtilities.operation(
			{
				operation: 'search_by_value',
				database: TEST_DB,
				table: TEST_TABLE,
				search_attribute: 'title',
				search_value: '*Shoe*',
				get_attributes: ['id'],
			},
			{ user: superUser },
			true
		)) {
			wildcardRes.push(rec);
		}
		assert.deepEqual(wildcardRes, [{ id: 'shoe-1' }]);
	});
});
