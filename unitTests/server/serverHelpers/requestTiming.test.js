'use strict';

const assert = require('node:assert');
const EventEmitter = require('node:events');
const { createServer } = require('node:http');
const { connect } = require('node:net');
const { setTimeout: delay } = require('node:timers/promises');
const { watchRequestArrival, startRequestTimer } = require('#src/server/serverHelpers/requestTiming');

function fakeRequest(socket) {
	return { socket, complete: false, httpVersionMajor: 1 };
}

describe('request timing', () => {
	it('stamps the first bytes of each request and hands the stamp to the request', () => {
		const socket = new EventEmitter();
		watchRequestArrival(socket);
		assert.strictEqual(socket.requestSeenAt, undefined);
		const before = performance.now();
		socket.emit('data', Buffer.from('GET / HTTP/1.1\r\n'));
		const seenAt = socket.requestSeenAt;
		assert.ok(seenAt >= before);
		socket.emit('data', Buffer.from('Host: x\r\n\r\n'));
		assert.strictEqual(socket.requestSeenAt, seenAt, 'a later chunk of the same request keeps the first stamp');

		const request = fakeRequest(socket);
		assert.strictEqual(startRequestTimer(request), seenAt);
		assert.strictEqual(request.receivedAt, seenAt);
		assert.strictEqual(socket.requestSeenAt, undefined);
		assert.strictEqual(socket.currentRequest, request);
	});

	it('ignores body chunks of the request in flight and stamps the next keep-alive request', () => {
		const socket = new EventEmitter();
		watchRequestArrival(socket);
		socket.emit('data', Buffer.from('POST / HTTP/1.1\r\n\r\npartial'));
		const request = fakeRequest(socket);
		startRequestTimer(request);
		socket.emit('data', Buffer.from('rest of body'));
		assert.strictEqual(socket.requestSeenAt, undefined, 'body bytes do not start the next request');
		request.complete = true;
		socket.emit('data', Buffer.from('GET /next HTTP/1.1\r\n\r\n'));
		const nextSeenAt = socket.requestSeenAt;
		assert.ok(nextSeenAt > request.receivedAt);
		const next = fakeRequest(socket);
		assert.strictEqual(startRequestTimer(next), nextSeenAt);
		assert.strictEqual(socket.currentRequest, next);
	});

	it('falls back to now without a stamp, a socket, or on HTTP/2', () => {
		const unstamped = fakeRequest(new EventEmitter());
		const before = performance.now();
		assert.ok(startRequestTimer(unstamped) >= before);
		const socketless = { httpVersionMajor: 1 };
		assert.ok(startRequestTimer(socketless) >= before);
		const h2Socket = { requestSeenAt: 1 };
		const h2 = { httpVersionMajor: 2, socket: h2Socket };
		assert.ok(startRequestTimer(h2) >= before);
		assert.strictEqual(h2Socket.requestSeenAt, 1, 'an HTTP/2 request never touches the session socket');
		assert.strictEqual(watchRequestArrival(undefined), undefined);
		assert.strictEqual(watchRequestArrival({}), undefined);
	});

	describe('on a node:http server', () => {
		let server;
		let port;
		const received = [];
		before(async () => {
			server = createServer((request, response) => {
				startRequestTimer(request);
				received.push({ url: request.url, receivedAt: request.receivedAt, at: performance.now() });
				response.end('ok');
			});
			server.on('connection', watchRequestArrival);
			await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
			port = server.address().port;
		});
		after(() => new Promise((resolve) => server.close(resolve)));

		function readResponse(socket) {
			return new Promise((resolve) => {
				const onData = (chunk) => {
					if (chunk.includes('ok')) {
						socket.removeListener('data', onData);
						resolve();
					}
				};
				socket.on('data', onData);
			});
		}

		it('starts the clock at the first byte of the request, ahead of the parser and the request event', async () => {
			received.length = 0;
			const socket = connect(port, '127.0.0.1');
			await new Promise((resolve) => socket.once('connect', resolve));
			const firstByteAt = performance.now();
			socket.write('GET /split HTTP/1.1\r\nHost: localhost\r\n');
			await delay(60);
			socket.write('Connection: keep-alive\r\n\r\n');
			await readResponse(socket);
			assert.strictEqual(received.length, 1);
			const [split] = received;
			assert.ok(split.receivedAt >= firstByteAt - 1, `stamped at the first byte: ${JSON.stringify(split)}`);
			assert.ok(
				split.at - split.receivedAt >= 50,
				`the wait for the rest of the headers counts: ${JSON.stringify(split)}`
			);

			const nextAt = performance.now();
			socket.write('GET /second HTTP/1.1\r\nHost: localhost\r\n\r\n');
			await readResponse(socket);
			assert.strictEqual(received.length, 2);
			const second = received[1];
			assert.ok(
				second.receivedAt >= nextAt - 1,
				`the second request is stamped on its own bytes: ${JSON.stringify(second)}`
			);
			socket.destroy();
		});

		it('does not let an unread body start the next request early', async () => {
			received.length = 0;
			const socket = connect(port, '127.0.0.1');
			await new Promise((resolve) => socket.once('connect', resolve));
			socket.write('POST /unread HTTP/1.1\r\nHost: localhost\r\nContent-Length: 8\r\n\r\nabc');
			await readResponse(socket);
			socket.write('defgh');
			await delay(60);
			const nextAt = performance.now();
			socket.write('GET /after HTTP/1.1\r\nHost: localhost\r\n\r\n');
			await readResponse(socket);
			assert.strictEqual(received.length, 2);
			const after = received[1];
			assert.ok(
				after.receivedAt >= nextAt - 1,
				`the late body chunk did not stamp the next request: ${JSON.stringify(after)}`
			);
			socket.destroy();
		});
	});
});
