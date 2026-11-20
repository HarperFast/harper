'use strict';

const assert = require('node:assert');
const { setTimeout: delay } = require('node:timers/promises');
const testUtils = require('../../testUtils.js');
testUtils.preTestPrep();

const { internal: statusInternal, statusForComponent, lifecycle } = require('#src/components/status/index');
const env = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
const status = require('#src/server/status/index');

const { componentStatusRegistry, crossThreadCollector } = statusInternal;
const setDrain = (value) => env.setProperty(CONFIG_PARAMS.STATUS_DRAINONLOADFAILURE, value);
const availability = () => status.get({ id: 'availability' });
const freshAvailability = () => {
	status.resetLoadFailuresCache();
	return availability();
};

describe('availability with drainOnLoadFailure', () => {
	beforeEach(async () => {
		componentStatusRegistry.reset();
		setDrain(true);
		status.resetLoadFailuresCache();
		await status.set({ id: 'availability', status: 'Available' });
	});

	afterEach(async () => {
		componentStatusRegistry.reset();
		setDrain(undefined);
		status.resetLoadFailuresCache();
		await status.clear({ id: 'availability' });
	});

	describe('the load failure mark in this thread', () => {
		it('holds until a load succeeds, whatever else reports on the component', async () => {
			lifecycle.failed('app.jsResource', new Error('boom'));
			assert.strictEqual((await freshAvailability())?.status, 'Unavailable');

			statusForComponent('app.jsResource').healthy('background work finished');
			assert.strictEqual((await freshAvailability())?.status, 'Unavailable', 'after a healthy report');
			componentStatusRegistry.setStatus('app.jsResource', 'error', 'runtime problem', undefined, 'log');
			assert.strictEqual((await freshAvailability())?.status, 'Unavailable', 'after a same-level log report');
			lifecycle.loading('app.jsResource');
			assert.strictEqual((await freshAvailability())?.status, 'Unavailable', 'while a retry loads');

			lifecycle.loaded('app.jsResource');
			assert.strictEqual((await freshAvailability())?.status, 'Available');
		});

		it('clears on a successful load that keeps the status the component reported', async () => {
			lifecycle.failed('app.jsResource', new Error('boom'));
			lifecycle.loading('app.jsResource');
			statusForComponent('app.jsResource').warning('degraded upstream');
			lifecycle.completed('app.jsResource');
			assert.strictEqual(componentStatusRegistry.getStatus('app.jsResource').status, 'warning');
			assert.strictEqual((await freshAvailability())?.status, 'Available');
		});

		it('ignores errors that are not load failures', async () => {
			componentStatusRegistry.setStatus('database.write-queue-overloaded', 'error', 'busy', undefined, 'log');
			componentStatusRegistry.setStatus('system.memory', 'error', '97%', undefined, 'health-check');
			statusForComponent('app.upstream').error('upstream down');
			lifecycle.loading('app.jsResource');
			assert.strictEqual((await freshAvailability())?.status, 'Available');
		});
	});

	describe('across threads', () => {
		let collections = 0;
		let threadStatuses = [];
		const entry = (level, extra) => ({ status: level, lastChecked: new Date(), ...extra });

		before(() => {
			crossThreadCollector.collect = async () => {
				collections++;
				return new Map(threadStatuses);
			};
		});

		beforeEach(() => {
			collections = 0;
			threadStatuses = [];
		});

		after(() => {
			delete crossThreadCollector.collect;
		});

		it('drains on a load failure only another thread recorded', async () => {
			threadStatuses = [
				['app.jsResource@main', entry('healthy')],
				['app.jsResource@worker-1', entry('healthy', { loadFailed: true })],
			];
			const result = await availability();
			assert.strictEqual(result?.status, 'Unavailable');
			assert.strictEqual(result.message, 'Failed to load: app.jsResource');
		});

		it('does not drain on another thread error that is not a load failure', async () => {
			threadStatuses = [
				['app.jsResource@worker-1', entry('error', { source: 'explicit' })],
				['app.jsResource@worker-2', entry('healthy')],
			];
			assert.strictEqual((await availability())?.status, 'Available');
		});

		it('serves the stored record without collecting when the setting is off', async () => {
			setDrain(undefined);
			threadStatuses = [['app.jsResource@worker-1', entry('error', { loadFailed: true })]];
			assert.strictEqual((await availability())?.status, 'Available');
			assert.strictEqual(collections, 0);
			const all = await status.get({});
			const records = [];
			for await (const record of all.systemStatus) records.push(record);
			assert.strictEqual(records.find((record) => record.id === 'availability')?.status, 'Available');
		});

		it("keeps an operator's Unavailable without collecting", async () => {
			await status.set({ id: 'availability', status: 'Unavailable' });
			assert.strictEqual((await availability())?.status, 'Unavailable');
			assert.strictEqual(collections, 0);
		});

		it('derives Unavailable when no availability record is stored', async () => {
			await status.clear({ id: 'availability' });
			assert.strictEqual((await availability())?.status, undefined);
			threadStatuses = [['app.jsResource@worker-1', entry('error', { loadFailed: true })]];
			assert.strictEqual((await freshAvailability())?.status, 'Unavailable');
		});

		it('collects once per TTL, and serves the last result while a stale one refreshes', async () => {
			threadStatuses = [['app.jsResource@worker-1', entry('error', { loadFailed: true })]];
			const reads = await Promise.all([availability(), availability(), availability()]);
			assert.deepStrictEqual(
				reads.map((record) => record?.status),
				['Unavailable', 'Unavailable', 'Unavailable']
			);
			threadStatuses = [];
			assert.strictEqual((await availability())?.status, 'Unavailable');
			assert.strictEqual(collections, 1);

			await delay(2100);
			assert.strictEqual((await availability())?.status, 'Unavailable', 'the stale result while refreshing');
			assert.strictEqual(collections, 2);
			await delay(0);
			assert.strictEqual((await availability())?.status, 'Available');
		});

		it('the no-id response derives availability from the same single collection', async () => {
			await status.set({ id: 'primary', status: 'testing' });
			threadStatuses = [['app.jsResource@worker-1', entry('error', { loadFailed: true })]];
			const all = await status.get({});
			assert.strictEqual(collections, 1);
			assert.strictEqual(all.componentStatus.find((component) => component.name === 'app.jsResource')?.status, 'error');
			const serialized = JSON.parse(JSON.stringify(all.systemStatus));
			assert.ok(Array.isArray(serialized));
			assert.strictEqual(serialized.find((record) => record.id === 'availability')?.status, 'Unavailable');
			assert.strictEqual(serialized.find((record) => record.id === 'primary')?.status, 'testing');
			await status.clear({ id: 'primary' });
		});
	});
});
