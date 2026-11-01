require('../../testUtils');
const assert = require('node:assert');
const net = require('node:net');
const http = require('node:http');
const { once } = require('node:events');
const { setupTestDBPath } = require('../../testUtils');
const { waitFor } = require('../../waitFor.js');

let createUwsServer;
let uwsAvailable = true;
try {
	require('uWebSockets.js');
	({ createUwsServer } = require('#src/server/serverHelpers/uwsServer'));
} catch {
	uwsAvailable = false;
}

async function getFreeTcpPort() {
	const reservation = net.createServer();
	reservation.listen(0, '127.0.0.1');
	await once(reservation, 'listening');
	const { port } = reservation.address();
	await new Promise((resolve) => reservation.close(resolve));
	return port;
}

function deferred() {
	let resolve;
	const promise = new Promise((r) => (resolve = r));
	return { promise, resolve };
}

// mocha's timeout is 0 here, so a cancellation regression must fail rather than wait forever
function within(promise, what, ms = 5000) {
	let timer;
	const deadline = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
	});
	return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

function get(port, options = {}) {
	let request;
	const response = new Promise((resolve, reject) => {
		request = http
			.get({ host: '127.0.0.1', port, agent: false, path: '/', ...options }, (res) => {
				let body = '';
				res.on('data', (chunk) => (body += chunk));
				res.on('end', () => resolve(body));
				res.on('error', reject);
			})
			.on('error', reject);
	});
	return within(response, 'the response').finally(() => request.destroy());
}

async function disconnectDuring(port, entered) {
	const socket = net.connect({ host: '127.0.0.1', port });
	try {
		await within(once(socket, 'connect'), 'the connection');
		socket.write('GET /item HTTP/1.1\r\nHost: localhost\r\n\r\n');
		await within(entered, 'the handler to start');
	} finally {
		socket.destroy();
	}
}

async function canBindIpv6Loopback() {
	const probe = net.createServer();
	try {
		probe.listen(0, '::1');
		await once(probe, 'listening');
		return true;
	} catch (error) {
		if (error.code === 'EADDRNOTAVAIL' || error.code === 'EAFNOSUPPORT') return false;
		throw error;
	} finally {
		probe.close();
	}
}

(uwsAvailable ? describe : describe.skip)('uWS request cancellation and peer address', function () {
	let port, server, handle, nodePort, nodeServer;
	before(async function () {
		port = await getFreeTcpPort();
		// no host: uWS binds dual-stack, as Harper's uWS listener does for a bare http.port
		server = await createUwsServer({ port, handler: (request) => handle(request) });
		// Node on '::' like threadServer.ts's default listen, the reference for request.ip on the Node path
		nodeServer = http.createServer((request, response) => response.end(request.socket.remoteAddress));
		nodeServer.listen(0, '::');
		await once(nodeServer, 'listening');
		nodePort = nodeServer.address().port;
	});
	after(() => {
		server?.close();
		nodeServer?.close();
	});

	it('reports each IPv4 peer as Node does across a keep-alive server', async function () {
		handle = (request) => ({ status: 200, body: request.ip });
		const seen = [];
		const seenByNode = [];
		for (const localAddress of ['127.0.0.1', '127.0.0.2', '127.0.0.2', '127.0.0.1']) {
			seen.push(await get(port, { localAddress }));
			seenByNode.push(await get(nodePort, { localAddress }));
		}
		assert.deepStrictEqual(seen, seenByNode);
		assert.deepStrictEqual(seen, ['::ffff:127.0.0.1', '::ffff:127.0.0.2', '::ffff:127.0.0.2', '::ffff:127.0.0.1']);
	});

	it('reports an IPv6 peer as Node does', async function () {
		if (!(await canBindIpv6Loopback())) this.skip();
		handle = (request) => ({ status: 200, body: request.ip });
		const body = await get(port, { host: '::1', family: 6 });
		assert.strictEqual(body, await get(nodePort, { host: '::1', family: 6 }));
		assert.strictEqual(body, '::1');
	});

	it('hands a handler that reads its signal only after the client left an aborted signal', async function () {
		const entered = deferred();
		const left = deferred();
		let observed;
		handle = async (request) => {
			entered.resolve();
			await waitFor(() => request.isAborted, 5000);
			observed = { aborted: request.signal.aborted, reason: request.signal.reason?.name };
			left.resolve();
			return { status: 200, body: 'late' };
		};
		await disconnectDuring(port, entered.promise);
		await within(left.promise, 'the handler to observe the abort');
		assert.deepStrictEqual(observed, { aborted: true, reason: 'AbortError' });
	});

	it('fires an abort listener attached before the client left', async function () {
		const entered = deferred();
		const aborted = deferred();
		handle = (request) => {
			request.signal.addEventListener('abort', () => aborted.resolve(request.isAborted), { once: true });
			entered.resolve();
			return aborted.promise.then(() => ({ status: 200 }));
		};
		await disconnectDuring(port, entered.promise);
		assert.strictEqual(await within(aborted.promise, 'the abort listener'), true);
	});

	describe('through a request transaction', function () {
		let CancelTable, transaction;
		before(function () {
			setupTestDBPath();
			require('#src/server/threads/manageThreads').setMainIsWorker(true);
			({ transaction } = require('#src/resources/transaction'));
			CancelTable = require('#src/resources/databases').table({
				table: 'UwsCancellationTable',
				database: 'test',
				attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
			});
		});

		it('refuses a write admitted after the client left, persisting nothing', async function () {
			const entered = deferred();
			const gate = deferred();
			let outcome, readBefore;
			handle = (request) =>
				(outcome = transaction(request, async () => {
					readBefore = await CancelTable.get(1, request);
					entered.resolve(request);
					await gate.promise;
					await CancelTable.put(1, { name: 'after disconnect' }, request);
				}).then(
					() => ({ fulfilled: true }),
					(error) => ({ statusCode: error.statusCode })
				));
			try {
				await disconnectDuring(port, entered.promise);
				const request = await within(entered.promise, 'the handler to start');
				await waitFor(() => request.isAborted, 5000);
			} finally {
				gate.resolve();
			}
			assert.deepStrictEqual(await within(outcome, 'the transaction outcome'), { statusCode: 499 });
			assert.ok(!readBefore, 'premise: the record did not exist');
			assert.ok(!(await CancelTable.get(1)), 'the refused write left nothing');
		});

		it('releases a write staged before the client left while the handler is still blocked', async function () {
			const entered = deferred();
			const gate = deferred();
			let outcome, scopeTxn;
			handle = (request) =>
				(outcome = transaction(request, async (txn) => {
					scopeTxn = txn;
					await CancelTable.put(2, { name: 'staged' }, request);
					entered.resolve();
					await gate.promise;
				}).then(
					() => ({ fulfilled: true }),
					(error) => ({ statusCode: error.statusCode })
				));
			try {
				await disconnectDuring(port, entered.promise);
				await waitFor(() => scopeTxn.disconnected, 5000);
				// the staged write's intent is gone, so a competing write to the same key commits now
				await within(CancelTable.put(2, { name: 'competing' }), 'the competing write');
			} finally {
				gate.resolve();
			}
			assert.deepStrictEqual(await within(outcome, 'the transaction outcome'), { statusCode: 499 });
			assert.strictEqual((await CancelTable.get(2)).name, 'competing');
		});
	});
});
