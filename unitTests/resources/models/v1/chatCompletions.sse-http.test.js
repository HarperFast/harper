'use strict';

/**
 * HTTP SSE integration test for `POST /v1/chat/completions` with `stream: true` (#631).
 *
 * Drives the gateway's streaming path end-to-end:
 *   openaiStream() → transformIterable (fixed) → serializeStream → HTTP → EventSource
 *
 * This is the critical path that was BLOCKED before the transformIterable bug fix:
 * `serializeStream()` called `transform(undefined)` on the terminal async generator step,
 * which crashed inside `serialize()` at `message.acknowledge()`. The fix guards `done: true`
 * steps and skips the transform.
 *
 * We do NOT spin up a full Harper instance here — that's the integration test's job.
 * Instead we serve a single HTTP response with the same pipeline the gateway uses,
 * verifying that a real SSE client parses the framed output correctly.
 */

const assert = require('node:assert');
const http = require('node:http');
const { openaiStream } = require('#src/resources/models/openaiStream');
const { contentTypes } = require('#src/server/serverHelpers/contentTypes');
const { TestBackend } = require('#src/resources/models/TestBackend');

const sseHandler = contentTypes.get('text/event-stream');

/**
 * Serve one request using the same pipeline as V1ChatCompletions.post() for
 * `stream: true`: `serializeStream(openaiStream(generateStream(...), opts))`.
 * This is the `{ body: Readable }` response path.
 */
function serveOnce(tokens, opts) {
	const server = http.createServer((_req, res) => {
		const body = sseHandler.serializeStream(openaiStream(tokens, opts));
		res.writeHead(200, {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			'Connection': 'keep-alive',
		});
		body.pipe(res);
	});
	return new Promise((resolve) => {
		server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/` }));
	});
}

/** Collect parsed OpenAI chunks from SSE until the [DONE] sentinel. */
function collectSSE(EventSource, url) {
	return new Promise((resolve, reject) => {
		const es = new EventSource(url);
		const events = [];
		const finish = (fn, arg) => {
			clearTimeout(timer);
			es.close();
			fn(arg);
		};
		const timer = setTimeout(() => finish(reject, new Error('SSE timed out before [DONE]')), 5000);
		es.addEventListener('message', (event) => {
			if (event.data === '[DONE]') return finish(resolve, events);
			try {
				events.push(JSON.parse(event.data));
			} catch (err) {
				finish(reject, err);
			}
		});
		es.addEventListener('error', () => finish(reject, new Error('EventSource errored before [DONE]')));
	});
}

describe('V1ChatCompletions streaming via serializeStream (transformIterable fix)', () => {
	let EventSource;

	before(async () => {
		({ EventSource } = await import('eventsource'));
	});

	it('streams TestBackend output through serializeStream without crashing on terminal step', async () => {
		const backend = new TestBackend();
		const { server, url } = await serveOnce(backend.generateStream('hello world', {}), {
			model: 'test',
			id: 'chatcmpl-sse-test',
		});
		try {
			const events = await collectSSE(EventSource, url);

			assert.ok(events.length >= 2, 'expected multiple chunk events');
			for (const ev of events) {
				assert.equal(ev.object, 'chat.completion.chunk');
				assert.equal(ev.id, 'chatcmpl-sse-test');
				assert.equal(ev.model, 'test');
			}

			// Content reassembles to TestBackend's deterministic prefix
			const content = events.map((e) => e.choices[0].delta.content ?? '').join('');
			assert.ok(content.startsWith('[TestBackend stream]:'), `unexpected content: ${content}`);

			// Terminal chunk: empty delta + finish_reason 'stop'
			const terminal = events[events.length - 1];
			assert.ok(terminal.choices[0].finish_reason !== null, 'terminal chunk must carry finish_reason');
		} finally {
			server.closeAllConnections?.();
			server.close();
		}
	});

	it('correctly serialises the [DONE] sentinel as the last SSE event', async () => {
		// A minimal one-token stream that immediately finishes — verifies the
		// terminal-step guard doesn't eat the [DONE] sentinel.
		async function* singleChunk() {
			yield { deltaContent: 'hi' };
			yield { finishReason: 'stop' };
		}
		const { server, url } = await serveOnce(singleChunk(), { model: 'm', id: 'id1' });
		try {
			const events = await collectSSE(EventSource, url);
			// [DONE] is consumed by collectSSE; events contains all OpenAI chunks
			assert.ok(events.length >= 1);
			// The last chunk must carry a finish_reason, not [DONE]
			const last = events[events.length - 1];
			assert.equal(last.choices[0].finish_reason, 'stop');
		} finally {
			server.closeAllConnections?.();
			server.close();
		}
	});
});
