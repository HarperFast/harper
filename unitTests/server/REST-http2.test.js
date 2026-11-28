'use strict';

const assert = require('node:assert');
const http = require('node:http');
const http2 = require('node:http2');
const { once } = require('node:events');
const { setupTestDBPath } = require('../testUtils.js');
const { table } = require('#src/resources/databases');
const { Resource } = require('#src/resources/Resource');
const { Resources } = require('#src/resources/Resources');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { handleApplication } = require('#src/server/REST');
const { Request } = require('#src/server/serverHelpers/Request');
require('#src/server/serverHelpers/serverUtilities');

const admin = { role: { permission: { super_user: true } } };
const REQUEST_TIMEOUT_MS = 5000;

async function writeHarperResponse(response, nodeRes) {
	const headers = {};
	if (response.headers) {
		for (const [name, value] of response.headers) {
			if (name.toLowerCase() !== 'connection') headers[name] = value;
		}
	}
	nodeRes.writeHead(response.status ?? 200, headers);
	if (response.body === undefined || response.body === null) {
		nodeRes.end();
	} else if (typeof response.body === 'string' || Buffer.isBuffer(response.body)) {
		nodeRes.end(response.body);
	} else {
		for await (const chunk of response.body) nodeRes.write(chunk);
		nodeRes.end();
	}
}

function h2Request(session, headers, { body, endStream } = {}) {
	return new Promise((resolve, reject) => {
		const options = endStream !== undefined ? { endStream } : undefined;
		const stream = session.request(headers, options);
		let responseHeaders;
		const chunks = [];
		const timer = setTimeout(() => {
			stream.destroy(new Error(`HTTP/2 request timed out: ${headers[':method']} ${headers[':path']}`));
		}, REQUEST_TIMEOUT_MS);
		stream.on('response', (resHeaders) => {
			responseHeaders = resHeaders;
		});
		stream.on('data', (chunk) => chunks.push(chunk));
		stream.on('end', () => {
			clearTimeout(timer);
			const text = Buffer.concat(chunks).toString('utf8');
			resolve({
				status: responseHeaders[':status'],
				headers: responseHeaders,
				text,
				json: () => JSON.parse(text),
			});
		});
		stream.on('error', (error) => {
			clearTimeout(timer);
			reject(error);
		});
		if (!endStream) {
			if (body !== undefined) stream.write(body);
			if (endStream === false || body !== undefined || ['POST', 'PUT', 'PATCH', 'QUERY'].includes(headers[':method'])) {
				stream.end();
			}
		}
	});
}

function h1ChunkedRequest(port, method, path, headers, body) {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{
				hostname: '127.0.0.1',
				port,
				method,
				path,
				headers: { ...headers, 'transfer-encoding': 'chunked' },
			},
			(res) => {
				const chunks = [];
				res.on('data', (chunk) => chunks.push(chunk));
				res.on('end', () => {
					const text = Buffer.concat(chunks).toString('utf8');
					resolve({
						status: res.statusCode,
						headers: res.headers,
						text,
						json: () => JSON.parse(text),
					});
				});
			}
		);
		req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error(`HTTP/1.1 request timed out: ${method} ${path}`)));
		req.on('error', reject);
		if (body !== undefined) req.write(body);
		req.end();
	});
}

