'use strict';

/**
 * The Bun and uWS adapters hand a request the middleware chain declined (`status: -1`) to legacy
 * Fastify and build their response headers from Fastify's reply. Node does not lose the chain's
 * headers on that path — it copies them onto the `ServerResponse` before emitting 'unhandled' — and
 * before #2418 the divergence was unreachable, because an unrecognized credential never survived
 * authentication. Deferral makes it reachable, so the identity floor authentication stamps on a
 * credential-dependent response (`Cache-Control: private, no-cache`, `Vary: Authorization, Cookie`
 * — #1565) has to survive both fallbacks.
 *
 * These drive the real adapters (`makeUwsHandler`, `bunDelegateToNodeServer`) against a stub Fastify
 * instance, not a re-implementation of their header assembly.
 */
const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const assert = require('node:assert');
const { Readable } = require('node:stream');

const {
	bunDelegateToNodeServer,
	httpServer,
	makeUwsHandler,
	registerFallbackServer,
	registerFastifyInstance,
} = require('#src/server/http');
const { Headers, mergeChainHeadersIntoFallback } = require('#src/server/serverHelpers/Headers');

const UWS_PORT = 19430;
const BUN_PORT = 19431;

/** The headers `security/auth.ts` stamps on a response produced under a (deferred) credential. */
function identityFloorHeaders() {
	return new Headers({ 'Cache-Control': 'private, no-cache', 'Vary': 'Authorization, Cookie' });
}

/** A stub Fastify whose `inject()` answers with the given status/headers/body. */
function fastifyReplying(statusCode, headers, body = 'ok') {
	return {
		inject: async () => ({
			statusCode,
			headers,
			stream: () => Readable.from([Buffer.from(body)]),
			raw: {},
		}),
	};
}

function uwsRequest(headers = {}) {
	return {
		method: 'GET',
		url: '/wp-json/wc/v3/products',
		pathname: '/wp-json/wc/v3/products',
		headers: { asObject: headers, get: (name) => headers[name.toLowerCase()] },
		body: undefined,
	};
}

function bunWebRequest() {
	return new globalThis.Request('http://localhost/wp-json/wc/v3/products', {
		method: 'GET',
		headers: { authorization: 'Basic d29yZHByZXNzOnNlY3JldA==' },
	});
}

