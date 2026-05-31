'use strict';

const assert = require('node:assert');
const { Readable, PassThrough } = require('node:stream');
const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const { parseSSE, renderDeployProgress } = require('#src/bin/sseConsumer');

async function collectMessages(stream) {
	const out = [];
	for await (const msg of parseSSE(stream)) out.push(msg);
	return out;
}

describe('parseSSE', () => {
	it('parses a single record', async () => {
		const stream = Readable.from(['event: phase\ndata: {"phase":"extract"}\n\n']);
		const msgs = await collectMessages(stream);
		assert.deepStrictEqual(msgs, [{ event: 'phase', data: '{"phase":"extract"}', id: undefined, retry: undefined }]);
	});

	it('joins multi-line data fields with \\n per the SSE spec', async () => {
		const stream = Readable.from(['event: install\ndata: line1\ndata: line2\n\n']);
		const msgs = await collectMessages(stream);
		assert.strictEqual(msgs[0].data, 'line1\nline2');
	});

	it('handles records split across multiple chunks', async () => {
		const stream = new PassThrough();
		const collector = collectMessages(stream);
		stream.write('event: phase\n');
		stream.write('data: {"phase":"extract","sta');
		stream.write('tus":"start"}\n\n');
		stream.write('event: phase\ndata: {"phase":"extract","status":"done"}\n\n');
		stream.end();
		const msgs = await collector;
		assert.strictEqual(msgs.length, 2);
		assert.strictEqual(JSON.parse(msgs[0].data).status, 'start');
		assert.strictEqual(JSON.parse(msgs[1].data).status, 'done');
	});

	it('handles CRLF line endings', async () => {
		const stream = Readable.from(['event: phase\r\ndata: {"x":1}\r\n\r\n']);
		const msgs = await collectMessages(stream);
		assert.strictEqual(msgs[0].event, 'phase');
		assert.deepStrictEqual(JSON.parse(msgs[0].data), { x: 1 });
	});

	it('strips a single leading space after the colon, per spec', async () => {
		const stream = Readable.from(['data:  hello\n\n']);
		const msgs = await collectMessages(stream);
		// only ONE space is stripped, the second remains
		assert.strictEqual(msgs[0].data, ' hello');
	});

	it('ignores comment lines (leading colon)', async () => {
		const stream = Readable.from([': heartbeat\nevent: ping\ndata: ok\n\n']);
		const msgs = await collectMessages(stream);
		assert.strictEqual(msgs[0].event, 'ping');
		assert.strictEqual(msgs[0].data, 'ok');
	});
});

describe('renderDeployProgress', () => {
	it('prints a phase line on start and another on done', () => {
		const lines = [];
		const out = { write: (s) => lines.push(s) };
		const state = {};
		renderDeployProgress({ event: 'phase', data: JSON.stringify({ phase: 'extract', status: 'start' }) }, state, out);
		renderDeployProgress({ event: 'phase', data: JSON.stringify({ phase: 'extract', status: 'done' }) }, state, out);
		assert.deepStrictEqual(lines, ['extract…\n', 'extract done\n']);
	});

	it('does not repeat the same phase-start line', () => {
		const lines = [];
		const out = { write: (s) => lines.push(s) };
		const state = {};
		const msg = { event: 'phase', data: JSON.stringify({ phase: 'extract', status: 'start' }) };
		renderDeployProgress(msg, state, out);
		renderDeployProgress(msg, state, out);
		assert.strictEqual(lines.length, 1);
	});

	it('prints an error line with the message', () => {
		const lines = [];
		const out = { write: (s) => lines.push(s) };
		renderDeployProgress(
			{ event: 'error', data: JSON.stringify({ message: 'npm install failed', code: 500 }) },
			{},
			out
		);
		assert.match(lines[0], /error: npm install failed \(500\)/);
	});
});
