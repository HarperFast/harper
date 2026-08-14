'use strict';

const assert = require('node:assert');
const { workloadIdentityAvailable, exchangeWorkloadIdentityForToken } = require('#src/bin/workloadIdentity');
const commonUtilsModule = require('#src/utility/common_utils');

const REQUEST_URL = 'https://pipelines.actions.githubusercontent.com/abc/idtoken?api-version=2.0';
const REQUEST_TOKEN = 'runner-request-token';
const AUDIENCE = 'https://my-instance.harperdb.io:9925/';

describe('workloadIdentity', () => {
	let originalFetch;
	let originalHttpRequest;
	let originalEnv;
	let originalConsoleError;
	let fetchCalls;
	let operationCalls;
	let stderr;

	before(() => {
		originalFetch = globalThis.fetch;
		originalHttpRequest = commonUtilsModule.httpRequest;
		originalConsoleError = console.error;
	});

	after(() => {
		globalThis.fetch = originalFetch;
		commonUtilsModule.httpRequest = originalHttpRequest;
		console.error = originalConsoleError;
	});

	beforeEach(() => {
		originalEnv = {
			url: process.env.ACTIONS_ID_TOKEN_REQUEST_URL,
			token: process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
		};
		process.env.ACTIONS_ID_TOKEN_REQUEST_URL = REQUEST_URL;
		process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = REQUEST_TOKEN;

		fetchCalls = [];
		operationCalls = [];
		stderr = [];
		console.error = (message) => stderr.push(String(message));

		globalThis.fetch = async (url, init) => {
			fetchCalls.push({ url: new URL(String(url)), init });
			return new Response(JSON.stringify({ value: 'identity.token.value' }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			});
		};
		commonUtilsModule.httpRequest = async (options, body) => {
			operationCalls.push({ options, body });
			return {
				statusCode: 200,
				body: JSON.stringify({
					operation_token: 'minted-operation-token',
					username: 'ci-deploy',
					policy: 'my-app-prod',
					expires_in: 3600,
				}),
			};
		};
	});

	afterEach(() => {
		if (originalEnv.url === undefined) delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
		else process.env.ACTIONS_ID_TOKEN_REQUEST_URL = originalEnv.url;
		if (originalEnv.token === undefined) delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
		else process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = originalEnv.token;
	});

	describe('workloadIdentityAvailable', () => {
		it('is true when the runner offers an identity token', () => {
			assert.strictEqual(workloadIdentityAvailable(), true);
		});

		// GitHub sets both together; either one missing means the workflow did not grant
		// `id-token: write`, which is a configuration answer rather than something to report.
		it('is false unless both variables are present', () => {
			delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
			assert.strictEqual(workloadIdentityAvailable(), false);
			process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = REQUEST_TOKEN;
			delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
			assert.strictEqual(workloadIdentityAvailable(), false);
		});
	});

	describe('exchangeWorkloadIdentityForToken', () => {
		it('returns an operation token', async () => {
			const token = await exchangeWorkloadIdentityForToken({ headers: {} }, AUDIENCE);
			assert.strictEqual(token, 'minted-operation-token');
		});

		// The audience is what binds the token to this instance; GitHub's default is shared by every
		// repository under an owner, so it must be set explicitly on the request.
		it('requests the token for this instance as the audience', async () => {
			await exchangeWorkloadIdentityForToken({ headers: {} }, AUDIENCE);
			assert.strictEqual(fetchCalls.length, 1);
			assert.strictEqual(fetchCalls[0].url.searchParams.get('audience'), AUDIENCE);
			// The api-version already on the URL must survive.
			assert.strictEqual(fetchCalls[0].url.searchParams.get('api-version'), '2.0');
			assert.strictEqual(fetchCalls[0].init.headers.authorization, `Bearer ${REQUEST_TOKEN}`);
		});

		it('sends the identity token to exchange_oidc_token', async () => {
			await exchangeWorkloadIdentityForToken({ headers: {} }, AUDIENCE);
			assert.strictEqual(operationCalls.length, 1);
			assert.deepStrictEqual(operationCalls[0].body, {
				operation: 'exchange_oidc_token',
				token: 'identity.token.value',
			});
		});

		it('names the policy and user it authenticated as', async () => {
			await exchangeWorkloadIdentityForToken({ headers: {} }, AUDIENCE);
			assert.ok(
				stderr.some((line) => line.includes('ci-deploy') && line.includes('my-app-prod')),
				`expected the identity to be reported; got ${JSON.stringify(stderr)}`
			);
		});

		it('does nothing on a runner with no identity to offer', async () => {
			delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
			assert.strictEqual(await exchangeWorkloadIdentityForToken({ headers: {} }, AUDIENCE), undefined);
			assert.strictEqual(fetchCalls.length, 0);
			assert.strictEqual(operationCalls.length, 0);
		});

		it('gives up without exchanging when the provider refuses a token', async () => {
			globalThis.fetch = async () => new Response('forbidden', { status: 403 });
			assert.strictEqual(await exchangeWorkloadIdentityForToken({ headers: {} }, AUDIENCE), undefined);
			assert.strictEqual(operationCalls.length, 0, 'nothing to exchange');
			assert.ok(stderr.some((line) => line.includes('403')));
		});

		it('gives up when the provider returns no token value', async () => {
			globalThis.fetch = async () =>
				new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
			assert.strictEqual(await exchangeWorkloadIdentityForToken({ headers: {} }, AUDIENCE), undefined);
			assert.strictEqual(operationCalls.length, 0);
		});

		// The server deliberately does not say which check failed, so the CLI has to point at what the
		// operator can inspect — otherwise this surfaces as a bare 401 later.
		it('explains a rejected exchange', async () => {
			commonUtilsModule.httpRequest = async () => ({
				statusCode: 401,
				body: '{"error":"Identity token was rejected"}',
			});
			assert.strictEqual(await exchangeWorkloadIdentityForToken({ headers: {} }, AUDIENCE), undefined);
			assert.ok(
				stderr.some((line) => line.includes('list_oidc_trust')),
				`expected actionable guidance; got ${JSON.stringify(stderr)}`
			);
		});

		it('returns undefined when the exchange yields no token', async () => {
			commonUtilsModule.httpRequest = async () => ({ statusCode: 200, body: '{}' });
			assert.strictEqual(await exchangeWorkloadIdentityForToken({ headers: {} }, AUDIENCE), undefined);
		});

		it('survives a transport failure', async () => {
			commonUtilsModule.httpRequest = async () => {
				throw new Error('socket hang up');
			};
			assert.strictEqual(await exchangeWorkloadIdentityForToken({ headers: {} }, AUDIENCE), undefined);
			assert.ok(stderr.some((line) => line.includes('socket hang up')));
		});
	});
});
