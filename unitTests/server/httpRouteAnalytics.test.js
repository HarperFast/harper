'use strict';

const assert = require('node:assert');
const http = require('node:http');
const { Readable } = require('node:stream');
const { setupTestDBPath } = require('../testUtils');
const { httpServer, makeUwsHandler } = require('#src/server/http');
const analytics = require('#src/resources/analytics/write');
const { waitFor } = require('../waitFor');

const ROUTE_PREFIX = 'route-analytics-';

function get(baseUrl, urlPath) {
	return new Promise((resolve, reject) => {
		const request = http.get(`${baseUrl}${urlPath}`, { agent: false }, (response) => {
			response.resume();
			response.on('end', () => resolve(response.statusCode));
		});
		request.on('error', reject);
	});
}

describe('HTTP request analytics per route', function () {
	this.timeout(60_000);
	let server;
	let baseUrl;
	let wasEnabled;
	let removeListener;
	// summed across reports: a run can straddle a flush
	const totals = new Map();
	const gate = { started: false, opened: undefined };
	const total = (metric, path, method = 'GET', type) => totals.get(`${metric}|${path}|${method}|${type}`);

	before(async () => {
		setupTestDBPath();
		wasEnabled = analytics.checkAnalyticsEnabled(false);
		analytics.setAnalyticsEnabled(true);
		removeListener = analytics.addAnalyticsListener((metrics) => {
			for (const entry of metrics) {
				if (typeof entry.path !== 'string' || !entry.path.startsWith(ROUTE_PREFIX)) continue;
				const key = `${entry.metric}|${entry.path}|${entry.method}|${entry.type}`;
				const sum = totals.get(key) ?? { count: 0, total: 0, valueTotal: 0 };
				sum.count += entry.count;
				if (entry.total !== undefined) sum.total += entry.total;
				if (entry.mean !== undefined) sum.valueTotal += entry.mean * entry.count;
				totals.set(key, sum);
			}
		});
		const [created] = httpServer(
			(request) => {
				const url = new URL(request.url, 'http://localhost');
				request.handlerPath = ROUTE_PREFIX + (url.searchParams.get('route') ?? 'main');
				const status = Number(url.searchParams.get('status') ?? 200);
				const cache = url.searchParams.get('cache');
				if (url.searchParams.has('stream')) return { status, body: Readable.from(['abc', 'defg']) };
				if (url.searchParams.has('gated')) {
					gate.started = true;
					// handlesHeaders leaves the head unwritten when recorders are chosen, which the close-path test needs
					return {
						status,
						handlesHeaders: true,
						body: Readable.from(
							(async function* () {
								await gate.opened;
								yield 'abcde';
							})()
						),
					};
				}
				return { status, body: 'ok', wasCacheMiss: cache === null ? undefined : cache === 'miss' };
			},
			{ port: 19700, name: 'routeAnalyticsUnit' }
		);
		server = created;
		await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
		baseUrl = `http://127.0.0.1:${server.address().port}`;
	});

	after(() => {
		removeListener?.();
		if (wasEnabled !== undefined) analytics.setAnalyticsEnabled(wasEnabled);
		server?.closeAllConnections();
		server?.close();
	});

	it('records every status, cache type and outcome of a route into its own action', async () => {
		const route = ROUTE_PREFIX + 'statuses';
		const statuses = Array.from({ length: 40 }, (_, i) => 200 + i).concat([400, 404, 404, 503]);
		for (const status of statuses) assert.strictEqual(await get(baseUrl, `/?route=statuses&status=${status}`), status);
		for (const cache of ['miss', 'hit', 'hit']) await get(baseUrl, `/?route=statuses&cache=${cache}`);
		await waitFor(() => total('duration', route, 'GET', 'cache-hit')?.count === 2, {
			timeout: 10_000,
			message: 'the cache-hit durations were reported',
		});
		await waitFor(() => total('success', route)?.count === statuses.length + 3, { timeout: 10_000 });
		for (const status of new Set(statuses)) {
			const expected = statuses.filter((candidate) => candidate === status).length + (status === 200 ? 3 : 0);
			assert.strictEqual(total('response_' + status, route)?.count, expected, `response_${status}`);
		}
		assert.deepStrictEqual(
			{ count: total('success', route).count, total: total('success', route).total },
			{ count: statuses.length + 3, total: statuses.length + 3 - 4 }
		);
		assert.strictEqual(total('duration', route).count, statuses.length);
		assert.strictEqual(total('duration', route, 'GET', 'cache-miss').count, 1);
	});

	it("records a streamed body's transfer and bytes under its route", async () => {
		const route = ROUTE_PREFIX + 'stream';
		for (let i = 0; i < 3; i++) await get(baseUrl, '/?route=stream&stream=1');
		await waitFor(() => total('bytes-sent', route)?.count === 3, { timeout: 10_000, message: 'bytes-sent reported' });
		assert.strictEqual(total('bytes-sent', route).valueTotal, 3 * 7);
		await waitFor(() => total('transfer', route)?.count === 3, { timeout: 10_000, message: 'transfer reported' });
	});

	it('records a uWS request through the same recorders', async () => {
		const route = ROUTE_PREFIX + 'uws';
		const handle = makeUwsHandler(19700, false);
		const statuses = [200, 200, 400, 404];
		for (const status of statuses)
			await handle({ method: 'GET', url: `/?route=uws&status=${status}`, headers: new Headers(), isAborted: false });
		await waitFor(() => total('success', route)?.count === statuses.length, {
			timeout: 10_000,
			message: 'the uWS outcomes were reported',
		});
		assert.strictEqual(total('success', route).total, 2);
		assert.strictEqual(total('response_200', route).count, 2);
		assert.strictEqual(total('response_400', route).count, 1);
		assert.strictEqual(total('duration', route).count, statuses.length);
		await handle({ method: 'PURGE', url: '/?route=uws&status=200', headers: new Headers(), isAborted: false });
		await waitFor(() => total('success', route, 'PURGE')?.count === 1, { timeout: 10_000, message: 'PURGE reported' });
	});

	it('records a stream that began with analytics off, and its outcome, once analytics is on when it ends', async () => {
		const route = ROUTE_PREFIX + 'reselect';
		let open;
		gate.started = false;
		gate.opened = new Promise((resolve) => (open = resolve));
		analytics.setAnalyticsEnabled(false);
		const response = get(baseUrl, '/?route=reselect&gated=1');
		await waitFor(() => gate.started);
		analytics.setAnalyticsEnabled(true);
		open();
		assert.strictEqual(await response, 200);
		await waitFor(() => total('bytes-sent', route)?.count === 1 && total('transfer', route)?.count === 1, {
			timeout: 10_000,
			message: 'the stream was recorded',
		});
		assert.strictEqual(total('bytes-sent', route).valueTotal, 5);
		await waitFor(() => total('response_200', route)?.count === 1 && total('success', route)?.count === 1, {
			timeout: 10_000,
			message: 'the outcome was recorded on close',
		});
	});

	it('records a route past the cap on how many keep recorders', async () => {
		const routes = Array.from({ length: 1005 }, (_, i) => 'many-' + i);
		for (const route of routes) await get(baseUrl, `/?route=${route}`);
		for (const route of [routes[0], routes.at(-1)])
			await waitFor(() => total('response_200', ROUTE_PREFIX + route)?.count === 1, {
				timeout: 10_000,
				message: `${route} was reported`,
			});
	});
});
