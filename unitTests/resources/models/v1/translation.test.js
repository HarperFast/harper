'use strict';

/**
 * Pure-mapper unit tests for `resources/models/v1/translation.ts` (#631).
 *
 * No I/O, no Harper server — just input→output assertions on the shape translators.
 */

const assert = require('node:assert');
const {
	translateMessages,
	translateTools,
	toGenerateInput,
	toGenerateOpts,
	toEmbedOpts,
	toChatCompletion,
	toEmbedResponse,
} = require('#src/resources/models/v1/translation');

// ---------------------------------------------------------------------------
// translateMessages
// ---------------------------------------------------------------------------

describe('translateMessages', () => {
	it('maps a simple user message', () => {
		const result = translateMessages([{ role: 'user', content: 'hi' }]);
		assert.equal(result.length, 1);
		assert.equal(result[0].role, 'user');
		assert.equal(result[0].content, 'hi');
	});

	it('maps null content to empty string', () => {
		const result = translateMessages([{ role: 'assistant', content: null }]);
		assert.equal(result[0].content, '');
	});

	it('parses tool_calls arguments from JSON string to object', () => {
		const result = translateMessages([
			{
				role: 'assistant',
				content: null,
				tool_calls: [
					{
						id: 'call_abc',
						type: 'function',
						function: { name: 'get_weather', arguments: '{"city":"NYC"}' },
					},
				],
			},
		]);
		assert.ok(Array.isArray(result[0].toolCalls));
		assert.equal(result[0].toolCalls[0].id, 'call_abc');
		assert.equal(result[0].toolCalls[0].name, 'get_weather');
		assert.deepEqual(result[0].toolCalls[0].arguments, { city: 'NYC' });
	});

	it('keeps unparseable arguments under _raw sentinel', () => {
		const result = translateMessages([
			{
				role: 'assistant',
				content: null,
				tool_calls: [
					{
						id: 'c1',
						type: 'function',
						function: { name: 'fn', arguments: 'not-json' },
					},
				],
			},
		]);
		assert.deepEqual(result[0].toolCalls[0].arguments, { _raw: 'not-json' });
	});

	it('maps tool_call_id to toolCallId on tool role messages', () => {
		const result = translateMessages([{ role: 'tool', content: '42', tool_call_id: 'call_1' }]);
		assert.equal(result[0].toolCallId, 'call_1');
	});
});

// ---------------------------------------------------------------------------
// translateTools
// ---------------------------------------------------------------------------

describe('translateTools', () => {
	it('maps OpenAI tool definitions to ToolDef', () => {
		const tools = translateTools([
			{
				type: 'function',
				function: {
					name: 'search',
					description: 'Search the web',
					parameters: { type: 'object', properties: { query: { type: 'string' } } },
				},
			},
		]);
		assert.equal(tools.length, 1);
		assert.equal(tools[0].name, 'search');
		assert.equal(tools[0].description, 'Search the web');
		assert.deepEqual(tools[0].parameters, { type: 'object', properties: { query: { type: 'string' } } });
	});

	it('uses empty string for missing description and empty object for missing parameters', () => {
		const tools = translateTools([{ type: 'function', function: { name: 'noop' } }]);
		assert.equal(tools[0].description, '');
		assert.deepEqual(tools[0].parameters, {});
	});
});

// ---------------------------------------------------------------------------
// toGenerateInput
// ---------------------------------------------------------------------------

describe('toGenerateInput', () => {
	const msgs = [{ role: 'user', content: 'hello' }];

	it('returns Message[] when no tools', () => {
		const input = toGenerateInput(msgs, undefined);
		assert.ok(Array.isArray(input));
	});

	it('returns object form { messages, tools } when tools present', () => {
		const tools = [{ name: 'x', description: '', parameters: {} }];
		const input = toGenerateInput(msgs, tools);
		assert.ok(!Array.isArray(input));
		assert.deepEqual(input.messages, msgs);
		assert.deepEqual(input.tools, tools);
	});

	it('returns Message[] when tools array is empty', () => {
		const input = toGenerateInput(msgs, []);
		assert.ok(Array.isArray(input));
	});
});

// ---------------------------------------------------------------------------
// toGenerateOpts
// ---------------------------------------------------------------------------

describe('toGenerateOpts', () => {
	it('maps model, temperature, max_tokens', () => {
		const opts = toGenerateOpts({ model: 'my-model', temperature: 0.5, max_tokens: 100, messages: [] });
		assert.equal(opts.model, 'my-model');
		assert.equal(opts.temperature, 0.5);
		assert.equal(opts.maxTokens, 100);
	});

	it('prefers max_completion_tokens over max_tokens', () => {
		const opts = toGenerateOpts({ max_tokens: 100, max_completion_tokens: 200, messages: [] });
		assert.equal(opts.maxTokens, 200);
	});

	it('maps response_format json_object to json', () => {
		const opts = toGenerateOpts({ response_format: { type: 'json_object' }, messages: [] });
		assert.equal(opts.responseFormat, 'json');
	});

	it('maps response_format json_schema to { schema }', () => {
		const schema = { type: 'object', properties: {} };
		const opts = toGenerateOpts({
			response_format: { type: 'json_schema', json_schema: schema },
			messages: [],
		});
		assert.deepEqual(opts.responseFormat, { schema });
	});

	it('maps response_format text to text', () => {
		const opts = toGenerateOpts({ response_format: { type: 'text' }, messages: [] });
		assert.equal(opts.responseFormat, 'text');
	});

	it('always sets toolMode to return', () => {
		const opts = toGenerateOpts({ messages: [] });
		assert.equal(opts.toolMode, 'return');
	});
});

