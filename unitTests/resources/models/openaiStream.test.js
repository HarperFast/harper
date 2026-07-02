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
});
