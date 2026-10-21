'use strict';

const assert = require('assert');
const { matchQualifier, declaringTables, usingLeftOwner } = require('#src/sqlEngine/binder/columnScope');

const table = (name, alias, ...attributes) => ({
	table: name,
	effectiveAlias: alias ?? name,
	attributes: attributes.map((attribute) => ({ name: attribute })),
});

describe('sqlEngine columnScope', () => {
	it('matchQualifier prefers an effective alias over a base table name', () => {
		const scope = [table('L', 'a'), table('R', 'L')];
		assert.strictEqual(matchQualifier('L', scope).table, scope[1]);
	});

	it('matchQualifier reports a base table name shared by several tables as ambiguous', () => {
		const scope = [table('L', 'a'), table('L', 'b')];
		assert.deepStrictEqual(matchQualifier('L', scope), { ambiguous: scope });
		assert.strictEqual(matchQualifier('missing', scope), undefined);
	});

	it('declaringTables lists every table that declares the attribute', () => {
		const scope = [table('L', 'a', 'ssn'), table('R', 'b', 'code'), table('C', 'c', 'ssn')];
		assert.deepStrictEqual(declaringTables('ssn', scope), [scope[0], scope[2]]);
	});

	it('usingLeftOwner picks the nearest preceding declarer, else the FROM table', () => {
		const scope = [table('L', 'a', 'ssn'), table('R', 'b', 'ssn'), table('C', 'c', 'ssn', 'code')];
		assert.strictEqual(usingLeftOwner('ssn', scope, 2), scope[1]);
		assert.strictEqual(usingLeftOwner('code', scope, 2), scope[0]);
	});
});
