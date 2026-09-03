'use strict';

/**
 * All three adapters hand a request the middleware chain declined (`status: -1`) to legacy Fastify.
 * Bun and uWS build their response headers from Fastify's reply; Node hands Fastify the same
 * `ServerResponse` the chain's headers were copied onto, so a Fastify route that sets `Cache-Control`
 * or `Vary` replaces them outright. The identity floor authentication stamps on a credential-dependent
 * response (`Cache-Control: private, no-cache`, `Vary: Authorization, Cookie` — #1565) has to survive
 * all three.
 *
 * These drive the real adapters (`makeUwsHandler`, `bunDelegateToNodeServer`,
 * `bridgeChainHeadersToNodeResponse`) against a stub Fastify instance for the first two and a real
 * Fastify app over a real `http.Server` for Node, not a re-implementation of their header assembly.
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
const {
	bridgeChainHeadersToNodeResponse,
	Headers,
	mergeChainHeadersIntoFallback,
} = require('#src/server/serverHelpers/Headers');
const http = require('node:http');
const Fastify = require('fastify');

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

	describe('Node adapter', () => {
		/**
		 * The production shape of `server/http.ts`'s `status === -1` branch: the chain's headers go onto
		 * the `ServerResponse`, then legacy Fastify writes the response through that same object.
		 */
		async function requestThroughFastify(chainHeaders, defineRoutes) {
			const fastify = Fastify();
			defineRoutes(fastify);
			await fastify.ready();
			const server = http.createServer((nodeRequest, nodeResponse) => {
				bridgeChainHeadersToNodeResponse(chainHeaders, nodeResponse);
				fastify.routing(nodeRequest, nodeResponse);
			});
			await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
			try {
				const { port } = server.address();
				return await new Promise((resolve, reject) => {
					const request = http.get({ host: '127.0.0.1', port, path: '/wp-json/wc/v3/products' }, (response) => {
						response.resume();
						response.on('end', () => resolve(response));
					});
					request.on('error', reject);
				});
			} finally {
				server.close();
				await fastify.close();
			}
		}

		it('re-applies the private scope over a Fastify route that replaced Cache-Control', async () => {
			const response = await requestThroughFastify(identityFloorHeaders(), (fastify) => {
				fastify.get('/wp-json/wc/v3/products', (_request, reply) =>
					reply.header('Cache-Control', 'max-age=600, must-revalidate').send('{}')
				);
			});

			assert.strictEqual(response.headers['cache-control'], 'max-age=600, must-revalidate, private');
		});

		it('unions Vary with a Fastify route that replaced it', async () => {
			const response = await requestThroughFastify(identityFloorHeaders(), (fastify) => {
				fastify.get('/wp-json/wc/v3/products', (_request, reply) => reply.header('Vary', 'Accept-Encoding').send('{}'));
			});

			for (const token of ['Accept-Encoding', 'Authorization', 'Cookie']) {
				assert.ok(
					response.headers.vary.includes(token),
					`Vary should include ${token}, got '${response.headers.vary}'`
				);
			}
		});

		it('keeps the floor intact when the Fastify route sets neither header', async () => {
			const response = await requestThroughFastify(identityFloorHeaders(), (fastify) => {
				fastify.get('/wp-json/wc/v3/products', (_request, reply) => reply.send('{}'));
			});

			assert.strictEqual(response.headers['cache-control'], 'private, no-cache');
			assert.strictEqual(response.headers.vary, 'Authorization, Cookie');
		});

		it("honours a Fastify route's explicit shared-cache opt-in", async () => {
			const response = await requestThroughFastify(identityFloorHeaders(), (fastify) => {
				fastify.get('/wp-json/wc/v3/products', (_request, reply) =>
					reply.header('Cache-Control', 'public, max-age=600').send('{}')
				);
			});

			assert.strictEqual(response.headers['cache-control'], 'public, max-age=600');
		});

		it('carries the chain headers Fastify did not set, without overriding those it did', async () => {
			const chainHeaders = identityFloorHeaders();
			chainHeaders.set('Access-Control-Allow-Origin', 'https://shop.example');
			const response = await requestThroughFastify(chainHeaders, (fastify) => {
				fastify.get('/wp-json/wc/v3/products', (_request, reply) =>
					reply.header('Content-Type', 'application/json').send('{}')
				);
			});

			assert.strictEqual(response.headers['access-control-allow-origin'], 'https://shop.example');
			assert.ok(response.headers['content-type'].startsWith('application/json'));
		});

		it('reconciles a response written without an explicit writeHead', async () => {
			// Node generates headers implicitly through `writeHead` on `end()`, so a fallback that never
			// calls it explicitly still has to pass through the same policy.
			const chainHeaders = identityFloorHeaders();
			const server = http.createServer((nodeRequest, nodeResponse) => {
				bridgeChainHeadersToNodeResponse(chainHeaders, nodeResponse);
				nodeResponse.setHeader('Cache-Control', 'max-age=600');
				nodeResponse.end('{}');
			});
			await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
			try {
				const { port } = server.address();
				const response = await new Promise((resolve, reject) => {
					http
						.get({ host: '127.0.0.1', port, path: '/' }, (res) => {
							res.resume();
							res.on('end', () => resolve(res));
						})
						.on('error', reject);
				});

				assert.strictEqual(response.headers['cache-control'], 'max-age=600, private');
			} finally {
				server.close();
			}
		});

		it('leaves a response alone when the chain produced no headers', async () => {
			const response = await requestThroughFastify(new Headers(), (fastify) => {
				fastify.get('/wp-json/wc/v3/products', (_request, reply) =>
					reply.header('Cache-Control', 'max-age=600').send('{}')
				);
			});

			assert.strictEqual(response.headers['cache-control'], 'max-age=600');
			assert.strictEqual(response.headers.vary, undefined);
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
