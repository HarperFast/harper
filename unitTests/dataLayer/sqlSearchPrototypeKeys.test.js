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

describe('legacy SQL search with a `__proto__` GROUP BY key', function () {
	this.timeout(0);
	const env = [];

	before(async function () {
		env.push(
			...(await createMockDB('id', '_', 'g', [
				{ id: 1, grp: '__proto__' },
				{ id: 2, grp: '__proto__' },
				{ id: 3, grp: 'ok' },
			]))
		);
	});

	after(async function () {
		await tearDownMockDB(env);
	});

	function search(sql) {
		const validated = generateMockAST(sql);
		return new SQLSearch(validated.statement, validated.attributes).search();
	}

	it('returns the `__proto__` group without polluting Object.prototype', async function () {
		const ownPropsBefore = new Set(Object.getOwnPropertyNames(Object.prototype));
		let rows;
		let error;
		try {
			try {
				rows = await search('SELECT grp, COUNT(*) FROM _.g GROUP BY grp');
			} catch (searchError) {
				error = searchError;
			}
			const addedProps = Object.getOwnPropertyNames(Object.prototype).filter((key) => !ownPropsBefore.has(key));
			assert.strictEqual({}['COUNT(*)'], undefined, 'Object.prototype gained COUNT(*)');
			assert.deepStrictEqual(addedProps, [], `Object.prototype gained own properties: ${addedProps.join(', ')}`);
			assert.ifError(error);
			assert.deepStrictEqual(
				[...rows].sort((a, b) => String(a.grp).localeCompare(String(b.grp))),
				[
					{ 'grp': '__proto__', 'COUNT(*)': 2 },
					{ 'grp': 'ok', 'COUNT(*)': 1 },
				]
			);
		} finally {
			for (const key of Object.getOwnPropertyNames(Object.prototype)) {
				if (!ownPropsBefore.has(key)) delete Object.prototype[key];
			}
		}
	});
});
