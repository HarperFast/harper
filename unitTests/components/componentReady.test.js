'use strict';

const assert = require('node:assert');

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const { readyComponentModules } = require('#src/components/componentLoader');

describe('component readiness', () => {
	it('shares an in-flight component ready hook', async () => {
		let calls = 0;
		let releaseReady;
		const readyStarted = new Promise((resolve) => {
			releaseReady = resolve;
		});
		const component = {
			async ready() {
				calls++;
				await readyStarted;
			},
		};
		const readyComponentPromises = new WeakMap();

		const firstReady = readyComponentModules([component], readyComponentPromises);
		const secondReady = readyComponentModules([component], readyComponentPromises);
		await new Promise((resolve) => setImmediate(resolve));
		releaseReady();
		await Promise.all([firstReady, secondReady]);

		assert.strictEqual(calls, 1);
	});

	it('retries a component ready hook after it rejects', async () => {
		let calls = 0;
		const component = {
			ready() {
				calls++;
				if (calls === 1) throw new Error('not ready yet');
			},
		};
		const readyComponentPromises = new WeakMap();

		await assert.rejects(() => readyComponentModules([component], readyComponentPromises), /not ready yet/);
		await readyComponentModules([component], readyComponentPromises);

		assert.strictEqual(calls, 2);
	});
});
