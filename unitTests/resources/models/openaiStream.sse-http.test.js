'use strict';

// Higher-level coverage for `openaiStream()` (#514, #510): drive its output through
// Harper's REAL `text/event-stream` serializer over a live HTTP connection and parse
// it back with the unmodified `eventsource` SSE client — the same client class an
// OpenAI/LangChain consumer's stream reader is built on.
//
// This closes the seams the sibling unit test (`openaiStream.test.js`) can't reach:
//   1. `serializeStream()` — the streaming `Readable` path `server/REST.ts` uses for an
//      async-iterable resource response — not just the per-message `serialize()`.
//   2. A real SSE client parsing the framed wire bytes end to end (data:-only events,
//      `[DONE]` terminal), over real HTTP with real chunked delivery.
//
// It deliberately does NOT stand up a full Harper instance: `openaiStream` is core-internal
// (its consumer is the #631 `/v1/*` gateway), so the full app→REST→gateway acceptance test
// — unmodified OpenAI SDK completes a chat — is #631's, per that issue's acceptance criteria.
// Here we exercise Harper's own SSE serializer + a real client, which is openaiStream's slice.

const assert = require('node:assert');
const http = require('node:http');
const { openaiStream } = require('#src/resources/models/openaiStream');
const { TestBackend } = require('#src/resources/models/TestBackend');
const { contentTypes } = require('#src/server/serverHelpers/contentTypes');

const sse = contentTypes.get('text/event-stream');

// TestBackend is `tools: false` and can't emit tool-call deltas, so mirror the streamed
// tool-call shape a tools-capable backend yields (partial fields re-sent under one id —
// see `mergeToolCallDelta` in agentLoop.ts) to cover openaiStream's assembly path here too.
async function* toolCallChunks() {
	yield { deltaToolCalls: [{ id: 'call_1', name: 'get_weather' }] };
	yield { deltaToolCalls: [{ id: 'call_1', arguments: { city: 'NYC' } }] };
	yield { deltaToolCalls: [{ id: 'call_1', arguments: { unit: 'c' } }] };
	yield { finishReason: 'tool_calls' };
}

// Serve `openaiStream(tokens, opts)` once over HTTP, framed by Harper's real event-stream
// serializer. This mirrors Harper's actual SSE path: a request with `Accept: text/event-stream`
// is dispatched as CONNECT (server/REST.ts:24-25,137-139) and the resulting message stream is
// iterated and serialized per message — never the terminating `done` step. So we call the real
// `sse.serialize` (contentTypes.ts) on each yielded message, exactly as that path does. (This
// test predates #1628; `sse.serializeStream` now skips the terminal `done` step and finishes a
// finite generator cleanly — see the serializeStream SSE coverage in contentTypes.test.js.)
// Listens on an ephemeral loopback port so concurrent runs stay isolated.
function serveOnce(tokens, opts) {
	const server = http.createServer(async (_req, res) => {
		res.writeHead(200, {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			'Connection': 'keep-alive',
		});
		try {
			for await (const message of openaiStream(tokens, opts)) {
				res.write(sse.serialize(message));
			}
		} finally {
			res.end();
		}
	});
	return new Promise((resolve) => {
		server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/` }));
	});
}

// Consume default `message` events with the real eventsource client until the `[DONE]`
// sentinel, then close (so the client doesn't auto-reconnect on stream end). Returns the
// parsed OpenAI chunk objects in arrival order.
function collectSSE(EventSource, url) {
	return new Promise((resolve, reject) => {
		const es = new EventSource(url);
		const events = [];
		const finish = (fn, arg) => {
			clearTimeout(timer);
			es.close(); // always close so the client never auto-reconnects and no socket lingers
			fn(arg);
		};
		const timer = setTimeout(() => finish(reject, new Error('timed out waiting for SSE [DONE] sentinel')), 5000);
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

describe('openaiStream over real HTTP + real eventsource client', () => {
	let EventSource;
	before(async () => {
		// `eventsource` v4 is ESM-only; load it dynamically from this CJS test module.
		({ EventSource } = await import('eventsource'));
	});

	it('streams TestBackend generateStream output as OpenAI SSE chunks a real client parses', async () => {
		const { server, url } = await serveOnce(new TestBackend().generateStream('hi there', {}), {
			model: 'test-model',
			id: 'chatcmpl-http',
		});
		try {
			const events = await collectSSE(EventSource, url);

			assert.ok(events.length >= 2, 'expected multiple chunk events');
			for (const ev of events) {
				assert.equal(ev.object, 'chat.completion.chunk');
				assert.equal(ev.id, 'chatcmpl-http');
				assert.equal(ev.model, 'test-model');
				assert.equal(ev.choices[0].index, 0);
			}

			// role announced exactly once, on the first chunk
			assert.equal(events[0].choices[0].delta.role, 'assistant');
			assert.equal(events.filter((e) => e.choices[0].delta.role).length, 1, 'role must be announced exactly once');

			// content deltas reassemble to TestBackend's deterministic output
			const content = events.map((e) => e.choices[0].delta.content ?? '').join('');
			assert.ok(content.startsWith('[TestBackend stream]: hi there'), `unexpected content: ${content}`);

			// terminal chunk: empty delta + finish_reason 'stop', then the [DONE] sentinel (implied by resolve)
			const terminal = events[events.length - 1];
			assert.deepEqual(terminal.choices[0].delta, {});
			assert.equal(terminal.choices[0].finish_reason, 'stop');
		} finally {
			server.closeAllConnections?.(); // force-drop any lingering keep-alive socket before closing the listener
			server.close();
		}
	});

	it('assembles streamed tool-call deltas into one tool_calls SSE delta a real client parses', async () => {
		const { server, url } = await serveOnce(toolCallChunks(), { model: 'm', id: 'chatcmpl-tc' });
		try {
			const events = await collectSSE(EventSource, url);

			const toolEvent = events.find((e) => e.choices[0].delta.tool_calls);
			assert.ok(toolEvent, 'expected a tool_calls delta event');
			const call = toolEvent.choices[0].delta.tool_calls[0];
			assert.equal(call.index, 0);
			assert.equal(call.id, 'call_1');
			assert.equal(call.type, 'function');
			assert.equal(call.function.name, 'get_weather');
			// arguments merged across deltas and stringified exactly once → valid JSON
			assert.deepEqual(JSON.parse(call.function.arguments), { city: 'NYC', unit: 'c' });

			assert.equal(events[events.length - 1].choices[0].finish_reason, 'tool_calls');
		} finally {
			server.closeAllConnections?.(); // force-drop any lingering keep-alive socket before closing the listener
			server.close();
		}
	});
});
