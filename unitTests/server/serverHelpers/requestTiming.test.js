'use strict';

const assert = require('node:assert');
const { createServer } = require('node:http');
const { connect } = require('node:net');
const { setTimeout: delay } = require('node:timers/promises');
const { watchRequestArrival, startRequestTimer } = require('#src/server/serverHelpers/requestTiming');

function fakeParser(socket) {
	const parser = { socket };
	parser.constructor = { kOnMessageBegin: 0 };
	return parser;
}

describe('request timing', () => {
	it('stamps the socket at each message begin and hands the newest stamp to the request', () => {
		const socket = {};
		socket.parser = fakeParser(socket);
		watchRequestArrival(socket);
		assert.strictEqual(typeof socket.parser[0], 'function');
		const before = performance.now();
		socket.parser[0]();
		const first = socket.requestSeenAt;
		assert.ok(first >= before);
		const request = { httpVersionMajor: 1, socket };
		assert.strictEqual(startRequestTimer(request), first);
		assert.strictEqual(request.receivedAt, first);
		assert.strictEqual(socket.requestSeenAt, undefined, 'the stamp is consumed');

		socket.parser[0]();
		socket.requestSeenAt = -1;
		const next = performance.now();
		socket.parser[0]();
		assert.ok(socket.requestSeenAt >= next, 'a message the server answers itself is overwritten by the next begin');
	});

	it('falls back to now without a stamp, a parser, or on HTTP/2', () => {
		const before = performance.now();
		const unstamped = { httpVersionMajor: 1, socket: { parser: fakeParser({}) } };
		assert.ok(startRequestTimer(unstamped) >= before);
		assert.ok(startRequestTimer({ httpVersionMajor: 1 }) >= before);
		const h2Socket = { requestSeenAt: 1 };
		assert.ok(startRequestTimer({ httpVersionMajor: 2, socket: h2Socket }) >= before);
		assert.strictEqual(h2Socket.requestSeenAt, 1, 'an HTTP/2 request never touches the session socket');
		assert.strictEqual(watchRequestArrival(undefined), undefined);
		assert.strictEqual(watchRequestArrival({}), undefined);
		assert.strictEqual(watchRequestArrival({ parser: { constructor: {} } }), undefined);
	});

	describe('on a node:http server', () => {
		let server;
		let port;
		const received = [];
		before(async () => {
			server = createServer((request, response) => {
				startRequestTimer(request);
				received.push({
					url: request.url,
					receivedAt: request.receivedAt,
					at: performance.now(),
					consumed: request.socket.parser?._consumed,
				});
				response.end('ok');
			});
			server.on('connection', watchRequestArrival);
			await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
			port = server.address().port;
		});
		after(() => new Promise((resolve) => server.close(resolve)));

		function readResponses(socket, count) {
			return new Promise((resolve) => {
				let seen = 0;
				const onData = (chunk) => {
					seen += chunk.toString().split('ok').length - 1;
					if (seen >= count) {
						socket.removeListener('data', onData);
						resolve();
					}
				};
				socket.on('data', onData);
			});
		}

		async function openSocket() {
			const socket = connect(port, '127.0.0.1');
			await new Promise((resolve) => socket.once('connect', resolve));
			return socket;
		}

		it('starts the clock at the first byte of the request and leaves the parser on its native stream', async () => {
			received.length = 0;
			const socket = await openSocket();
			const firstByteAt = performance.now();
			socket.write('GET /split HTTP/1.1\r\nHost: localhost\r\n');
			await delay(150);
			socket.write('Connection: keep-alive\r\n\r\n');
			await readResponses(socket, 1);
			const [split] = received;
			assert.strictEqual(split.consumed, true, 'the HTTP parser still reads the socket natively');
			assert.ok(split.receivedAt >= firstByteAt - 1, `stamped at the first byte: ${JSON.stringify(split)}`);
			assert.ok(
				split.at - split.receivedAt >= 100,
				`the wait for the rest of the headers counts: ${JSON.stringify(split)}`
			);

			const nextAt = performance.now();
			socket.write('GET /second HTTP/1.1\r\nHost: localhost\r\n\r\n');
			await readResponses(socket, 1);
			assert.strictEqual(received.length, 2);
			assert.ok(
				received[1].receivedAt >= nextAt - 1,
				`the second request is stamped on its own bytes: ${JSON.stringify(received[1])}`
			);
			socket.destroy();
		});

		it('does not let an unread body or a self-answered message start the next request early', async () => {
			received.length = 0;
			const socket = await openSocket();
			socket.write('POST /unread HTTP/1.1\r\nHost: localhost\r\nContent-Length: 8\r\n\r\nabc');
			await readResponses(socket, 1);
			socket.write('defgh');
			await delay(100);
			socket.write('POST /expect HTTP/1.1\r\nHost: localhost\r\nExpect: nothing\r\n\r\n');
			await delay(100);
			const nextAt = performance.now();
			socket.write('GET /after HTTP/1.1\r\nHost: localhost\r\n\r\n');
			await readResponses(socket, 1);
			assert.deepStrictEqual(
				received.map((entry) => entry.url),
				['/unread', '/after'],
				'the Expect message was answered by Node without a request event'
			);
			assert.ok(
				received[1].receivedAt >= nextAt - 1,
				`neither the late body nor the 417 stamp leaks: ${JSON.stringify(received[1])}`
			);
			socket.destroy();
		});

		it('stamps each pipelined request at its own first byte', async () => {
			received.length = 0;
			const socket = await openSocket();
			const sentAt = performance.now();
			socket.write('GET /one HTTP/1.1\r\nHost: localhost\r\n\r\nGET /two HTTP/1.1\r\n');
			await delay(150);
			socket.write('Host: localhost\r\n\r\n');
			await readResponses(socket, 2);
			assert.deepStrictEqual(
				received.map((entry) => entry.url),
				['/one', '/two']
			);
			for (const entry of received) assert.ok(entry.receivedAt >= sentAt - 1, JSON.stringify(entry));
			assert.ok(received[1].receivedAt >= received[0].receivedAt);
			assert.ok(
				received[1].at - received[1].receivedAt >= 100,
				`the second request was stamped from the chunk that carried its first bytes: ${JSON.stringify(received[1])}`
			);
			socket.destroy();
		});
	});
});
