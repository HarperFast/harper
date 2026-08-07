'use strict';

const assert = require('node:assert');

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const { readyComponentModules } = require('#src/components/componentLoader');

describe('component readiness', () => {
	it('calls each component ready hook only once', async () => {
		let calls = 0;
		const component = {
			ready() {
				calls++;
			},
		};

		await readyComponentModules([component]);
		await readyComponentModules([component]);

		assert.strictEqual(calls, 1);
	});
});
