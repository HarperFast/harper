'use strict';

const assert = require('node:assert');
const testUtils = require('../testUtils.js');
const { loadGQLSchema } = require('#src/resources/graphql');
const { databases, dropDatabase } = require('#src/resources/databases');
const search = require('#src/dataLayer/search');
const serverUtilities = require('#src/server/serverHelpers/serverUtilities');
const { ClientError } = require('#src/utility/errors/hdbError');

const TEST_DB = 'search_by_value_400_test';
const TEST_TABLE = 'Product';

const superUser = {
	username: 'admin',
	role: {
		id: 'super_user',
		role: 'super_user',
		permission: { super_user: true },
	},
};

function assertBadRequest(err, expectedMessage) {
	assert.equal(err instanceof ClientError, true);
	assert.equal(err.statusCode, 400);
	if (expectedMessage instanceof RegExp) {
		assert.match(err.message, expectedMessage);
	} else {
		assert.equal(err.message, expectedMessage);
	}
	return true;
}

describe('search_by_value and search_by_hash validation errors (400)', () => {
	let ProductTable;

	before(async function () {
		testUtils.setupTestDBPath();
		await dropDatabase(TEST_DB).catch(() => {});

		await loadGQLSchema(`
			type ${TEST_TABLE} @table(database: "${TEST_DB}", audit: true) {
				id: ID @primaryKey
				title: String @indexed
				category: String
				catalogSearch: FullText @fullText(fields: [{ name: "title" }])
			}
		`);

		ProductTable = databases[TEST_DB][TEST_TABLE];
		await ProductTable.put({ id: 'shoe-1', title: 'Trail Runner Shoe', category: 'footwear' });
		await ProductTable.put({ id: 'hat-1', title: 'Sun Hat', category: 'headwear' });
	});

	after(async () => {
		await dropDatabase(TEST_DB).catch(() => {});
	});

	it('returns a 400 ClientError for a super_user when search_by_value specifies an unknown search_attribute', async () => {
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
			(err) => assertBadRequest(err, "unknown attribute 'nonexistent_attr'")
		);

		await assert.rejects(
			() => serverUtilities.operation({ ...payload }, { user: superUser }, true),
			(err) => assertBadRequest(err, "unknown attribute 'nonexistent_attr'")
		);
	});

	it('returns a 400 ClientError for a super_user when search_by_value specifies a FullText index name as search_attribute', async () => {
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
			(err) => assertBadRequest(err, "unknown attribute 'catalogSearch'")
		);

		await assert.rejects(
			() => serverUtilities.operation({ ...payload }, { user: superUser }, true),
			(err) => assertBadRequest(err, "unknown attribute 'catalogSearch'")
		);
	});

	it('returns a 400 ClientError for a super_user when search_by_value fails schema validation', async () => {
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
			() => search.searchByValue({ ...payload }),
			(err) => assertBadRequest(err, /attribute/)
		);

		await assert.rejects(
			() => serverUtilities.operation({ ...payload }, { user: superUser }, true),
			(err) => assertBadRequest(err, /attribute/)
		);
	});

	it('returns a 400 ClientError for a super_user when search_by_hash fails validation', async () => {
		const invalidHashesPayload = {
			operation: 'search_by_hash',
			database: TEST_DB,
			table: TEST_TABLE,
			hash_values: 'not-an-array',
			get_attributes: ['*'],
			hdb_user: superUser,
		};

		await assert.rejects(
			() => search.searchByHash({ ...invalidHashesPayload }),
			(err) => assertBadRequest(err, "'hash_values' must be an array")
		);

		await assert.rejects(
			() => serverUtilities.operation({ ...invalidHashesPayload }, { user: superUser }, true),
			(err) => assertBadRequest(err, "'hash_values' must be an array")
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
			(err) => assertBadRequest(err, "unknown attribute 'nonexistent_attr'")
		);

		await assert.rejects(
			() => serverUtilities.operation({ ...unknownGetAttrPayload }, { user: superUser }, true),
			(err) => assertBadRequest(err, "unknown attribute 'nonexistent_attr'")
		);
	});

	it('preserves 404 statusCode when search_by_value or search_by_hash targets a nonexistent table', async () => {
		await assert.rejects(
			() =>
				search.searchByValue({
					operation: 'search_by_value',
					database: TEST_DB,
					table: 'MissingTable',
					search_attribute: 'title',
					search_value: 'Shoe',
					get_attributes: ['*'],
					hdb_user: superUser,
				}),
			(err) => {
				assert.equal(err.statusCode, 404);
				assert.equal(err.message, `Table '${TEST_DB}.MissingTable' does not exist`);
				return true;
			}
		);

		await assert.rejects(
			() =>
				search.searchByHash({
					operation: 'search_by_hash',
					database: TEST_DB,
					table: 'MissingTable',
					hash_values: ['shoe-1'],
					get_attributes: ['*'],
					hdb_user: superUser,
				}),
			(err) => {
				assert.equal(err.statusCode, 404);
				assert.equal(err.message, `Table '${TEST_DB}.MissingTable' does not exist`);
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
