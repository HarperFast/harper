'use strict';

require('../testUtils.js').preTestPrep();
const assert = require('node:assert');
const { IncomingMessage, ServerResponse } = require('node:http');
const { Socket } = require('node:net');
const env = require('#src/utility/environment/environmentManager');
const { httpServer, makeUwsHandler, uwsServeConfigs } = require('#src/server/http');
const { waitFor } = require('../waitFor.js');

let nextPort = 19560;
const nextCycle = () => new Promise(setImmediate);

function createHandler(backend, readLimit = 0, writeLimit = 0) {
	const port = nextPort++;
	env.setProperty('http_requestQueueLimit', writeLimit);
	env.setProperty('http_readRequestQueueLimit', readLimit);
	const previousUws = process.env.HARPER_UWS_HTTP;
	if (backend === 'uWS') process.env.HARPER_UWS_HTTP = '1';
	else delete process.env.HARPER_UWS_HTTP;
	let server;
	try {
		[server] = httpServer(() => ({ status: 200, body: 'ok' }), { port, name: `requestQueue${port}` });
	} finally {
		if (previousUws === undefined) delete process.env.HARPER_UWS_HTTP;
		else process.env.HARPER_UWS_HTTP = previousUws;
	}
	if (backend === 'uWS') {
		return (method) => Promise.resolve(uwsServeConfigs[port].handler({ method, url: '/', headers: new Headers() }));
	}
	return async (method) => {
		const request = new IncomingMessage(new Socket());
		request.method = method;
		request.url = '/';
		const response = new ServerResponse(request);
		server.emit('request', request, response);
		try {
			await waitFor(() => response.writableEnded, 2000);
			return { status: response.statusCode };
		} finally {
			request.socket.destroy();
		}
	};
}

async function backlog(send, method) {
	const pending = [send(method), send(method), send(method)];
	await nextCycle();
	return pending;
}

describe('HTTP method request queues', function () {
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
			for (const method of ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']) {
				it(`sheds a queued ${method} using its configured limit`, async () => {
					const send = createHandler(backend);
					const pending = await backlog(send, method);
					assert.equal((await send(method)).status, 503);
					await Promise.all(pending);
					await nextCycle();
					assert.equal((await send(method)).status, 200);
				});
			}
			for (const [busy, idle] of [
				['GET', 'POST'],
				['POST', 'GET'],
			]) {
				it(`keeps ${idle} queue depth separate from a shedding ${busy} queue`, async () => {
					const send = createHandler(backend);
					const pending = await backlog(send, busy);
					const [shed, admitted] = await Promise.all([send(busy), send(idle)]);
					assert.equal(shed.status, 503);
					assert.equal(admitted.status, 200);
					await Promise.all(pending);
				});
			}
			it('keeps read and write limits independent', async () => {
				const send = createHandler(backend, 60_000, 0);
				const reads = await backlog(send, 'GET');
				assert.equal((await send('GET')).status, 200);
				await Promise.all(reads);
				const writes = await backlog(send, 'POST');
				assert.equal((await send('POST')).status, 503);
				await Promise.all(writes);
			});
		});
	}

	for (const readLimit of [undefined, null]) {
		it(`uses the larger read default for ${readLimit} on the exported uWS handler`, async () => {
			const port = nextPort++;
			httpServer(() => ({ status: 200, body: 'ok' }), { port, name: `requestQueue${port}` });
			const handler = makeUwsHandler(port, false, 0, readLimit);
			const send = (method) => Promise.resolve(handler({ method, url: '/', headers: new Headers() }));
			const reads = await backlog(send, 'GET');
			assert.equal((await send('GET')).status, 200);
			await Promise.all(reads);
			const writes = await backlog(send, 'POST');
			assert.equal((await send('POST')).status, 503);
			await Promise.all(writes);
		});
	}
});
