const assert = require('node:assert');
const { Readable } = require('node:stream');
const { EventEmitter } = require('node:events');
const { createHarperHttpHandler } = require('#src/components/mcp/adapters/harperHttp');
const { credentialRejectionError, deferCredentialRejection } = require('#src/security/deferredAuthentication');
const { _setSessionTableForTest, loadSession } = require('#src/components/mcp/session');
const { Headers } = require('#src/server/serverHelpers/Headers');
const env = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');

function makeFakeTable() {
	const store = new Map();
	return {
		async put(record) {
			store.set(record.id, { ...record });
		},
		async patch(record) {
			store.set(record.id, { ...store.get(record.id), ...record });
		},
		async get(id) {
			const r = store.get(id);
			return r ? { ...r } : undefined;
		},
		async delete(id) {
			store.delete(id);
		},
	};
}

function makeHeaders(init = {}) {
	const h = new Headers();
	for (const [k, v] of Object.entries(init)) h.set(k, v);
	return h;
}

function bodyStream(text) {
	return Readable.from([Buffer.from(text, 'utf8')]);
}

// Mirrors server/serverHelpers/Request.ts `RequestBody`: exposes ONLY the
// stream event API (`.on`), NOT `Symbol.asyncIterator`. The real wrapper is
// what production hands the adapter; a `for await` over it threw
// `TypeError: body is not async iterable` and 500'd every request (#1317).
function eventOnlyBody(text) {
	const emitter = new EventEmitter();
	const wrapper = {
		on(event, listener) {
			emitter.on(event, listener);
			return wrapper;
		},
	};
	queueMicrotask(() => {
		emitter.emit('data', Buffer.from(text, 'utf8'));
		emitter.emit('end');
	});
	return wrapper;
}

// A body that emits 'close' without ever emitting 'end' or 'error' — what
// IncomingMessage does on a premature client disconnect. Before the 'close'
// handler in readBody, this hung the read promise forever and leaked the
// buffered chunks (#1320 review).
function abortedBody(partialText) {
	const emitter = new EventEmitter();
	const wrapper = {
		on(event, listener) {
			emitter.on(event, listener);
			return wrapper;
		},
	};
	queueMicrotask(() => {
		if (partialText) emitter.emit('data', Buffer.from(partialText, 'utf8'));
		emitter.emit('close');
	});
	return wrapper;
}

async function next() {
	return undefined;
}

