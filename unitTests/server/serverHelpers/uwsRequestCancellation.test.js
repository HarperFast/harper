/**
 * A uWS request's cancellation and peer address (server/serverHelpers/uwsServer.ts, Request.ts
 * UwsRequest), from a real client socket through to a request transaction's writes.
 */
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

function get(port, options = {}) {
	return new Promise((resolve, reject) => {
		http
			.get({ host: '127.0.0.1', port, agent: false, path: '/', ...options }, (res) => {
				let body = '';
				res.on('data', (chunk) => (body += chunk));
				res.on('end', () => resolve(body));
			})
			.on('error', reject);
	});
}

// Opens a GET and destroys the socket once `entered` resolves, i.e. while the handler is still running.
async function disconnectDuring(port, entered) {
	const socket = net.connect({ host: '127.0.0.1', port });
	await once(socket, 'connect');
	socket.write('GET /item HTTP/1.1\r\nHost: localhost\r\n\r\n');
	await entered;
	socket.destroy();
}

(uwsAvailable ? describe : describe.skip)('uWS request cancellation and peer address', function () {
	let port, server, handle;
	before(async function () {
		port = await getFreeTcpPort();
		server = await createUwsServer({ port, handler: (request) => handle(request) });
	});
	after(() => server?.close());

	it('reports each IPv4 peer as itself across a keep-alive server', async function () {
		handle = (request) => ({ status: 200, body: request.ip });
		const seen = [];
		for (const localAddress of ['127.0.0.1', '127.0.0.2', '127.0.0.2', '127.0.0.1']) {
			seen.push(await get(port, { localAddress }));
		}
		assert.deepStrictEqual(seen, ['127.0.0.1', '127.0.0.2', '127.0.0.2', '127.0.0.1']);
	});

	it('reports an IPv6 peer in uWS text form', async function () {
		handle = (request) => ({ status: 200, body: request.ip });
		let body;
		try {
			body = await get(port, { host: '::1', family: 6 });
		} catch (error) {
			if (error.code === 'EADDRNOTAVAIL' || error.code === 'ECONNREFUSED') this.skip();
			throw error;
		}
		assert.strictEqual(body, '0000:0000:0000:0000:0000:0000:0000:0001');
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
		await left.promise;
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
		assert.strictEqual(await aborted.promise, true);
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
			await disconnectDuring(port, entered.promise);
			const request = await entered.promise;
			await waitFor(() => request.isAborted, 5000);
			gate.resolve();
			assert.deepStrictEqual(await outcome, { statusCode: 499 });
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
			await disconnectDuring(port, entered.promise);
			await waitFor(() => scopeTxn.disconnected, 5000);
			// the staged write's intent is gone, so a competing write to the same key commits now
			await CancelTable.put(2, { name: 'competing' });
			gate.resolve();
			assert.deepStrictEqual(await outcome, { statusCode: 499 });
			assert.strictEqual((await CancelTable.get(2)).name, 'competing');
		});
	});
});
