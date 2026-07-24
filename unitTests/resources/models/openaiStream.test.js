'use strict';

const assert = require('node:assert');
const { openaiStream } = require('#src/resources/models/openaiStream');
const { contentTypes } = require('#src/server/serverHelpers/contentTypes');

// The real SSE serializer — assert the helper's messages pass through it unchanged.
const sse = contentTypes.get('text/event-stream');

async function collect(iter) {
	const out = [];
	for await (const message of iter) out.push(message);
	return out;
}

async function* gen(...chunks) {
	for (const c of chunks) yield c;
}

describe('openaiStream', () => {
	it('formats content deltas as OpenAI chat.completion.chunk messages', async () => {
		const msgs = await collect(
			openaiStream(gen({ deltaContent: 'Hello' }, { deltaContent: ' world' }, { finishReason: 'stop' }), {
				model: 'llama-3.3-70b',
				id: 'chatcmpl-test',
			})
		);

		const first = msgs[0].data;
		assert.equal(first.object, 'chat.completion.chunk');
		assert.equal(first.id, 'chatcmpl-test');
		assert.equal(first.model, 'llama-3.3-70b');
		assert.equal(first.choices[0].index, 0);
		assert.equal(first.choices[0].delta.role, 'assistant');
		assert.equal(first.choices[0].delta.content, 'Hello');
		assert.equal(first.choices[0].finish_reason, null);

		// role is announced once, only on the first chunk
		assert.equal(msgs[1].data.choices[0].delta.role, undefined);
		assert.equal(msgs[1].data.choices[0].delta.content, ' world');

		// terminal chunk: empty delta + finish_reason, followed by the sentinel
		const terminal = msgs[msgs.length - 2].data;
		assert.deepEqual(terminal.choices[0].delta, {});
		assert.equal(terminal.choices[0].finish_reason, 'stop');
		assert.equal(msgs.at(-1).data, '[DONE]');
	});

	it('emits a terminal [DONE] sentinel that serializes to `data: [DONE]`', async () => {
		const msgs = await collect(openaiStream(gen({ deltaContent: 'hi' }), {}));
		const done = msgs.at(-1);
		assert.deepEqual(done, { data: '[DONE]' });
		assert.equal(sse.serialize(done), 'data: [DONE]\n\n');
	});

	it('passes through the real SSE serializer to OpenAI wire shape (no event/id lines)', async () => {
		const msgs = await collect(openaiStream(gen({ deltaContent: 'hi' }), { model: 'm', id: 'chatcmpl-x' }));
		const wire = msgs.map((m) => sse.serialize(m)).join('');

		assert.ok(!/^event:/m.test(wire), 'must not emit SSE `event:` lines');
		assert.ok(!/^id:/m.test(wire), 'must not emit SSE `id:` lines');
		assert.ok(wire.endsWith('data: [DONE]\n\n'), 'must end with the [DONE] sentinel');

		// first event is a parseable OpenAI chunk
		const firstData = wire.split('\n\n')[0].replace(/^data: /, '');
		const parsed = JSON.parse(firstData);
		assert.equal(parsed.object, 'chat.completion.chunk');
		assert.equal(parsed.choices[0].delta.content, 'hi');
	});

	it('assembles streamed tool-call deltas into one tool_calls delta with stringified arguments', async () => {
		const msgs = await collect(
			openaiStream(
				gen(
					{ deltaToolCalls: [{ id: 'call_1', name: 'get_weather' }] },
					{ deltaToolCalls: [{ id: 'call_1', arguments: { city: 'NYC' } }] },
					{ deltaToolCalls: [{ id: 'call_1', arguments: { unit: 'c' } }] },
					{ finishReason: 'tool_calls' }
				),
				{ model: 'm' }
			)
		);

		const toolChunk = msgs.map((m) => m.data).find((d) => typeof d === 'object' && d.choices[0].delta.tool_calls);
		assert.ok(toolChunk, 'expected a tool_calls delta chunk');

		const call = toolChunk.choices[0].delta.tool_calls[0];
		assert.equal(call.index, 0);
		assert.equal(call.id, 'call_1');
		assert.equal(call.type, 'function');
		assert.equal(call.function.name, 'get_weather');
		// arguments merged across deltas and stringified exactly once → valid JSON
		assert.deepEqual(JSON.parse(call.function.arguments), { city: 'NYC', unit: 'c' });

		assert.equal(msgs[msgs.length - 2].data.choices[0].finish_reason, 'tool_calls');
	});

	it('indexes multiple distinct tool calls in arrival order', async () => {
		const msgs = await collect(
			openaiStream(
				gen({
					deltaToolCalls: [
						{ id: 'a', name: 'first', arguments: { x: 1 } },
						{ id: 'b', name: 'second', arguments: { y: 2 } },
					],
				})
			)
		);
		const toolChunk = msgs.map((m) => m.data).find((d) => typeof d === 'object' && d.choices[0].delta.tool_calls);
		const calls = toolChunk.choices[0].delta.tool_calls;
		assert.equal(calls.length, 2);
		assert.deepEqual(
			calls.map((c) => [c.index, c.id]),
			[
				[0, 'a'],
				[1, 'b'],
			]
		);
		// no explicit finishReason but tool calls present → 'tool_calls'
		assert.equal(msgs[msgs.length - 2].data.choices[0].finish_reason, 'tool_calls');
	});

	it('handles an empty stream: announces role + stop + [DONE]', async () => {
		const msgs = await collect(openaiStream(gen(), {}));
		assert.equal(msgs.length, 2);
		assert.equal(msgs[0].data.choices[0].delta.role, 'assistant');
		assert.equal(msgs[0].data.choices[0].finish_reason, 'stop');
		assert.deepEqual(msgs[1], { data: '[DONE]' });
	});

	it('generates a chatcmpl- id when none is supplied, stable across all chunks', async () => {
		const msgs = await collect(openaiStream(gen({ deltaContent: 'a' }, { deltaContent: 'b' })));
		const ids = msgs.filter((m) => typeof m.data === 'object').map((m) => m.data.id);
		assert.ok(ids[0].startsWith('chatcmpl-'));
		assert.ok(new Set(ids).size === 1, 'id must be identical across every chunk');
	});

	it('accumulates tool arguments across partial deltas without re-copying', async () => {
		const msgs = await collect(
			openaiStream(
				gen(
					{ deltaToolCalls: [{ id: 'c1', name: 'fn', arguments: { a: 1 } }] },
					{ deltaToolCalls: [{ id: 'c1', arguments: { b: 2 } }] },
					{ deltaToolCalls: [{ id: 'c1', arguments: { a: 3 } }] }
				)
			)
		);
		const toolChunk = msgs.map((m) => m.data).find((d) => typeof d === 'object' && d.choices?.[0]?.delta?.tool_calls);
		const args = JSON.parse(toolChunk.choices[0].delta.tool_calls[0].function.arguments);
		assert.deepEqual(args, { a: 3, b: 2 }, 'later deltas must win, earlier fields preserved');
	});

	it('stores a tool argument literally named __proto__ instead of hitting the prototype setter', async () => {
		// Arguments arrive from JSON.parse, where `__proto__` is an own property. Object.assign
		// uses [[Set]], so an ordinary accumulator would invoke Object.prototype's inherited
		// setter and silently drop the field.
		const incoming = JSON.parse('{"__proto__": {"polluted": true}, "safe": 1}');
		const msgs = await collect(openaiStream(gen({ deltaToolCalls: [{ id: 'c1', name: 'fn', arguments: incoming }] })));
		const toolChunk = msgs.map((m) => m.data).find((d) => typeof d === 'object' && d.choices?.[0]?.delta?.tool_calls);
		const raw = toolChunk.choices[0].delta.tool_calls[0].function.arguments;
		const args = JSON.parse(raw);
		assert.equal(args.safe, 1);
		assert.ok(raw.includes('__proto__'), `__proto__ field must survive serialization, got: ${raw}`);
		assert.equal({}.polluted, undefined, 'must not pollute Object.prototype');
	});

	// A backend that throws partway through the stream (Models#wrapStream re-throws
	// mid-stream errors). The loop must convert that into a final data:{error} frame,
	// not let the throw propagate and tear the connection down.
	async function* throwingGen() {
		yield { deltaContent: 'partial' };
		throw Object.assign(new Error('backend exploded'), { statusCode: 502 });
	}

	it('emits a formatError-shaped error frame and no [DONE] when the backend throws mid-stream', async () => {
		const msgs = await collect(
			openaiStream(throwingGen(), {
				formatError: (err) => ({ message: err.message, type: 'server_error', code: 'backend_error', param: null }),
			})
		);
		// the partial content chunk streamed before the throw
		assert.equal(msgs[0].data.choices[0].delta.content, 'partial');
		const last = msgs[msgs.length - 1].data;
		assert.ok(last.error, 'expected a terminal error frame');
		assert.equal(last.error.message, 'backend exploded');
		assert.equal(last.error.type, 'server_error');
		assert.equal(last.error.code, 'backend_error');
		// OpenAI terminates on error — no [DONE] sentinel after the error frame
		assert.ok(!msgs.some((m) => m.data === '[DONE]'), 'must not emit [DONE] after a mid-stream error');
	});

	it('falls back to a generic server_error frame when no formatError is supplied', async () => {
		const msgs = await collect(openaiStream(throwingGen()));
		const last = msgs[msgs.length - 1].data;
		assert.equal(last.error.type, 'server_error');
		assert.equal(last.error.message, 'Internal server error');
	});

	it('serializes the error frame through the SSE serializer as a data: line', async () => {
		const msgs = await collect(
			openaiStream(throwingGen(), {
				formatError: () => ({ message: 'x', type: 'server_error', code: null, param: null }),
			})
		);
		const errFrame = msgs.find((m) => typeof m.data === 'object' && m.data.error);
		const wire = sse.serialize(errFrame);
		assert.ok(wire.startsWith('data: '), `unexpected SSE framing: ${wire}`);
		assert.ok(wire.includes('"error"'));
	});
});
