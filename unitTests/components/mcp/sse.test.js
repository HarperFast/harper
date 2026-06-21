const assert = require('node:assert/strict');
const { serializeSseFrame, toSseStream } = require('#src/components/mcp/sse');
const { IterableEventQueue } = require('#src/resources/IterableEventQueue');

async function collect(stream) {
	let out = '';
	for await (const chunk of stream) out += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
	return out;
}

describe('mcp/sse', () => {
	describe('serializeSseFrame', () => {
		it('serializes event + object data as event:/data: lines + blank terminator', () => {
			const out = serializeSseFrame({
				event: 'message',
				data: { jsonrpc: '2.0', method: 'notifications/tools/list_changed' },
			});
			assert.equal(out, 'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n');
		});

		it('passes string data through without JSON-encoding', () => {
			assert.equal(serializeSseFrame({ event: 'message', data: 'hello' }), 'event: message\ndata: hello\n\n');
		});

		it('includes an id line when present', () => {
			assert.equal(serializeSseFrame({ event: 'message', data: 'x', id: '7' }), 'event: message\ndata: x\nid: 7\n\n');
		});

		it('omits absent fields (a frame with no data is just a terminator)', () => {
			assert.equal(serializeSseFrame({}), '\n');
		});

		it('prefixes every line of multi-line string data with data: (SSE robustness)', () => {
			assert.equal(serializeSseFrame({ event: 'message', data: 'a\nb' }), 'event: message\ndata: a\ndata: b\n\n');
		});
	});

	describe('toSseStream', () => {
		it('primes with an SSE comment so headers flush before any push', async () => {
			const queue = new IterableEventQueue();
			const collected = collect(toSseStream(queue));
			queue.emit('close'); // no frames ever pushed → just the prime, then end
			assert.equal(await collected, ': mcp stream open\n\n');
		});

		it('emits the prime, then a serialized frame for each pushed event in order', async () => {
			const queue = new IterableEventQueue();
			const collected = collect(toSseStream(queue));
			await new Promise((r) => setImmediate(r));
			queue.send({ event: 'message', data: { method: 'notifications/tools/list_changed' } });
			queue.send({ event: 'message', data: { method: 'notifications/resources/list_changed' } });
			await new Promise((r) => setImmediate(r));
			queue.emit('close');
			assert.equal(
				await collected,
				': mcp stream open\n\n' +
					'event: message\ndata: {"method":"notifications/tools/list_changed"}\n\n' +
					'event: message\ndata: {"method":"notifications/resources/list_changed"}\n\n'
			);
		});

		it('produces a real Node Readable (has pipe)', () => {
			const stream = toSseStream(new IterableEventQueue());
			assert.equal(typeof stream.pipe, 'function');
		});

		it('signals the source queue when the piped stream is destroyed (disconnect → no registry leak)', async () => {
			// Client/proxy disconnect: the server destroys the piped stream. The
			// stream's 'close' must signal the queue so the session registry (which
			// listens for the queue's 'close') drops the dead entry.
			const { PassThrough } = require('node:stream');
			const queue = new IterableEventQueue();
			let closed = false;
			// Wait on the close condition rather than a fixed sleep (avoids CI flakes
			// when teardown propagation is delayed on a loaded runner).
			const closeReceived = new Promise((resolve) =>
				queue.once('close', () => {
					closed = true;
					resolve();
				})
			);
			const stream = toSseStream(queue);
			stream.pipe(new PassThrough()); // mirrors stream.pipe(reply.raw)
			await new Promise((r) => setImmediate(r)); // let the prime flow
			stream.destroy(); // server tears down on response close
			await closeReceived;
			assert.equal(closed, true, 'queue close emitted so the registry can drop the dead session');
		});

		it('removes its queue listeners when the stream is destroyed before the queue closes (no listener leak)', async () => {
			// Client disconnect while the session lives on: the stream tears down
			// first. Both the 'data' and 'close' listeners it put on the long-lived
			// queue must come off, or the queue accumulates dead listeners per
			// reconnect.
			const { PassThrough } = require('node:stream');
			const queue = new IterableEventQueue();
			const stream = toSseStream(queue);
			stream.pipe(new PassThrough());
			await new Promise((r) => setImmediate(r));
			assert.ok(queue.listenerCount('close') >= 1, 'close listener attached while live');
			// Teardown emits the queue's 'close' after removing the stream's listeners;
			// wait on that condition (not a fixed sleep) before asserting the counts.
			const torndown = new Promise((resolve) => queue.once('close', resolve));
			stream.destroy();
			await torndown;
			assert.equal(queue.listenerCount('data'), 0, 'data listener removed on stream teardown');
			assert.equal(queue.listenerCount('close'), 0, 'close listener removed on stream teardown');
		});

		it('does not re-emit close on the queue when the source closed first (no duplicate teardown)', async () => {
			// Server-side teardown (DELETE / supersede / idle-prune) emits the queue's
			// 'close'. That ends the stream; the stream's own 'close' handler must NOT
			// emit 'close' on the queue again, or an on('close') listener sees teardown twice.
			const { PassThrough } = require('node:stream');
			const queue = new IterableEventQueue();
			let closeCount = 0;
			queue.on('close', () => closeCount++);
			const stream = toSseStream(queue);
			stream.pipe(new PassThrough());
			const streamClosed = new Promise((resolve) => stream.once('close', resolve));
			await new Promise((r) => setImmediate(r));
			queue.emit('close'); // server-side teardown
			await streamClosed; // stream-close handler has now run
			await new Promise((r) => setImmediate(r)); // let any (erroneous) re-emit flush
			assert.equal(closeCount, 1, 'queue close emitted exactly once (no duplicate from the stream close handler)');
		});

		it('an error on the stream is handled (does not throw an unhandled error / crash)', async () => {
			// A Readable with no 'error' listener throws on 'error', crashing the
			// worker. toSseStream must attach a default guard so neither the piped
			// operations socket nor Harper-HTTP can crash the process.
			const stream = toSseStream(new IterableEventQueue());
			assert.ok(stream.listenerCount('error') >= 1, 'default error guard attached');
			// Emitting 'error' must not throw now that a listener exists.
			assert.doesNotThrow(() => stream.emit('error', new Error('boom')));
			await new Promise((r) => setImmediate(r));
			assert.equal(stream.destroyed, true, 'stream torn down by the error guard');
		});

		it('streams pushed frames and ENDS when the source queue emits close (no socket leak)', async () => {
			const queue = new IterableEventQueue();
			const collected = collect(toSseStream(queue));
			await new Promise((r) => setImmediate(r));
			queue.send({ event: 'message', data: { method: 'notifications/tools/list_changed' } });
			await new Promise((r) => setImmediate(r));
			queue.emit('close'); // sessionRegistry signals teardown this way
			// Must resolve (stream ended), not hang.
			const out = await collected;
			assert.match(out, /^: mcp stream open\n\n/);
			assert.match(out, /notifications\/tools\/list_changed/);
		});
	});
});
