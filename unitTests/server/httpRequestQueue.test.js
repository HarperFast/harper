'use strict';

require('../testUtils.js').preTestPrep();
const assert = require('node:assert');
const { IncomingMessage, ServerResponse } = require('node:http');
const { Socket } = require('node:net');
const env = require('#src/utility/environment/environmentManager');
const { httpServer, makeUwsHandler, uwsServeConfigs, universalHeaders } = require('#src/server/http');
const { waitFor } = require('../waitFor.js');

let nextPort = 19560;
const nextCycle = () => new Promise(setImmediate);

function createHandler(backend, readLimit = 0, writeLimit = 0, onRequest = () => {}) {
	const port = nextPort++;
	env.setProperty('http_requestQueueLimit', writeLimit);
	env.setProperty('http_readRequestQueueLimit', readLimit);
	const previousUws = process.env.HARPER_UWS_HTTP;
	if (backend === 'uWS') process.env.HARPER_UWS_HTTP = '1';
	else delete process.env.HARPER_UWS_HTTP;
	let server;
	try {
		[server] = httpServer(
			() => {
				onRequest();
				return { status: 200, body: 'ok' };
			},
			{ port, name: `requestQueue${port}` }
		);
	} finally {
		if (previousUws === undefined) delete process.env.HARPER_UWS_HTTP;
		else process.env.HARPER_UWS_HTTP = previousUws;
	}
	if (backend === 'uWS') {
		return (method, signal, origin = 'https://queue.example') =>
			Promise.resolve(uwsServeConfigs[port].handler({ method, url: '/', headers: new Headers({ origin }), signal }));
	}
	return async (method, signal, origin = 'https://queue.example') => {
		const request = new IncomingMessage(new Socket());
		request.method = method;
		request.url = '/';
		request.headers.origin = origin;
		const response = new ServerResponse(request);
		const abort = () => request.socket.destroy();
		signal?.addEventListener('abort', abort, { once: true });
		try {
			await server.listeners('request')[0](request, response);
			await waitFor(() => response.writableEnded || request.socket.destroyed, 2000);
			return { status: response.statusCode, headers: new Headers(response.getHeaders()) };
		} finally {
			signal?.removeEventListener('abort', abort);
			request.socket.destroy();
		}
	};
}

async function backlog(send, method) {
	const pending = [send(method), send(method), send(method)];
	await nextCycle();
	return pending;
}

function spin(ms) {
	const until = performance.now() + ms;
	while (performance.now() < until);
}

