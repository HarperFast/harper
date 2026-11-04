const assert = require('node:assert');
const { appendFileSync } = require('node:fs');
assert.notStrictEqual(process.env.MOCHA_WORKER_ID, undefined);
if (process.env.HARPER_TEST_WORKER_PIDS) appendFileSync(process.env.HARPER_TEST_WORKER_PIDS, `${process.pid}\n`);
describe('a real parallel worker', () => {
	it('executes in the worker pool', () => assert(Number(process.env.MOCHA_WORKER_ID) >= 0));
});
