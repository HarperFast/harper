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
			queue.once('close', () => {
				closed = true;
			});
			const stream = toSseStream(queue);
			stream.pipe(new PassThrough()); // mirrors stream.pipe(reply.raw)
			await new Promise((r) => setImmediate(r)); // let the prime flow
			stream.destroy(); // server tears down on response close
			await new Promise((r) => setTimeout(r, 30));
			assert.equal(closed, true, 'queue close emitted so the registry can drop the dead session');
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