describe('mcp/adapters/harperHttp', () => {
	beforeEach(() => _setSessionTableForTest(makeFakeTable()));
	afterEach(() => _setSessionTableForTest(undefined));

	it('handles an initialize request and returns 200 + JSON body + Mcp-Session-Id', async () => {
		const handler = createHarperHttpHandler('application');
		const result = await handler(
			{
				method: 'POST',
				headers: makeHeaders({ 'content-type': 'application/json' }),
				body: bodyStream(
					JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
				),
				user: { username: 'alice' },
			},
			next
		);
		assert.equal(result.status, 200);
		assert.match(result.headers['Mcp-Session-Id'], /^[0-9a-f-]{36}$/);
		assert.equal(result.headers['Content-Type'], 'application/json');
		const parsed = JSON.parse(result.body);
		assert.equal(parsed.id, 1);
		assert.equal(parsed.result.protocolVersion, '2025-06-18');
	});

	describe('deferred credential rejection (#2418)', () => {
		function deferredRequest(overrides = {}) {
			const request = {
				method: 'POST',
				headers: makeHeaders({ 'content-type': 'application/json' }),
				body: bodyStream(
					JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
				),
				...overrides,
			};
			deferCredentialRejection(request, credentialRejectionError('Login failed', 401), 'Basic');
			return request;
		}

		it('answers 401 instead of creating an anonymous session', async () => {
			const handler = createHarperHttpHandler('application');

			const result = await handler(deferredRequest(), next);

			assert.equal(result.status, 401);
			assert.deepEqual(JSON.parse(result.body.toString()), { error: 'Login failed' });
			assert.equal(result.headers['Mcp-Session-Id'], undefined);
		});

		it('does not read the request body before rejecting', async () => {
			const handler = createHarperHttpHandler('application');
			let bodyRead = false;
			const body = {
				on(event, listener) {
					if (event === 'data') bodyRead = true;
					if (event === 'end') queueMicrotask(listener);
					return body;
				},
			};

			await handler(deferredRequest({ body }), next);

			assert.equal(bodyRead, false, 'the body must not be consumed once the credential is rejected');
		});

		it('still serves a request with no deferred rejection', async () => {
			const handler = createHarperHttpHandler('application');
			const request = {
				method: 'POST',
				headers: makeHeaders({ 'content-type': 'application/json' }),
				body: bodyStream(
					JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
				),
				user: { username: 'alice' },
			};

			const result = await handler(request, next);

			assert.equal(result.status, 200);
			assert.match(result.headers['Mcp-Session-Id'], /^[0-9a-f-]{36}$/);
		});

		it('still lets a WebSocket upgrade through to the next handler', async () => {
			const handler = createHarperHttpHandler('application');

			const out = await handler(deferredRequest({ method: 'GET', isWebSocket: true }), () => 'next-handler-result');

			assert.equal(out, 'next-handler-result');
		});
	});

	it('hands off WebSocket-upgrade requests to the next handler', async () => {
		const handler = createHarperHttpHandler('application');
		const out = await handler(
			{
				method: 'GET',
				headers: makeHeaders(),
				isWebSocket: true,
				user: { username: 'alice' },
			},
			() => 'next-handler-result'
		);
		assert.equal(out, 'next-handler-result');
	});

	it('reads a body exposing only the stream event API, no async iterator (#1317 regression)', async () => {
		const handler = createHarperHttpHandler('application');
		const result = await handler(
			{
				method: 'POST',
				headers: makeHeaders({ 'content-type': 'application/json' }),
				body: eventOnlyBody(
					JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
				),
				user: { username: 'alice' },
			},
			next
		);
		assert.equal(result.status, 200);
		assert.equal(JSON.parse(result.body).id, 7);
	});

	it('rejects (does not hang) when the request body closes before end (#1320 review)', async () => {
		const handler = createHarperHttpHandler('application');
		// Without the 'close' handler in readBody this await would never settle and
		// the test would time out; assert it rejects promptly instead.
		await assert.rejects(
			handler(
				{
					method: 'POST',
					headers: makeHeaders({ 'content-type': 'application/json' }),
					body: abortedBody('{ "jsonrpc": "2.0"'),
					user: { username: 'alice' },
				},
				next
			),
			/request aborted/
		);
	});

	it('reads chunked body streams (Buffer + string mix)', async () => {
		const handler = createHarperHttpHandler('application');
		const body = Readable.from([
			Buffer.from('{"jsonrpc":"2.0",', 'utf8'),
			'"id":1,"method":"initialize",',
			Buffer.from('"params":{"protocolVersion":"2025-06-18"}}', 'utf8'),
		]);
		const result = await handler({ method: 'POST', headers: makeHeaders(), body, user: { username: 'alice' } }, next);
		assert.equal(result.status, 200);
	});

	it('flips session.initialized via notifications/initialized', async () => {
		const handler = createHarperHttpHandler('application');
		const initResult = await handler(
			{
				method: 'POST',
				headers: makeHeaders(),
				body: bodyStream(
					JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
				),
				user: { username: 'alice' },
			},
			next
		);
		const sessionId = initResult.headers['Mcp-Session-Id'];

		const notifResult = await handler(
			{
				method: 'POST',
				headers: makeHeaders({ 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' }),
				body: bodyStream(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })),
				user: { username: 'alice' },
			},
			next
		);
		assert.equal(notifResult.status, 202);
		assert.equal(notifResult.body, undefined);
		const session = await loadSession(sessionId);
		assert.equal(session.initialized, true);
	});

	it('returns 400 on GET without an Mcp-Session-Id (SSE channel landed in #619)', async () => {
		const handler = createHarperHttpHandler('application');
		const result = await handler({ method: 'GET', headers: makeHeaders(), user: { username: 'alice' } }, next);
		assert.equal(result.status, 400);
	});

	it('returns empty body (no JSON.stringify) for 202/204', async () => {
		const handler = createHarperHttpHandler('application');
		const initResult = await handler(
			{
				method: 'POST',
				headers: makeHeaders(),
				body: bodyStream(
					JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
				),
				user: { username: 'alice' },
			},
			next
		);
		const sessionId = initResult.headers['Mcp-Session-Id'];
		const notif = await handler(
			{
				method: 'POST',
				headers: makeHeaders({ 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' }),
				body: bodyStream(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled' })),
				user: { username: 'alice' },
			},
			next
		);
		assert.equal(notif.status, 202);
		assert.equal(notif.body, undefined);
	});

	describe('request body size limit', () => {
		const initializeBody = JSON.stringify({
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: { protocolVersion: '2025-06-18' },
		});
		afterEach(() => env.setProperty(CONFIG_PARAMS.HTTP_MAXREQUESTBODYSIZE, undefined));

		function endlessBody(chunkSize) {
			const emitter = new EventEmitter();
			const wrapper = {
				emitted: 0,
				on(event, listener) {
					emitter.on(event, listener);
					return wrapper;
				},
			};
			const timer = setInterval(() => {
				if (wrapper.emitted >= 100) {
					clearInterval(timer);
					return emitter.emit('end');
				}
				wrapper.emitted++;
				emitter.emit('data', Buffer.alloc(chunkSize, 0x61));
			}, 1);
			wrapper.stop = () => clearInterval(timer);
			return wrapper;
		}

		it('answers 413 once the streamed body exceeds http.maxRequestBodySize, without waiting for the end', async () => {
			env.setProperty(CONFIG_PARAMS.HTTP_MAXREQUESTBODYSIZE, 1000);
			const handler = createHarperHttpHandler('application');
			const body = endlessBody(400);

			const result = await handler({ method: 'POST', headers: makeHeaders(), body, user: { username: 'alice' } }, next);

			assert.equal(result.status, 413);
			body.stop();
			assert.equal(JSON.parse(result.body).error, 'payload_too_large');
			assert.match(JSON.parse(result.body).message, /Request body too large, maximum size is 1000 bytes/);
			assert.equal(result.headers['Mcp-Session-Id'], undefined);
			assert.ok(body.emitted <= 4, `reading continued past the limit (${body.emitted} chunks)`);
		});

		it('answers 413 from a declared Content-Length and keeps draining the body without buffering it', async () => {
			env.setProperty(CONFIG_PARAMS.HTTP_MAXREQUESTBODYSIZE, 1000);
			const handler = createHarperHttpHandler('application');
			const body = new EventEmitter();

			const result = await handler(
				{ method: 'POST', headers: makeHeaders({ 'content-length': '1001' }), body, user: { username: 'alice' } },
				next
			);

			assert.equal(result.status, 413);
			assert.equal(body.listenerCount('data'), 1, 'a data listener must flow the stream so it is discarded');
			assert.equal(body.listenerCount('error'), 1);
			body.emit('data', Buffer.alloc(2000));
			body.emit('error', new Error('socket reset after the early response'));
			body.emit('end');
		});

		it('still serves a body under the limit', async () => {
			env.setProperty(CONFIG_PARAMS.HTTP_MAXREQUESTBODYSIZE, initializeBody.length);
			const handler = createHarperHttpHandler('application');

			const result = await handler(
				{
					method: 'POST',
					headers: makeHeaders({ 'content-length': String(initializeBody.length) }),
					body: bodyStream(initializeBody),
					user: { username: 'alice' },
				},
				next
			);

			assert.equal(result.status, 200);
		});

		it('rejects a body one byte over an overridden limit and honours a raised one', async () => {
			const handler = createHarperHttpHandler('application');
			const request = () => ({
				method: 'POST',
				headers: makeHeaders(),
				body: bodyStream(initializeBody),
				user: { username: 'alice' },
			});

			env.setProperty(CONFIG_PARAMS.HTTP_MAXREQUESTBODYSIZE, initializeBody.length - 1);
			assert.equal((await handler(request(), next)).status, 413);

			env.setProperty(CONFIG_PARAMS.HTTP_MAXREQUESTBODYSIZE, initializeBody.length);
			assert.equal((await handler(request(), next)).status, 200);
		});

		it('applies the default 10 MB limit when the setting is unset', async () => {
			const handler = createHarperHttpHandler('application');
			const body = endlessBody(1_000_000);

			const result = await handler({ method: 'POST', headers: makeHeaders(), body, user: { username: 'alice' } }, next);

			assert.equal(result.status, 413);
			assert.match(JSON.parse(result.body).message, /maximum size is 10000000 bytes/);
			body.stop();
			assert.ok(body.emitted <= 11, `reading continued past the limit (${body.emitted} chunks)`);
		});
	});
});
