const assert = require('node:assert');
const pid = process.pid;

exports.mochaHooks = {
	beforeAll() {
		assert.strictEqual(process.pid, pid, 'loading skipped fixtures must preserve the process identity');
	},
};