describe('legacy Fastify fallback preserves the chain cache floor', () => {
	describe('uWS adapter', () => {
		/** Registers a chain on UWS_PORT that declines with `chainHeaders`, and returns the handler. */
		function handlerDecliningWith(chainHeaders, fastify) {
			httpServer(() => ({ status: -1, headers: chainHeaders, body: 'Not found' }), {
				port: UWS_PORT,
				name: `uwsFallbackDecline${UWS_PORT}`,
			});
			registerFastifyInstance(UWS_PORT, fastify);
			return makeUwsHandler(UWS_PORT, false);
		}

		it('carries Cache-Control and Vary from the chain onto the Fastify response', async () => {
			const handle = handlerDecliningWith(
				identityFloorHeaders(),
				fastifyReplying(200, { 'content-type': 'application/json' }, '{"products":[]}')
			);

			const response = await handle(uwsRequest({ authorization: 'Basic d29yZHByZXNzOnNlY3JldA==' }));

			assert.strictEqual(response.status, 200);
			assert.strictEqual(response.headers.get('Cache-Control'), 'private, no-cache');
			assert.strictEqual(response.headers.get('Vary'), 'Authorization, Cookie');
			// Fastify's own headers are untouched.
			assert.strictEqual(response.headers.get('content-type'), 'application/json');
		});

		it('unions Vary rather than letting either side win outright', async () => {
			const handle = handlerDecliningWith(
				identityFloorHeaders(),
				fastifyReplying(200, { 'vary': 'Accept-Encoding', 'content-type': 'text/plain' })
			);

			const response = await handle(uwsRequest());

			const vary = response.headers.get('Vary');
			for (const token of ['Accept-Encoding', 'Authorization', 'Cookie']) {
				assert.ok(vary.includes(token), `Vary should include ${token}, got '${vary}'`);
			}
		});

		it('re-applies the private scope when Fastify returns a cacheable response', async () => {
			const handle = handlerDecliningWith(
				identityFloorHeaders(),
				fastifyReplying(200, { 'cache-control': 'max-age=600', 'content-type': 'text/html' })
			);

			const response = await handle(uwsRequest());

			assert.strictEqual(response.headers.get('Cache-Control'), 'max-age=600, private');
		});

		it('honours an explicit shared-cache opt-in from the final response', async () => {
			const handle = handlerDecliningWith(
				identityFloorHeaders(),
				fastifyReplying(200, { 'cache-control': 'public, max-age=600' })
			);

			const response = await handle(uwsRequest());

			assert.strictEqual(response.headers.get('Cache-Control'), 'public, max-age=600');
		});

		it('keeps the floor on the 404 it produces when no fallback is registered', async () => {
			httpServer(() => ({ status: -1, headers: identityFloorHeaders(), body: 'Not found' }), {
				port: UWS_PORT + 5,
				name: `uwsFallbackNoFastify${UWS_PORT}`,
			});
			const handle = makeUwsHandler(UWS_PORT + 5, false);

			const response = await handle(uwsRequest());

			assert.strictEqual(response.status, 404);
			assert.strictEqual(response.headers.get('Cache-Control'), 'private, no-cache');
			assert.ok(response.headers.get('Vary').includes('Authorization'));
		});
	});

	describe('Bun adapter', () => {
		it('carries the chain cache floor onto the delegated Fastify response', async () => {
			const nodeServer = { bunFallback: 'uses reference identity' };
			registerFallbackServer(BUN_PORT, nodeServer);
			registerFastifyInstance(BUN_PORT, fastifyReplying(200, { 'content-type': 'application/json' }, '{}'));

			const response = await bunDelegateToNodeServer(
				nodeServer,
				bunWebRequest(),
				{ user: undefined },
				identityFloorHeaders()
			);

			assert.strictEqual(response.status, 200);
			assert.strictEqual(response.headers.get('cache-control'), 'private, no-cache');
			assert.strictEqual(response.headers.get('vary'), 'Authorization, Cookie');
			assert.strictEqual(response.headers.get('content-type'), 'application/json');
		});

		it('unions Vary and re-applies the private scope over a cacheable Fastify response', async () => {
			const nodeServer = { bunFallback: 'second instance' };
			registerFallbackServer(BUN_PORT + 1, nodeServer);
			registerFastifyInstance(
				BUN_PORT + 1,
				fastifyReplying(200, { 'vary': 'Accept-Encoding', 'cache-control': 'max-age=600' })
			);

			const response = await bunDelegateToNodeServer(
				nodeServer,
				bunWebRequest(),
				{ user: undefined },
				identityFloorHeaders()
			);

			assert.strictEqual(response.headers.get('cache-control'), 'max-age=600, private');
			const vary = response.headers.get('vary');
			for (const token of ['Accept-Encoding', 'Authorization', 'Cookie']) {
				assert.ok(vary.includes(token), `Vary should include ${token}, got '${vary}'`);
			}
		});

		it('leaves a response with no chain headers exactly as Fastify produced it', async () => {
			const nodeServer = { bunFallback: 'third instance' };
			registerFallbackServer(BUN_PORT + 2, nodeServer);
			registerFastifyInstance(BUN_PORT + 2, fastifyReplying(200, { 'cache-control': 'max-age=600' }));

			const response = await bunDelegateToNodeServer(nodeServer, bunWebRequest(), { user: undefined }, new Headers());

			assert.strictEqual(response.headers.get('cache-control'), 'max-age=600');
			assert.strictEqual(response.headers.get('vary'), null);
		});
	});

	describe('mergeChainHeadersIntoFallback', () => {
		it('never lets the chain overwrite a header the final response set', () => {
			const chain = new Headers({ 'Content-Type': 'text/plain', 'X-From-Chain': 'yes' });
			const final = new Headers({ 'Content-Type': 'application/json' });

			mergeChainHeadersIntoFallback(chain, final);

			assert.strictEqual(final.get('Content-Type'), 'application/json');
			assert.strictEqual(final.get('X-From-Chain'), 'yes');
		});

		it('keeps a multi-valued Set-Cookie from the chain as separate values', () => {
			const chain = new Headers();
			chain.set('Set-Cookie', ['a=1; Path=/', 'b=2; Path=/']);
			const final = new Headers();

			mergeChainHeadersIntoFallback(chain, final);

			assert.deepStrictEqual(final.get('Set-Cookie'), ['a=1; Path=/', 'b=2; Path=/']);
		});

		it('does not duplicate a Vary token the final response already declares', () => {
			const chain = new Headers({ Vary: 'Authorization, Cookie' });
			const final = new Headers({ Vary: 'Authorization' });

			mergeChainHeadersIntoFallback(chain, final);

			assert.strictEqual(final.get('Vary'), 'Authorization, Cookie');
		});

		it('leaves an existing private scope alone rather than appending a second one', () => {
			const chain = new Headers({ 'Cache-Control': 'private, no-cache' });
			const final = new Headers({ 'Cache-Control': 'no-store' });

			mergeChainHeadersIntoFallback(chain, final);

			assert.strictEqual(final.get('Cache-Control'), 'no-store');
		});

		it('is a no-op when the chain produced no headers at all', () => {
			const final = new Headers({ 'Cache-Control': 'max-age=60' });

			mergeChainHeadersIntoFallback(undefined, final);

			assert.strictEqual(final.get('Cache-Control'), 'max-age=60');
		});
	});
});