// ---------------------------------------------------------------------------
// toEmbedOpts
// ---------------------------------------------------------------------------

describe('toEmbedOpts', () => {
	it('maps model field', () => {
		assert.equal(toEmbedOpts({ model: 'embed-v1' }).model, 'embed-v1');
	});

	it('returns empty opts when model absent', () => {
		assert.deepEqual(toEmbedOpts({}), {});
	});
});

// ---------------------------------------------------------------------------
// toChatCompletion
// ---------------------------------------------------------------------------

describe('toChatCompletion', () => {
	const baseResult = {
		content: 'Hello!',
		finishReason: 'stop',
		usage: { promptTokens: 10, completionTokens: 5 },
	};

	it('builds a valid chat.completion object', () => {
		const resp = toChatCompletion(baseResult, 'gpt-test', 'chatcmpl-fixed');
		assert.equal(resp.id, 'chatcmpl-fixed');
		assert.equal(resp.object, 'chat.completion');
		assert.equal(resp.model, 'gpt-test');
		assert.equal(resp.choices.length, 1);
		assert.equal(resp.choices[0].finish_reason, 'stop');
		assert.equal(resp.choices[0].message.role, 'assistant');
		assert.equal(resp.choices[0].message.content, 'Hello!');
		assert.equal(resp.usage.prompt_tokens, 10);
		assert.equal(resp.usage.completion_tokens, 5);
		assert.equal(resp.usage.total_tokens, 15);
	});

	it('generates an id when none provided', () => {
		const resp = toChatCompletion(baseResult, 'm');
		assert.ok(resp.id.startsWith('chatcmpl-'));
	});

	it('sets content to null and includes tool_calls when toolCalls present', () => {
		const resp = toChatCompletion(
			{
				content: '',
				finishReason: 'tool_calls',
				toolCalls: [{ id: 'c1', name: 'search', arguments: { q: 'hi' } }],
			},
			'm',
			'id1'
		);
		assert.equal(resp.choices[0].message.content, null);
		assert.ok(Array.isArray(resp.choices[0].message.tool_calls));
		const tc = resp.choices[0].message.tool_calls[0];
		assert.equal(tc.id, 'c1');
		assert.equal(tc.type, 'function');
		assert.equal(tc.function.name, 'search');
		assert.deepEqual(JSON.parse(tc.function.arguments), { q: 'hi' });
	});

	it('uses zeros when usage absent', () => {
		const resp = toChatCompletion({ content: 'hi', finishReason: 'stop' }, 'm', 'id2');
		assert.equal(resp.usage.prompt_tokens, 0);
		assert.equal(resp.usage.completion_tokens, 0);
		assert.equal(resp.usage.total_tokens, 0);
	});
});

// ---------------------------------------------------------------------------
// toEmbedResponse
// ---------------------------------------------------------------------------

describe('toEmbedResponse', () => {
	it('converts Float32Array vectors to number arrays', () => {
		const vec = new Float32Array([0.1, -0.5, 0.9]);
		const resp = toEmbedResponse([vec], 'embed-v1', { embeddingTokens: 3 });
		assert.equal(resp.object, 'list');
		assert.equal(resp.model, 'embed-v1');
		assert.equal(resp.data.length, 1);
		assert.equal(resp.data[0].index, 0);
		assert.equal(resp.data[0].object, 'embedding');
		assert.ok(Array.isArray(resp.data[0].embedding));
		assert.equal(resp.data[0].embedding.length, 3);
		assert.equal(resp.usage.total_tokens, 3);
	});

	it('assigns sequential indices to multiple vectors', () => {
		const resp = toEmbedResponse([new Float32Array(2), new Float32Array(2)], 'm');
		assert.equal(resp.data[0].index, 0);
		assert.equal(resp.data[1].index, 1);
	});

	it('uses zero usage when absent', () => {
		const resp = toEmbedResponse([new Float32Array(1)], 'm');
		assert.equal(resp.usage.prompt_tokens, 0);
		assert.equal(resp.usage.total_tokens, 0);
	});

	it("encodes vectors as base64 float32 bytes for encodingFormat 'base64'", () => {
		const vec = new Float32Array([0.1, -0.5, 0.9]);
		const resp = toEmbedResponse([vec], 'm', undefined, 'base64');
		const embedding = resp.data[0].embedding;
		assert.equal(typeof embedding, 'string');
		const buf = Buffer.from(embedding, 'base64');
		assert.equal(buf.byteLength, vec.byteLength);
		// Copy into a fresh buffer before viewing as Float32Array — a pooled
		// Buffer's byteOffset is not guaranteed 4-byte-aligned.
		const roundTripped = new Float32Array(new Uint8Array(buf).buffer);
		assert.deepEqual(Array.from(roundTripped), Array.from(vec));
	});

	it('base64-encodes a subarray view without leaking surrounding buffer bytes', () => {
		const backing = new Float32Array([1, 2, 3, 4]);
		const view = backing.subarray(1, 3);
		const resp = toEmbedResponse([view], 'm', undefined, 'base64');
		const buf = Buffer.from(resp.data[0].embedding, 'base64');
		assert.equal(buf.byteLength, 8);
		assert.deepEqual(Array.from(new Float32Array(new Uint8Array(buf).buffer)), [2, 3]);
	});
});
