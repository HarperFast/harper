'use strict';

const fastify = require('fastify');
const request_time_plugin = require('#js/server/serverHelpers/requestTimePlugin');
const chai = require('chai');
const { expect } = chai;

function build(opts = {}) {
	const app = fastify(opts);
	app.register(request_time_plugin);
	app.get('/', async function (_request, _reply) {
		return { hello: 'world' };
	});

	return app;
}

let app = build();

describe('test requestTimePlugin', () => {
	it('test Server-Timing header', async () => {
		const response = await app.inject({
			method: 'GET',
			url: '/',
		});

		expect(response.headers).to.have.property('server-timing');
		expect(+response.headers['server-timing'].match(/dur=([\d.]+)/)[1]).to.be.gt(0);
	});
});

const assert = require('node:assert');
const plugin = require('#js/server/serverHelpers/requestTimePlugin');
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
