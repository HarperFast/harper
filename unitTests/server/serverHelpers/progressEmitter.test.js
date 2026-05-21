'use strict';

const assert = require('node:assert');
const { Readable } = require('node:stream');
const testUtils = require('../../testUtils.js');
testUtils.preTestPrep();

const { ProgressEmitter, createSSEResponseStream } = require('#src/server/serverHelpers/progressEmitter');

function collect(stream) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		stream.on('data', (c) => chunks.push(c));
		stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		stream.on('error', reject);
	});
}

function parseSSEBlocks(text) {
	return (
		text
			.split('\n\n')
			.filter((block) => block.trim().length > 0)
			.map((block) => {
				const out = {};
				for (const line of block.split('\n')) {
					const colon = line.indexOf(':');
					if (colon === -1) continue;
					const field = line.slice(0, colon);
					let value = line.slice(colon + 1);
					if (value.startsWith(' ')) value = value.slice(1);
					out[field] = value;
				}
				return out;
			})
			// Drop SSE comment records (lines starting with `:`) — they're protocol-level
			// liveness hints that the stream is open, not application events.
			.filter((rec) => 'event' in rec || 'data' in rec)
	);
}

describe('ProgressEmitter', () => {
	it('delivers events to every subscriber', () => {
		const emitter = new ProgressEmitter();
		const a = [];
		const b = [];
		emitter.subscribe((e) => a.push(e));
		emitter.subscribe((e) => b.push(e));
		emitter.emit('phase', { phase: 'extract', status: 'start' });
		emitter.emit('phase', { phase: 'extract', status: 'done' });
		assert.deepStrictEqual(a, [
			{ event: 'phase', data: { phase: 'extract', status: 'start' } },
			{ event: 'phase', data: { phase: 'extract', status: 'done' } },
		]);
		assert.deepStrictEqual(b, a);
	});

	it('unsubscribe stops further delivery', () => {
		const emitter = new ProgressEmitter();
		const received = [];
		const unsubscribe = emitter.subscribe((e) => received.push(e));
		emitter.emit('phase', { phase: 'extract', status: 'start' });
		unsubscribe();
		emitter.emit('phase', { phase: 'extract', status: 'done' });
		assert.strictEqual(received.length, 1);
	});

	it('swallows listener exceptions so operations are never broken by a buggy subscriber', () => {
		const emitter = new ProgressEmitter();
		emitter.subscribe(() => {
			throw new Error('listener boom');
		});
		const ok = [];
		emitter.subscribe((e) => ok.push(e));
		emitter.emit('phase', { phase: 'extract', status: 'start' });
		assert.strictEqual(ok.length, 1);
	});
});

describe('createSSEResponseStream', () => {
	it('streams emitter events then a terminating `done` event with the operation result', async () => {
		const emitter = new ProgressEmitter();
		const stream = createSSEResponseStream(emitter, async () => {
			emitter.emit('phase', { phase: 'extract', status: 'start' });
			await new Promise((r) => setImmediate(r));
			emitter.emit('phase', { phase: 'extract', status: 'done' });
			return { message: 'Successfully deployed: demo' };
		});
		const text = await collect(stream);
		const events = parseSSEBlocks(text);
		assert.strictEqual(events.length, 3);
		assert.strictEqual(events[0].event, 'phase');
		assert.deepStrictEqual(JSON.parse(events[0].data), { phase: 'extract', status: 'start' });
		assert.strictEqual(events[1].event, 'phase');
		assert.deepStrictEqual(JSON.parse(events[1].data), { phase: 'extract', status: 'done' });
		assert.strictEqual(events[2].event, 'done');
		assert.deepStrictEqual(JSON.parse(events[2].data), { result: { message: 'Successfully deployed: demo' } });
	});

	it('streams an `error` event when the operation rejects', async () => {
		const emitter = new ProgressEmitter();
		const stream = createSSEResponseStream(emitter, async () => {
			emitter.emit('phase', { phase: 'extract', status: 'start' });
			const err = new Error('boom');
			err.statusCode = 500;
			throw err;
		});
		const events = parseSSEBlocks(await collect(stream));
		assert.strictEqual(events[events.length - 1].event, 'error');
		const errData = JSON.parse(events[events.length - 1].data);
		assert.strictEqual(errData.message, 'boom');
		assert.strictEqual(errData.code, 500);
	});

	it('still closes the stream cleanly when the operation emits nothing', async () => {
		const emitter = new ProgressEmitter();
		const stream = createSSEResponseStream(emitter, async () => ({ ok: true }));
		const events = parseSSEBlocks(await collect(stream));
		assert.strictEqual(events.length, 1);
		assert.strictEqual(events[0].event, 'done');
	});
});

// keep Readable import live for any future tests that need stream sources
void Readable;
