'use strict';

const assert = require('node:assert');
const { checkPreviewReachable, probePreview } = require('#src/bin/previewReachability');
const { formatTeardown } = require('#src/bin/previewSetup');
const { planPreviewDeploy } = require('#src/bin/preview');

const URL = 'https://fix-cart.app.cluster.example.com/';
const failWith = (code, name) => async () => {
	throw Object.assign(new TypeError('fetch failed'), { name: name ?? 'TypeError', cause: { code } });
};
const answer =
	(status, body = '', headers = {}) =>
	async () =>
		new Response(body, { status, headers });

describe('preview reachability (harper#3042)', () => {
	it('counts any answer from the preview as reachable, a 404 from the application included', async () => {
		assert.deepStrictEqual(await probePreview(URL, answer(200)), { reachable: true, status: 200 });
		assert.strictEqual((await probePreview(URL, answer(404, 'not found', { server: 'harper' }))).reachable, true);
	});

	it('names a missing DNS record and a certificate that does not cover the host, without retrying either', async () => {
		const dns = await probePreview(URL, failWith('ENOTFOUND'));
		assert.strictEqual(dns.retry, false);
		assert.match(dns.reason, /fix-cart\.app\.cluster\.example\.com has no DNS record/);
		const certificate = await probePreview(URL, failWith('ERR_TLS_CERT_ALTNAME_INVALID'));
		assert.strictEqual(certificate.retry, false);
		assert.match(certificate.reason, /does not cover it .*wildcard at its next order or renewal/);
	});

	it("names the shared port's refusal of an isolated host, which means the proxy does not route to the preview", async () => {
		const refusal =
			'Service unavailable: fix-cart.app.cluster.example.com is served by an isolated application whose worker is not running';
		const outcome = await probePreview(URL, answer(503, refusal));
		assert.strictEqual(outcome.reachable, false);
		assert.match(outcome.reason, /reached Harper's shared port, not the preview's own worker/);
		assert.match(
			(await probePreview(URL, answer(404, '', { server: 'nginx/1.27' }))).reason,
			/answered 404 from nginx/
		);
		assert.match((await probePreview(URL, answer(502))).reason, /answered 502, not from the preview/);
	});

	it("counts the preview's own server error as an answer from the preview", async () => {
		assert.deepStrictEqual(await probePreview(URL, answer(500, 'boom')), { reachable: true, status: 500 });
	});

	it('retries what can still change, within the window, and reports the last outcome', async () => {
		let calls = 0;
		const flaky = async (...args) => (++calls < 3 ? failWith('ECONNREFUSED')(...args) : answer(200)(...args));
		assert.deepStrictEqual(await checkPreviewReachable(URL, { fetchImpl: flaky, windowMs: 1000, delayMs: 1 }), {
			reachable: true,
			status: 200,
		});
		calls = 0;
		const refused = async (...args) => (calls++, failWith('ECONNREFUSED')(...args));
		const outcome = await checkPreviewReachable(URL, { fetchImpl: refused, windowMs: 30, delayMs: 5 });
		assert.match(outcome.reason, /nothing accepted a connection .*ECONNREFUSED/);
		assert.ok(calls > 1, 'a refused connection is tried again');
		calls = 0;
		await checkPreviewReachable(URL, { fetchImpl: async (...args) => (calls++, failWith('ENOTFOUND')(...args)) });
		assert.strictEqual(calls, 1, 'a missing record is not');
	});

	it('contains a probe that throws, and stops reading a long body it does not need', async () => {
		const outcome = await checkPreviewReachable(URL, {
			fetchImpl: async () => {
				throw new Error('boom');
			},
			windowMs: 10,
			delayMs: 1,
		});
		assert.strictEqual(outcome.reachable, false);
		let pulled = 0;
		const endless = new ReadableStream({
			pull(controller) {
				pulled++;
				controller.enqueue(new Uint8Array(1024));
			},
		});
		const overloaded = await probePreview(URL, async () => new Response(endless, { status: 503 }));
		assert.deepStrictEqual(overloaded, { reachable: true, status: 503 });
		assert.ok(pulled < 10, `read ${pulled} chunks`);
	});

	it('keeps `check=` out of the deploy request', () => {
		const { request } = planPreviewDeploy({
			app: 'shop',
			pr: 1,
			branch: 'fix',
			domain: 'app.example.com',
			check: false,
		});
		assert.strictEqual(request.check, undefined);
	});

	it("reports teardown per preview and per node, a peer's failure included", () => {
		const text = formatTeardown({
			message: 'Disabled previews of shop',
			dropped: [
				{ project: 'shop-pr-1', node: 'a', componentRemoved: true },
				{ project: 'shop-pr-1', node: 'b', componentRemoved: false },
				{ project: 'shop-pr-1', node: 'c', error: 'unreachable' },
			],
			removed: ['user shop-ci-preview', 'role shop-ci-preview'],
			inProgress: ['shop-pr-2'],
		});
		assert.match(text, /shop-pr-1: a dropped\n {2}shop-pr-1: b did not hold it\n {2}shop-pr-1: c failed: unreachable/);
		assert.match(text, /Removed user shop-ci-preview, role shop-ci-preview\./);
		assert.match(text, /Still deploying when previews were revoked: shop-pr-2/);
	});
});