describe('HTTP method request admission', function () {
	this.timeout(5000);
	let previousReadLimit, previousWriteLimit;
	beforeEach(() => {
		previousReadLimit = env.get('http_readRequestQueueLimit');
		previousWriteLimit = env.get('http_requestQueueLimit');
	});
	afterEach(() => {
		env.setProperty('http_readRequestQueueLimit', previousReadLimit);
		env.setProperty('http_requestQueueLimit', previousWriteLimit);
	});

	for (const backend of ['Node', 'uWS']) {
		describe(backend, () => {
			it('dispatches admitted reads synchronously, without queuing', async () => {
				let called = 0;
				const send = createHandler(backend, 60_000, 0, () => called++);
				const reads = ['GET', 'HEAD', 'OPTIONS', 'GET', 'GET'].map((method) => send(method));
				assert.equal(called, 5);
				for (const { status } of await Promise.all(reads)) assert.equal(status, 200);
			});
			it('dispatches disabled reads immediately while retaining write admission', async () => {
				let called = 0;
				const send = createHandler(backend, false, 0, () => called++);
				const pending = send('GET');
				spin(5);
				const reads = ['GET', 'HEAD', 'OPTIONS'].map((method) => send(method));
				assert.equal(called, 4);
				await Promise.all([pending, ...reads]);
				const writes = await backlog(send, 'POST');
				assert.equal((await send('POST')).status, 503);
				await Promise.all(writes);
			});
			for (const method of ['GET', 'HEAD', 'OPTIONS']) {
				it(`rejects a ${method} without running it once the loop iteration passes the limit`, async () => {
					let called = 0;
					const send = createHandler(backend, 1, 0, () => called++);
					const first = send(method);
					spin(5);
					assert.equal((await send(method)).status, 503);
					assert.equal(called, 1);
					await first;
					await nextCycle();
					assert.equal((await send(method)).status, 200);
				});
			}
			for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
				it(`still queues and sheds ${method} using the write limit`, async () => {
					const send = createHandler(backend, false, 0);
					const pending = await backlog(send, method);
					assert.equal((await send(method)).status, 503);
					await Promise.all(pending);
					await nextCycle();
					assert.equal((await send(method)).status, 200);
				});
			}
			it('counts work that ran earlier in the iteration while reads keep arriving', async () => {
				const send = createHandler(backend, 1);
				const first = send('GET');
				await nextCycle();
				spin(5);
				assert.equal((await send('GET')).status, 503);
				await first;
			});
			it('stops probing once reads stop, so a cold read is admitted', async () => {
				const send = createHandler(backend, 1);
				await send('GET');
				await nextCycle();
				await nextCycle();
				spin(5);
				assert.equal((await send('GET')).status, 200);
			});
			it('shares the loop measurement across listeners but applies each limit', async () => {
				const strict = createHandler(backend, 1);
				const lenient = createHandler(backend, 60_000);
				const pending = strict('GET');
				spin(5);
				const [rejected, admitted] = await Promise.all([strict('GET'), lenient('GET')]);
				assert.equal(rejected.status, 503);
				assert.equal(admitted.status, 200);
				await pending;
			});
			it('preserves CORS and configured headers on rejected reads without allowing other origins', async () => {
				const previousCors = env.get('http_cors');
				const previousList = env.get('http_corsAccessList');
				const ownedHeader = ['X-Queue-Test', 'present'];
				universalHeaders.push(ownedHeader);
				try {
					env.setProperty('http_cors', true);
					env.setProperty('http_corsAccessList', ['https://queue.example']);
					const send = createHandler(backend, 1);
					const pending = send('GET');
					spin(5);
					const [allowed, denied] = await Promise.all([send('GET'), send('GET', undefined, 'https://denied.example')]);
					assert.equal(allowed.status, 503);
					assert.equal(allowed.headers.get('Access-Control-Allow-Origin'), 'https://queue.example');
					assert.equal(allowed.headers.get('X-Queue-Test'), 'present');
					assert(allowed.headers.get('Vary').toLowerCase().includes('origin'));
					assert.equal(denied.status, 503);
					assert(!denied.headers.get('Access-Control-Allow-Origin'));
					await pending;
				} finally {
					env.setProperty('http_cors', previousCors);
					env.setProperty('http_corsAccessList', previousList);
					const index = universalHeaders.indexOf(ownedHeader);
					if (index >= 0) universalHeaders.splice(index, 1);
				}
			});
			it('admits reads while the write queue is shedding', async () => {
				const send = createHandler(backend, 60_000, 0);
				const writes = await backlog(send, 'POST');
				const [shed, admitted] = await Promise.all([send('POST'), send('GET')]);
				assert.equal(shed.status, 503);
				assert.equal(admitted.status, 200);
				await Promise.all(writes);
			});
		});
	}

	for (const readLimit of [undefined, null]) {
		it(`uses the 5000ms read default for ${readLimit} on the exported uWS handler`, async () => {
			const port = nextPort++;
			httpServer(() => ({ status: 200, body: 'ok' }), { port, name: `requestQueue${port}` });
			const handler = makeUwsHandler(port, false, 0, readLimit);
			const send = (method) => Promise.resolve(handler({ method, url: '/', headers: new Headers() }));
			const pending = send('GET');
			spin(20);
			assert.equal((await send('GET')).status, 200);
			await pending;
			const writes = await backlog(send, 'POST');
			assert.equal((await send('POST')).status, 503);
			await Promise.all(writes);
		});
	}
});
