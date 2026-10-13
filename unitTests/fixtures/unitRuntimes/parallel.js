const assert = require('node:assert');
assert.notStrictEqual(process.env.MOCHA_WORKER_ID, undefined);
describe('a real parallel worker', () => {
	it('executes in the worker pool', () => assert(Number(process.env.MOCHA_WORKER_ID) >= 0));
});
