require('../testUtils');
const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { setupTestDBPath } = require('../testUtils');
const { waitFor } = require('../waitFor.js');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { table } = require('#src/resources/databases');
const { transaction } = require('#src/resources/transaction');
const { Request } = require('#src/server/serverHelpers/Request');

describe('A write whose request never read its signal before the client disconnected', () => {
	let Records;
	let open = [];

	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		Records = table({
			table: 'LazySignalRecords',
			database: 'test',
			attributes: [
				{ name: 'id', type: 'Int', isPrimaryKey: true },
				{ name: 'value', type: 'String' },
			],
		});
	});

	afterEach(() => {
		for (const { client, server } of open) {
			client?.destroy();
			server?.close();
			server?.closeAllConnections();
		}
		open = [];
	});

	const next = (emitter, event) => once(emitter, event, { signal: AbortSignal.timeout(5000) });

	async function exchange() {
		let arrived;
		const handles = {};
		open.push(handles);
		const server = (handles.server = http.createServer((req, res) => (arrived = { req, res })));
		server.listen(0, '127.0.0.1');
		await next(server, 'listening');
		const client = (handles.client = net.connect(server.address().port, '127.0.0.1'));
		await next(client, 'connect');
		client.write('GET / HTTP/1.1\r\nHost: test\r\n\r\n');
		const { req, res } = await waitFor(() => arrived, 5000);
		return {
			request: new Request(req, res),
			async disconnect() {
				client.destroy();
				await waitFor(() => res.closed, 5000);
			},
		};
	}

	it('refuses its first write and commits nothing', async () => {
		const { request, disconnect } = await exchange();
		const gate = Promise.withResolvers();
		const handler = transaction(request, async () => {
			await gate.promise;
			await Records.put(1, { value: 'staged after the client left' }, request);
		});
		await disconnect();
		gate.resolve();
		await assert.rejects(handler, /client disconnected/);
		assert.ok((await Records.get(1)) == null, 'the refused write must not be committed');
	});

	it('releases a write staged before the disconnect while the handler is still running', async () => {
		const { request, disconnect } = await exchange();
		const gate = Promise.withResolvers();
		let staged = false;
		const handler = transaction(request, async () => {
			await Records.put(2, { value: 'staged' }, request);
			staged = true;
			await gate.promise;
		});
		handler.catch(() => {});
		try {
			await waitFor(() => staged, 5000);
			await disconnect();
			const outcome = await Promise.race([
				Records.put(2, { value: 'competing' }).then(() => 'settled'),
				delay(5000, undefined, { ref: false }).then(() => 'blocked behind the disconnected request'),
			]);
			assert.strictEqual(outcome, 'settled');
		} finally {
			gate.resolve();
		}
		await assert.rejects(handler, /client disconnected/);
		assert.strictEqual((await Records.get(2)).value, 'competing');
	});
});
