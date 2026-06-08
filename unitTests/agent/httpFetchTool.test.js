'use strict';

const assert = require('node:assert/strict');
const { httpFetchTool } = require('#src/agent/tools/httpFetchTool');

const ctx = { sessionId: 'sess', scopes: { componentsRoot: '/tmp', logDir: '/tmp', configDir: '/tmp' } };

describe('agent/httpFetchTool', () => {
	it('rejects non-http(s) URLs', async () => {
		await assert.rejects(httpFetchTool.handler({ url: 'file:///etc/passwd' }, ctx), /http\(s\) URL/);
	});

	it('blocks the AWS/GCP cloud-metadata IP', async () => {
		await assert.rejects(
			httpFetchTool.handler({ url: 'http://169.254.169.254/latest/meta-data/' }, ctx),
			/metadata-host policy|link-local policy/
		);
	});

	it('blocks the GCP metadata hostname', async () => {
		await assert.rejects(
			httpFetchTool.handler({ url: 'http://metadata.google.internal/computeMetadata/v1/' }, ctx),
			/metadata-host policy/
		);
	});

	it('blocks the IPv4 link-local range beyond the canonical IMDS IP', async () => {
		await assert.rejects(httpFetchTool.handler({ url: 'http://169.254.42.42/probe' }, ctx), /link-local policy/);
	});

	it('does not block localhost (operators self-test against their own server)', async () => {
		// Use port 1 so the request fails fast with a connection error rather than hitting any
		// real service. We only care that the URL passes the policy check.
		await assert.rejects(
			httpFetchTool.handler({ url: 'http://127.0.0.1:1/', timeoutMs: 500 }, ctx),
			(err) => !/metadata-host policy|link-local policy/.test(err.message)
		);
	});

	it('rejects malformed URLs with a clear error', async () => {
		await assert.rejects(httpFetchTool.handler({ url: 'http://[invalid' }, ctx), /could not parse URL/);
	});
});
