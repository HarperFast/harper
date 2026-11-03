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
const isRocksDB = process.env.HARPER_STORAGE_ENGINE !== 'lmdb';
const BAD_ATTR_JOI_MSG = "'attribute' names cannot include backticks or forward slashes";

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
	assert.equal(err.message, expectedMessage);
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
				${isRocksDB ? 'catalogSearch: FullText @fullText(fields: [{ name: "title" }])' : ''}
			}
		`);

		ProductTable = databases[TEST_DB][TEST_TABLE];
		await ProductTable.put({ id: 'shoe-1', title: 'Trail Runner Shoe', category: 'footwear' });
		await ProductTable.put({ id: 'hat-1', title: 'Sun Hat', category: 'headwear' });
		await ProductTable.put({ id: 'null-1', title: null, category: null });
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

	(isRocksDB ? it : it.skip)(
		'returns a 400 ClientError for a super_user when search_by_value specifies a RocksDB FullText index name as search_attribute',
		async () => {
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
		}
	);

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
			(err) => assertBadRequest(err, BAD_ATTR_JOI_MSG)
		);

		await assert.rejects(
			() => serverUtilities.operation({ ...payload }, { user: superUser }, true),
			(err) => assertBadRequest(err, BAD_ATTR_JOI_MSG)
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

	it('returns null-valued rows when search_by_value specifies search_value: null, matching search_by_conditions with equals null', async () => {
		for (const attr of ['title', 'category']) {
			const directRes = [];
			for await (const rec of await search.searchByValue({
				operation: 'search_by_value',
				database: TEST_DB,
				table: TEST_TABLE,
				search_attribute: attr,
				search_value: null,
				get_attributes: ['id', 'title', 'category'],
				hdb_user: superUser,
			})) {
				directRes.push(rec);
			}

			const opValueRes = [];
			for await (const rec of await serverUtilities.operation(
				{
					operation: 'search_by_value',
					database: TEST_DB,
					table: TEST_TABLE,
					search_attribute: attr,
					search_value: null,
					get_attributes: ['id', 'title', 'category'],
				},
				{ user: superUser },
				true
			)) {
				opValueRes.push(rec);
			}

			const opConditionsRes = [];
			for await (const rec of await serverUtilities.operation(
				{
					operation: 'search_by_conditions',
					database: TEST_DB,
					table: TEST_TABLE,
					get_attributes: ['id', 'title', 'category'],
					conditions: [{ search_attribute: attr, search_type: 'equals', search_value: null }],
				},
				{ user: superUser },
				true
			)) {
				opConditionsRes.push(rec);
			}

			assert.deepEqual(directRes, [{ id: 'null-1', title: null, category: null }]);
			assert.deepEqual(opValueRes, opConditionsRes);
		}
	});

	it('returns a 400 ClientError when search_by_value specifies an array containing "*" as search_value', async () => {
		for (const searchValue of [['*'], ['Shoe', '*']]) {
			const payload = {
				operation: 'search_by_value',
				database: TEST_DB,
				table: TEST_TABLE,
				search_attribute: 'title',
				search_value: searchValue,
				get_attributes: ['*'],
				hdb_user: superUser,
			};

			await assert.rejects(
				() => search.searchByValue({ ...payload }),
				(err) => assertBadRequest(err, "'value' must not be an array containing '*'")
			);

			await assert.rejects(
				() => serverUtilities.operation({ ...payload }, { user: superUser }, true),
				(err) => assertBadRequest(err, "'value' must not be an array containing '*'")
			);
		}
	});

	it('preserves search_by_value behavior for non-wildcard arrays and plain objects', async () => {
		for (const attr of ['title', 'category']) {
			const arrayRes = [];
			for await (const rec of await serverUtilities.operation(
				{
					operation: 'search_by_value',
					database: TEST_DB,
					table: TEST_TABLE,
					search_attribute: attr,
					search_value: ['Trail Runner Shoe', 'Sun Hat'],
					get_attributes: ['id', 'title', 'category'],
				},
				{ user: superUser },
				true
			)) {
				arrayRes.push(rec);
			}
			assert.deepEqual(arrayRes, []);
		}

		const unindexedObjectRes = [];
		for await (const rec of await serverUtilities.operation(
			{
				operation: 'search_by_value',
				database: TEST_DB,
				table: TEST_TABLE,
				search_attribute: 'category',
				search_value: { nested: 'value' },
				get_attributes: ['id', 'title', 'category'],
			},
			{ user: superUser },
			true
		)) {
			unindexedObjectRes.push(rec);
		}
		assert.deepEqual(unindexedObjectRes, []);
	});
});
