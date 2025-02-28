const { assert } = require('chai');
const { parseHeaderValue } = require('../../server/REST');

describe('REST - parseHeaderValue', function () {
	// It was identified in https://harperdb.atlassian.net/browse/CORE-2488 that the
	// parseHeaderValue function was susceptible to a denial of service attack due to
	// the exponential backtracking in the regex. This test case is to ensure that the
	// function is no longer vulnerable to this attack.
	// As detailed in the linked issue, if the max header size is set to 100,002, and
	// then a request includes a specified header with 100,000 whitespace characters,
	// then the regex would take upwards of 5 seconds to complete.
	it('should not be vulnerable to denial of service', function () {
		[
			'a' + ' '.repeat(100_000) + 'a',
			'a,b;' + ' '.repeat(100_000) + 'b',
			'a,b;c=' + ' '.repeat(100_000) + 'c'
		].forEach((value) => {
			const start = performance.now();
			parseHeaderValue(value);
			const elapsed = performance.now() - start;
			assert(elapsed < 1000, 'should not take longer than 1 second');
		});
	});
});
