import { test } from 'node:test';
import assert from 'node:assert';
import { createServer } from 'node:http';
import {
	discardBody,
	githubHeaders,
	peerRevision,
	readGitHubText,
} from '../../integrationTests/resources/nested-relationship-docs/github-fixture-fetch.mjs';

async function withServer(handler, run) {
	const server = createServer(handler);
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	try {
		await run('http://127.0.0.1:' + server.address().port + '/fixture');
	} finally {
		server.closeAllConnections();
		await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	}
}

test('credentials are attached only to the exact GitHub API origin', () => {
	const token = 'test-token-not-a-credential';
	assert.strictEqual(
		githubHeaders('https://api.github.com/repos/HarperFast/harper', token).Authorization,
		'Bearer ' + token
	);
	for (const url of [
		'https://raw.githubusercontent.com/HarperFast/harper/main/file',
		'http://api.github.com/file',
		'https://api.github.com.example/file',
		'http://127.0.0.1/file',
	])
		assert.strictEqual(githubHeaders(url, token).Authorization, undefined);
	assert.strictEqual(githubHeaders('https://api.github.com/repos/HarperFast/harper').Authorization, undefined);
});

test('discarding an already errored response body preserves HTTP failure handling', async () => {
	const response = new Response(
		new ReadableStream({
			start(controller) {
				controller.error(new Error('discarded stream failed'));
			},
		}),
		{ status: 503 }
	);
	await assert.rejects(response.body.cancel(), /discarded stream failed/);
	await assert.doesNotReject(discardBody(response));
});

test('companion revisions fail closed for closed-unmerged or malformed peers', () => {
	const sha = 'a'.repeat(40);
	assert.strictEqual(peerRevision({ state: 'open', head: { sha } }), sha);
	assert.strictEqual(peerRevision({ state: 'closed', merged_at: '2026-10-19T00:00:00Z' }), 'main');
	assert.throws(() => peerRevision({ state: 'closed', head: { sha } }), /closed without merging/);
	assert.throws(() => peerRevision({ state: 'open', head: { sha: 'invalid' } }), /Invalid companion revision/);
});

test('transient HTTP failures retry and return the successful body without leaking a token', async () => {
	for (const status of [408, 429, 500, 503]) {
		let attempts = 0;
		await withServer(
			(request, response) => {
				assert.strictEqual(request.headers.authorization, undefined);
				response.writeHead(++attempts < 3 ? status : 200, { 'Retry-After': '0' });
				response.end(attempts < 3 ? 'temporary' : 'fixture bytes');
			},
			async (url) => {
				assert.strictEqual(await readGitHubText(url, { token: 'not-for-this-origin' }), 'fixture bytes');
				assert.strictEqual(attempts, 3);
			}
		);
	}
});

test('network disconnects retry within the same request budget', async () => {
	let attempts = 0;
	await withServer(
		(request, response) => {
			if (++attempts < 3) request.socket.destroy();
			else response.end('recovered');
		},
		async (url) => {
			assert.strictEqual(await readGitHubText(url), 'recovered');
			assert.strictEqual(attempts, 3);
		}
	);
});

test('permanent HTTP failures do not retry or expose response bodies', async () => {
	for (const status of [401, 403, 404]) {
		let attempts = 0;
		await withServer(
			(_request, response) => {
				attempts++;
				response.writeHead(status, { 'Retry-After': '0' });
				response.end('sensitive-response');
			},
			async (url) => {
				await assert.rejects(readGitHubText(url, { token: 'sensitive-token' }), (error) => {
					assert(error.message.includes('HTTP ' + status));
					assert(error.message.includes(url));
					assert(!/sensitive|Bearer|Authorization/.test(error.message));
					return true;
				});
				assert.strictEqual(attempts, 1);
			}
		);
	}
});

test('transient failures stop after three attempts', async () => {
	let attempts = 0;
	await withServer(
		(_request, response) => {
			attempts++;
			response.writeHead(503, { 'Retry-After': '0' });
			response.end('unavailable');
		},
		async (url) => {
			await assert.rejects(readGitHubText(url), /HTTP 503 after 3 attempt/);
			assert.strictEqual(attempts, 3);
		}
	);
});

test('Retry-After beyond the comparison wait budget fails rather than retrying early', async () => {
	let attempts = 0;
	await withServer(
		(_request, response) => {
			attempts++;
			response.writeHead(429, { 'Retry-After': '60' });
			response.end();
		},
		async (url) => {
			await assert.rejects(readGitHubText(url), /longer Retry-After/);
			assert.strictEqual(attempts, 1);
		}
	);
});

test('the shared comparison signal terminates a stalled request without retries', async () => {
	let attempts = 0;
	const controller = new AbortController();
	await withServer(
		() => {
			attempts++;
			controller.abort();
		},
		async (url) => {
			await assert.rejects(readGitHubText(url, { signal: controller.signal }), /network error or timeout/);
			assert.strictEqual(attempts, 1);
		}
	);
});
