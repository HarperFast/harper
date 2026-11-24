'use strict';

const assert = require('node:assert');
const alasql = require('alasql');
const { walkAst } = require('#src/sqlTranslator/walkAst');

const steps = (root) => [...walkAst(root)].map(({ node, key, path }) => ({ node, key, path }));

describe('walkAst', () => {
	it('yields every value under the root, depth first, object keys sorted and arrays in order', () => {
		const leaf = { z: 1, a: 2 };
		const list = ['x', leaf];
		assert.deepStrictEqual(steps({ b: list, a: null }), [
			{ node: null, key: 'a', path: ['a'] },
			{ node: list, key: 'b', path: ['b'] },
			{ node: 'x', key: '0', path: ['b', '0'] },
			{ node: leaf, key: '1', path: ['b', '1'] },
			{ node: 2, key: 'a', path: ['b', '1', 'a'] },
			{ node: 1, key: 'z', path: ['b', '1', 'z'] },
		]);
	});

	it('walks an array-like object in index order, without its length', () => {
		assert.deepStrictEqual(
			steps({ 1: 'b', 0: 'a', length: 2 }).map(({ key }) => key),
			['0', '1']
		);
	});

	it('reaches a value nested 1,000 levels deep', () => {
		const root = {};
		let node = root;
		for (let i = 0; i < 1000; i++) node = node.next = {};
		node.columnid = 'deep';
		const found = [...walkAst(root)].find((step) => step.node === 'deep');
		assert.strictEqual(found.path.length, 1001);
	});

	it('reads a node’s children after yielding it, so a replaced child is walked', () => {
		const node = { right: { value: 'old' } };
		const seen = [];
		for (const step of walkAst({ node })) {
			seen.push(step.node);
			if (step.node === node) node.right = { value: 'new' };
		}
		assert.ok(seen.includes('new'));
		assert.ok(!seen.includes('old'));
	});

	it('throws when it reaches an object a second time', () => {
		const shared = { columnid: 'a' };
		assert.throws(() => [...walkAst({ left: shared, right: shared })], /Circular reference/);
	});

	it('walks a parsed statement without reaching a node twice', () => {
		const statement = alasql.parse('SELECT a, COUNT(*) AS c FROM t WHERE a IS NOT NULL GROUP BY a ORDER BY c')
			.statements[0];
		const columns = [...walkAst(statement)]
			.filter(({ node }) => node && node.columnid)
			.map(({ node, path }) => `${path[0]}:${node.columnid}`);
		assert.deepStrictEqual(columns.sort(), ['columns:*', 'columns:a', 'group:a', 'order:c', 'where:a']);
	});
});
