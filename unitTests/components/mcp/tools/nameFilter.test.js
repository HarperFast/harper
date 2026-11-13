const assert = require('node:assert');
const { compileNameFilter, matchesAny, readNameList } = require('#src/components/mcp/tools/nameFilter');

describe('mcp/tools/nameFilter', () => {
	it('matches literals exactly and * as any run of characters', () => {
		assert.equal(matchesAny('describe_table', ['describe_*']), true);
		assert.equal(matchesAny('describe', ['describe_*']), false);
		assert.equal(matchesAny('system_information', ['system_information']), true);
		assert.equal(matchesAny('system.information', ['system_information']), false);
		assert.equal(matchesAny('anything', undefined), false);
	});

	it('escapes regex metacharacters other than *', () => {
		assert.equal(matchesAny('a.b', ['a.b']), true);
		assert.equal(matchesAny('axb', ['a.b']), false);
	});

	it('admits every name when allow is unset or empty, then applies deny', () => {
		assert.equal(compileNameFilter(undefined, undefined)('x'), true);
		assert.equal(compileNameFilter([], undefined)('x'), true);
		assert.equal(compileNameFilter(undefined, ['x'])('x'), false);
		const filter = compileNameFilter(['get_*'], ['get_secret']);
		assert.equal(filter('get_product'), true);
		assert.equal(filter('get_secret'), false);
		assert.equal(filter('delete_product'), false);
	});

	it('reads only arrays, keeping their string entries', () => {
		assert.equal(readNameList(undefined), undefined);
		assert.equal(readNameList('get_*'), undefined);
		assert.deepEqual(readNameList(['a', 1, null, 'b']), ['a', 'b']);
	});
});
