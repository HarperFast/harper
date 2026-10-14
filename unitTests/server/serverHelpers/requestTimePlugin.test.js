'use strict';

const assert = require('node:assert');
const plugin = require('#src/server/serverHelpers/requestTimePlugin');
const analytics = require('#src/resources/analytics/write');
const { waitFor } = require('../../waitFor.js');

describe('request-time from the Fastify hook', () => {
	it('records request-time for a queued request and nothing for an unqueued one', async function () {
		this.timeout(15000);
		const hooks = {};
		await new Promise((resolve) => plugin({ addHook: (name, fn) => (hooks[name] = fn) }, {}, resolve));
		const seen = [];
		analytics.addAnalyticsListener((metrics) => {
			for (const entry of metrics) if (entry.metric === 'request-time' || entry.metric === 'duration') seen.push(entry);
		});
		analytics.setAnalyticsEnabled(true);
		const reply = (raw) => ({
			elapsedTime: 1.5,
			raw: { statusCode: 200 },
			request: { routeOptions: { config: { isOperation: true } } },
			getHeader: () => undefined,
			header: () => {},
		});
		const request = (receivedAt) => ({
			body: { operation: 'hook-probe' },
			raw: receivedAt === undefined ? {} : { receivedAt },
		});
		await hooks.onSend(request(performance.now() - 40), reply(), 'ok');
		await hooks.onSend(request(undefined), reply(), 'ok');
		await waitFor(() => seen.some((entry) => entry.metric === 'duration' && entry.path === 'hook-probe'), {
			timeout: 10000,
			message: 'the flush carried the probe',
		});
		const durations = seen.filter((entry) => entry.metric === 'duration' && entry.path === 'hook-probe');
		const requestTimes = seen.filter((entry) => entry.metric === 'request-time' && entry.path === 'hook-probe');
		assert.strictEqual(durations[0].count, 2, 'both calls recorded duration');
		assert.strictEqual(requestTimes.length, 1, JSON.stringify(seen));
		assert.strictEqual(requestTimes[0].count, 1, 'only the stamped call recorded request-time');
		assert.strictEqual(requestTimes[0].type, 'operation');
		assert.ok(requestTimes[0].mean >= 40, `request-time covers the wait before the hook: ${requestTimes[0].mean}`);
	});
});