describe('REST over HTTP/2 without content-length', function () {
	let H2Item;
	let handler;
	let h2Server;
	let h1Server;
	let h2Client;
	let h2Port;
	let h1Port;

	before(async function () {
		setupTestDBPath();
		setMainIsWorker(true);

		H2Item = table({
			table: 'H2Item',
			database: 'test_rest_http2',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name', indexed: true },
				{ name: 'tag', indexed: true },
				{ name: 'count' },
			],
		});

		class H2Echo extends Resource {
			static async post(_target, data) {
				const resolved = await data;
				return { hadData: data !== undefined, received: resolved ?? null };
			}
			static async get(target, request) {
				return { id: target.id, hadData: request.data !== undefined };
			}
			static async delete(target, request) {
				return { deleted: target.id, hadData: request.data !== undefined };
			}
		}

		const resources = new Resources();
		resources.set('H2Item', H2Item, { rest: true });
		resources.set('H2Echo', H2Echo, { rest: true });

		handleApplication({
			resources,
			options: { getAll: () => ({ webSocket: false, lastModified: true }) },
			routeFor: () => ({ urlPath: '/rest-http2-test' }),
			server: { http: (listener) => (handler = listener) },
		});

		const onRequest = async (nodeReq, nodeRes) => {
			try {
				const request = new Request(nodeReq, nodeRes);
				request.user = admin;
				const response = await handler(request, () => ({ status: 404, headers: {}, body: 'Not found' }));
				await writeHarperResponse(response, nodeRes);
			} catch (error) {
				nodeRes.writeHead(500, { 'content-type': 'text/plain' });
				nodeRes.end(String(error));
			}
		};

		h2Server = http2.createServer(onRequest);
		h2Server.listen(0, '127.0.0.1');
		await once(h2Server, 'listening');
		h2Port = h2Server.address().port;

		h1Server = http.createServer(onRequest);
		h1Server.listen(0, '127.0.0.1');
		await once(h1Server, 'listening');
		h1Port = h1Server.address().port;

		h2Client = http2.connect(`http://127.0.0.1:${h2Port}`);
		await once(h2Client, 'connect');
	});

	after(async function () {
		const waitClose = (emitter) =>
			once(emitter, 'close', { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }).catch(() => {});
		if (h2Client && !h2Client.closed) {
			h2Client.close();
			await waitClose(h2Client);
			if (!h2Client.closed) h2Client.destroy();
		}
		if (h2Server) {
			h2Server.close();
			await waitClose(h2Server);
		}
		if (h1Server) {
			h1Server.closeAllConnections?.();
			h1Server.close();
			await waitClose(h1Server);
		}
	});

	it('handles POST, PATCH, PUT, and QUERY without content-length', async function () {
		const postRes = await h2Request(
			h2Client,
			{ ':method': 'POST', ':path': '/H2Item/', 'content-type': 'application/json' },
			{ body: JSON.stringify({ id: 'item-1', name: 'initial', tag: 'alpha', count: 1 }) }
		);
		assert.strictEqual(postRes.status, 201, postRes.text);
		assert.strictEqual(postRes.json(), 'item-1');

		const created = await H2Item.get('item-1');
		assert.deepStrictEqual(
			{ id: created.id, name: created.name, tag: created.tag, count: created.count },
			{ id: 'item-1', name: 'initial', tag: 'alpha', count: 1 }
		);

		const patchRes = await h2Request(
			h2Client,
			{ ':method': 'PATCH', ':path': '/H2Item/item-1', 'content-type': 'application/json' },
			{ body: JSON.stringify({ name: 'patched', count: 2 }) }
		);
		assert.strictEqual(patchRes.status, 204, patchRes.text);

		const patched = await H2Item.get('item-1');
		assert.deepStrictEqual(
			{ id: patched.id, name: patched.name, tag: patched.tag, count: patched.count },
			{ id: 'item-1', name: 'patched', tag: 'alpha', count: 2 }
		);

		const putRes = await h2Request(
			h2Client,
			{ ':method': 'PUT', ':path': '/H2Item/item-1', 'content-type': 'application/json' },
			{ body: JSON.stringify({ name: 'replaced', tag: 'beta' }) }
		);
		assert.strictEqual(putRes.status, 204, putRes.text);

		const replaced = await H2Item.get('item-1');
		assert.strictEqual(replaced.name, 'replaced');
		assert.strictEqual(replaced.tag, 'beta');
		assert.strictEqual(replaced.count, undefined);

		const queryRes = await h2Request(
			h2Client,
			{ ':method': 'QUERY', ':path': '/H2Item/', 'content-type': 'application/json' },
			{
				body: JSON.stringify({
					conditions: [{ attribute: 'tag', comparator: 'equals', value: 'beta' }],
				}),
			}
		);
		assert.strictEqual(queryRes.status, 200, queryRes.text);
		const rows = queryRes.json();
		assert.strictEqual(rows.length, 1);
		assert.strictEqual(rows[0].id, 'item-1');
		assert.strictEqual(rows[0].name, 'replaced');
	});

	it('passes the deserialized body to a custom Resource post() without content-length', async function () {
		const res = await h2Request(
			h2Client,
			{ ':method': 'POST', ':path': '/H2Echo/', 'content-type': 'application/json' },
			{ body: JSON.stringify({ hello: 'h2', n: 42 }) }
		);
		assert.strictEqual(res.status, 200, res.text);
		assert.deepStrictEqual(res.json(), { hadData: true, received: { hello: 'h2', n: 42 } });
	});

	it('leaves bodyless HTTP/2 GET, DELETE, and endStream:true POST unaffected', async function () {
		await H2Item.put('bodyless-1', { name: 'keep', tag: 'bodyless' });

		const getRes = await h2Request(h2Client, { ':method': 'GET', ':path': '/H2Item/bodyless-1' });
		assert.strictEqual(getRes.status, 200, getRes.text);
		assert.strictEqual(getRes.json().name, 'keep');

		const echoGet = await h2Request(h2Client, { ':method': 'GET', ':path': '/H2Echo/probe' });
		assert.strictEqual(echoGet.status, 200, echoGet.text);
		assert.deepStrictEqual(echoGet.json(), { id: 'probe', hadData: false });

		const deleteRes = await h2Request(h2Client, { ':method': 'DELETE', ':path': '/H2Item/bodyless-1' });
		assert.strictEqual(deleteRes.status, 200, deleteRes.text);
		assert.strictEqual(await H2Item.get('bodyless-1'), null);

		const echoDelete = await h2Request(h2Client, { ':method': 'DELETE', ':path': '/H2Echo/probe' });
		assert.strictEqual(echoDelete.status, 200, echoDelete.text);
		assert.deepStrictEqual(echoDelete.json(), { deleted: 'probe', hadData: false });

		const emptyPost = await h2Request(
			h2Client,
			{ ':method': 'POST', ':path': '/H2Echo/', 'content-type': 'application/json' },
			{ endStream: true }
		);
		assert.strictEqual(emptyPost.status, 200, emptyPost.text);
		assert.deepStrictEqual(emptyPost.json(), { hadData: false, received: null });
	});

	it('preserves If-Match conditional-write ordering for bodyless DELETE and body-bearing PATCH', async function () {
		await H2Item.put('cond-1', { name: 'v1', tag: 'cond' });
		const read = await h2Request(h2Client, { ':method': 'GET', ':path': '/H2Item/cond-1' });
		assert.strictEqual(read.status, 200);
		const etag = read.headers.etag;
		assert.ok(etag, 'expected ETag on GET response');

		const stalePatch = await h2Request(
			h2Client,
			{
				':method': 'PATCH',
				':path': '/H2Item/cond-1',
				'content-type': 'application/json',
				'if-match': '"stale"',
			},
			{ body: JSON.stringify({ name: 'should-not-land' }) }
		);
		assert.strictEqual(stalePatch.status, 412, stalePatch.text);
		assert.strictEqual((await H2Item.get('cond-1')).name, 'v1');

		const okPatch = await h2Request(
			h2Client,
			{
				':method': 'PATCH',
				':path': '/H2Item/cond-1',
				'content-type': 'application/json',
				'if-match': etag,
			},
			{ body: JSON.stringify({ name: 'v2' }) }
		);
		assert.strictEqual(okPatch.status, 204, okPatch.text);
		assert.strictEqual((await H2Item.get('cond-1')).name, 'v2');

		const staleDelete = await h2Request(h2Client, {
			':method': 'DELETE',
			':path': '/H2Item/cond-1',
			'if-match': etag,
		});
		assert.strictEqual(staleDelete.status, 412, staleDelete.text);
		assert.strictEqual((await H2Item.get('cond-1')).name, 'v2');

		const refreshed = await h2Request(h2Client, { ':method': 'GET', ':path': '/H2Item/cond-1' });
		const okDelete = await h2Request(h2Client, {
			':method': 'DELETE',
			':path': '/H2Item/cond-1',
			'if-match': refreshed.headers.etag,
		});
		assert.strictEqual(okDelete.status, 200, okDelete.text);
		assert.strictEqual(await H2Item.get('cond-1'), null);
	});

	it('keeps explicit content-length on HTTP/2 and HTTP/1.1 chunked bodies working', async function () {
		await H2Item.put('ctrl-1', { name: 'orig', tag: 'ctrl' });

		const h2Payload = JSON.stringify({ name: 'h2-cl' });
		const h2Res = await h2Request(
			h2Client,
			{
				':method': 'PATCH',
				':path': '/H2Item/ctrl-1',
				'content-type': 'application/json',
				'content-length': String(Buffer.byteLength(h2Payload)),
			},
			{ body: h2Payload }
		);
		assert.strictEqual(h2Res.status, 204, h2Res.text);
		assert.strictEqual((await H2Item.get('ctrl-1')).name, 'h2-cl');

		const h1Res = await h1ChunkedRequest(
			h1Port,
			'PATCH',
			'/H2Item/ctrl-1',
			{ 'content-type': 'application/json' },
			JSON.stringify({ name: 'h1-chunked' })
		);
		assert.strictEqual(h1Res.status, 204, h1Res.text);
		assert.strictEqual((await H2Item.get('ctrl-1')).name, 'h1-chunked');
	});

	it('treats an empty HTTP/2 stream (endStream: false, 0 bytes) like an empty HTTP/1.1 chunked body', async function () {
		for (const contentType of ['text/plain', 'application/json']) {
			const h1Res = await h1ChunkedRequest(h1Port, 'POST', '/H2Echo/', { 'content-type': contentType });
			const h2Res = await h2Request(
				h2Client,
				{ ':method': 'POST', ':path': '/H2Echo/', 'content-type': contentType },
				{ endStream: false }
			);
			assert.strictEqual(h2Res.status, h1Res.status, `${contentType}: h2=${h2Res.text} h1=${h1Res.text}`);
			assert.strictEqual(h2Res.text, h1Res.text, `${contentType} body mismatch`);
		}
	});

	it('does not emit unhandledRejection when an HTTP/2 GET leaves the stream open with an invalid JSON body', async function () {
		await H2Item.put('open-get-1', { name: 'ok', tag: 'open-get' });
		const unhandled = [];
		const onUnhandled = (reason) => unhandled.push(reason);
		process.on('unhandledRejection', onUnhandled);
		try {
			const res = await h2Request(
				h2Client,
				{ ':method': 'GET', ':path': '/H2Item/open-get-1', 'content-type': 'application/json' },
				{ body: '{not-json', endStream: false }
			);
			assert.strictEqual(res.status, 200, res.text);
			assert.strictEqual(res.json().name, 'ok');
			await new Promise((resolve) => setImmediate(resolve));
			assert.deepStrictEqual(unhandled, []);
		} finally {
			process.off('unhandledRejection', onUnhandled);
		}
	});

	it('emits the real host in GET /openapi servers[0].url under HTTP/2', async function () {
		const res = await h2Request(h2Client, { ':method': 'GET', ':path': '/openapi' });
		assert.strictEqual(res.status, 200, res.text);
		const spec = res.json();
		assert.strictEqual(spec.servers[0].url, `http://127.0.0.1:${h2Port}`);
	});
});
