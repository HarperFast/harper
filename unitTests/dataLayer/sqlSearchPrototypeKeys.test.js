'use strict';

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const assert = require('node:assert');
const { generateMockAST } = require('../sqlTestUtils');
const { createMockDB, tearDownMockDB } = testUtils;
const SQLSearch = require('#src/dataLayer/SQLSearch').default;

describe('legacy SQL search with a `__proto__` row-map key', function () {
	this.timeout(0);
	const env = [];

	before(async function () {
		env.push(
			...(await createMockDB('id', '_', 't', [
				{ id: 1, name: 'a' },
				{ id: 2, name: 'b' },
			]))
		);
		env.push(
			...(await createMockDB('id', '_', 'r', [
				{ id: '__proto__', name: 'x' },
				{ id: 'k', name: 'y' },
			]))
		);
	});

	afterEach(function () {
		delete Object.prototype.polluted_marker;
	});

	after(async function () {
		await tearDownMockDB(env);
	});

	function search(sql) {
		const validated = generateMockAST(sql);
		return new SQLSearch(validated.statement, validated.attributes).search();
	}

	it('keeps a selected alias off Object.prototype on the simple-select path', async function () {
		let rows, error;
		try {
			rows = await search('SELECT id AS polluted_marker FROM _.t AS proto__');
		} catch (searchError) {
			error = searchError;
		}
		assert.strictEqual({}.polluted_marker, undefined, 'Object.prototype gained the column alias');
		assert.ifError(error);
		assert.deepStrictEqual(rows.map((row) => row.polluted_marker).sort(), [1, 2]);
	});

	it('resolves the key as an own row map on the alasql path', async function () {
		const rows = await search('SELECT proto__.name FROM _.t AS proto__ WHERE proto__.id = 1');
		assert.deepStrictEqual(rows, [{ name: 'a' }]);
		assert.strictEqual({}.polluted_marker, undefined);
	});

	it('keeps a row whose id is `__proto__` off Object.prototype on the simple-select path', async function () {
		let rows, error;
		try {
			rows = await search('SELECT name AS polluted_marker FROM _.r');
		} catch (searchError) {
			error = searchError;
		}
		assert.strictEqual({}.polluted_marker, undefined, 'Object.prototype gained the selected value');
		assert.ifError(error);
		assert.deepStrictEqual(rows.map((row) => row.polluted_marker).sort(), ['x', 'y']);
	});

	it('returns a row whose id is `__proto__` on the alasql path', async function () {
		const rows = await search("SELECT name FROM _.r WHERE (name = 'x')");
		assert.deepStrictEqual(rows, [{ name: 'x' }]);
	});
});
