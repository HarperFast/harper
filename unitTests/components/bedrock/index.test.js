'use strict';

const assert = require('node:assert/strict');
const {
	BedrockBackend,
	registerBedrockBackend,
	_resetSdkCacheForTests,
	_injectSdkForTests,
} = require('#src/components/bedrock/index');
const { clearRegistry, resolveEmbedding, resolveGenerative } = require('#src/resources/models/backendRegistry');

const ACCOUNTING = { tenantId: 'tid', app: '/test' };

// A fake AWS SDK shape that mirrors the loose types in `components/bedrock/index.ts`.
// Each test wires its own responder to control what `client.send(command)` resolves to.
function fakeSdk(responder) {
	const sent = [];
	class FakeClient {
		constructor(config) {
			this.config = config;
		}
		async send(command, options) {
			sent.push({ command, options });
			return responder(command, options);
		}
	}
	class InvokeModelCommand {
		constructor(input) {
			this.kind = 'InvokeModel';
			Object.assign(this, input);
		}
	}
	class InvokeModelWithResponseStreamCommand {
		constructor(input) {
			this.kind = 'InvokeModelWithResponseStream';
			Object.assign(this, input);
		}
	}
	return {
		sdk: {
			BedrockRuntimeClient: FakeClient,
			InvokeModelCommand,
			InvokeModelWithResponseStreamCommand,
		},
		sent,
	};
}

function jsonBodyResponse(obj) {
	return { body: new TextEncoder().encode(JSON.stringify(obj)) };
}

async function* streamFromChunks(chunks) {
	for (const c of chunks) {
		yield { chunk: { bytes: new TextEncoder().encode(JSON.stringify(c)) } };
	}
}

describe('BedrockBackend', () => {
	beforeEach(() => _resetSdkCacheForTests());

	describe('shape', () => {
		it('reports name = "bedrock"', () => {
			const b = new BedrockBackend({ region: 'us-east-1', model: 'anthropic.claude' });
			assert.strictEqual(b.name, 'bedrock');
		});

		it('advertises capabilities matching the issue body', () => {
			const b = new BedrockBackend({ region: 'us-east-1' });
			assert.deepStrictEqual(b.capabilities(), {
				embed: true,
				generate: true,
				stream: true,
				tools: true,
				adapters: false,
			});
		});

		it('throws BedrockBackendError with install instructions when SDK is missing', async () => {
			// Default: no SDK injected → the lazy loader tries the real import
			// which fails because Harper does not depend on the SDK directly.
			const b = new BedrockBackend({ region: 'us-east-1', model: 'anthropic.claude' });
			await assert.rejects(
				() => b.generate('q', { accounting: ACCOUNTING }),
				/@aws-sdk\/client-bedrock-runtime is not installed/
			);
		});
	});

	describe('per-family generate dispatch', () => {
		it('dispatches anthropic.* models to the Anthropic Messages body shape', async () => {
			const { sdk, sent } = fakeSdk(() =>
				jsonBodyResponse({
					content: [{ type: 'text', text: 'hi' }],
					stop_reason: 'end_turn',
					usage: { input_tokens: 3, output_tokens: 1 },
				})
			);
			_injectSdkForTests(sdk);
			const b = new BedrockBackend({ region: 'us-east-1', model: 'anthropic.claude-opus-4-v1:0' });
			const result = await b.generate('hello', { accounting: ACCOUNTING });
			assert.strictEqual(result.output.content, 'hi');
			assert.strictEqual(result.output.finishReason, 'stop');
			assert.strictEqual(result.usage.promptTokens, 3);
			assert.strictEqual(result.usage.completionTokens, 1);
			const body = JSON.parse(sent[0].command.body);
			assert.strictEqual(body.anthropic_version, 'bedrock-2023-05-31');
			assert.deepStrictEqual(body.messages, [{ role: 'user', content: 'hello' }]);
			assert.ok(body.max_tokens > 0);
		});

		it('dispatches meta.* models to Llama prompt shape', async () => {
			const { sdk, sent } = fakeSdk(() =>
				jsonBodyResponse({
					generation: 'llama says hi',
					stop_reason: 'stop',
					prompt_token_count: 10,
					generation_token_count: 4,
				})
			);
			_injectSdkForTests(sdk);
			const b = new BedrockBackend({ region: 'us-east-1', model: 'meta.llama3-70b-instruct-v1:0' });
			const result = await b.generate('hi', { accounting: ACCOUNTING });
			assert.strictEqual(result.output.content, 'llama says hi');
			assert.strictEqual(result.usage.promptTokens, 10);
			assert.strictEqual(result.usage.completionTokens, 4);
			const body = JSON.parse(sent[0].command.body);
			assert.ok(typeof body.prompt === 'string');
			assert.ok(body.prompt.includes('hi'));
		});

		it('dispatches amazon.titan-* generate to Titan body shape', async () => {
			const { sdk } = fakeSdk(() =>
				jsonBodyResponse({
					inputTextTokenCount: 5,
					results: [{ outputText: 'titan says hi', tokenCount: 3, completionReason: 'FINISH' }],
				})
			);
			_injectSdkForTests(sdk);
			const b = new BedrockBackend({ region: 'us-east-1', model: 'amazon.titan-text-express-v1' });
			const result = await b.generate('q', { accounting: ACCOUNTING });
			assert.strictEqual(result.output.content, 'titan says hi');
			assert.strictEqual(result.usage.promptTokens, 5);
			assert.strictEqual(result.usage.completionTokens, 3);
		});

		it('rejects tools on a non-anthropic family with a structured error', async () => {
			const { sdk } = fakeSdk(() => jsonBodyResponse({ generation: 'x', stop_reason: 'stop' }));
			_injectSdkForTests(sdk);
			const b = new BedrockBackend({ region: 'us-east-1', model: 'meta.llama3-70b-instruct-v1:0' });
			const tools = [{ name: 'fn', description: 'd', parameters: { type: 'object', properties: {} } }];
			await assert.rejects(
				() => b.generate({ messages: [{ role: 'user', content: 'q' }], tools }, { accounting: ACCOUNTING }),
				/tool calls are not supported for model family 'meta'/
			);
		});

		it('still routes tools through anthropic.* models (no rejection)', async () => {
			const { sdk } = fakeSdk(() =>
				jsonBodyResponse({
					content: [{ type: 'text', text: 'hi' }],
					stop_reason: 'end_turn',
					usage: {},
				})
			);
			_injectSdkForTests(sdk);
			const b = new BedrockBackend({ region: 'us-east-1', model: 'anthropic.claude' });
			const tools = [{ name: 'fn', description: 'd', parameters: { type: 'object', properties: {} } }];
			// Doesn't throw.
			await b.generate({ messages: [{ role: 'user', content: 'q' }], tools }, { accounting: ACCOUNTING });
		});

		it('throws on unknown model family', async () => {
			const { sdk } = fakeSdk(() => jsonBodyResponse({}));
			_injectSdkForTests(sdk);
			const b = new BedrockBackend({ region: 'us-east-1', model: 'unknownvendor.foo-v1' });
			await assert.rejects(
				() => b.generate('q', { accounting: ACCOUNTING }),
				/not supported for model family 'unknown'/
			);
		});
	});

	describe('embed', () => {
		it('dispatches Titan embed model', async () => {
			const { sdk } = fakeSdk(() => jsonBodyResponse({ embedding: [0.1, 0.2, 0.3], inputTextTokenCount: 2 }));
			_injectSdkForTests(sdk);
			const b = new BedrockBackend({ region: 'us-east-1', model: 'amazon.titan-embed-text-v2:0' });
			const result = await b.embed('hello', { accounting: ACCOUNTING });
			assert.strictEqual(result.status, 'completed');
			assert.strictEqual(result.output.length, 1);
			assert.ok(result.output[0] instanceof Float32Array);
			assert.strictEqual(result.usage.embeddingTokens, 2);
		});

		it('dispatches Cohere embed model', async () => {
			const { sdk } = fakeSdk(() => jsonBodyResponse({ embeddings: [[0.4, 0.5]] }));
			_injectSdkForTests(sdk);
			const b = new BedrockBackend({ region: 'us-east-1', model: 'cohere.embed-english-v3' });
			const result = await b.embed('hi', { accounting: ACCOUNTING });
			assert.strictEqual(result.output.length, 1);
			assert.ok(result.output[0] instanceof Float32Array);
		});

		it("Cohere embed defaults input_type to 'search_document'", async () => {
			const { sdk, sent } = fakeSdk(() => jsonBodyResponse({ embeddings: [[0.4]] }));
			_injectSdkForTests(sdk);
			const b = new BedrockBackend({ region: 'us-east-1', model: 'cohere.embed-english-v3' });
			await b.embed('hi', { accounting: ACCOUNTING });
			const body = JSON.parse(sent[0].command.body);
			assert.strictEqual(body.input_type, 'search_document');
		});

		it("Cohere embed maps inputType='query' to input_type='search_query'", async () => {
			const { sdk, sent } = fakeSdk(() => jsonBodyResponse({ embeddings: [[0.4]] }));
			_injectSdkForTests(sdk);
			const b = new BedrockBackend({ region: 'us-east-1', model: 'cohere.embed-english-v3' });
			await b.embed('hi', { accounting: ACCOUNTING, inputType: 'query' });
			const body = JSON.parse(sent[0].command.body);
			assert.strictEqual(body.input_type, 'search_query');
		});

		it("Cohere embed maps inputType='document' to input_type='search_document'", async () => {
			const { sdk, sent } = fakeSdk(() => jsonBodyResponse({ embeddings: [[0.4]] }));
			_injectSdkForTests(sdk);
			const b = new BedrockBackend({ region: 'us-east-1', model: 'cohere.embed-english-v3' });
			await b.embed('hi', { accounting: ACCOUNTING, inputType: 'document' });
			const body = JSON.parse(sent[0].command.body);
			assert.strictEqual(body.input_type, 'search_document');
		});

		it('throws on a generative-only family asked to embed', async () => {
			const { sdk } = fakeSdk(() => jsonBodyResponse({}));
			_injectSdkForTests(sdk);
			const b = new BedrockBackend({ region: 'us-east-1', model: 'anthropic.claude-opus-4-v1:0' });
			await assert.rejects(
				() => b.embed('hi', { accounting: ACCOUNTING }),
				/embed not supported for model family 'anthropic'/
			);
		});
	});

	describe('generateStream', () => {
		it('streams Anthropic content_block_delta + finishReason', async () => {
			const { sdk } = fakeSdk(() => ({
				body: streamFromChunks([
					{ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
					{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } },
					{ type: 'content_block_stop', index: 0 },
					{ type: 'message_delta', delta: { stop_reason: 'end_turn' } },
				]),
			}));
			_injectSdkForTests(sdk);
			const b = new BedrockBackend({ region: 'us-east-1', model: 'anthropic.claude' });
			const chunks = [];
			for await (const c of b.generateStream('q', { accounting: ACCOUNTING })) chunks.push(c);
			assert.strictEqual(chunks[0].deltaContent, 'hello');
			assert.strictEqual(chunks[chunks.length - 1].finishReason, 'stop');
		});

		it('streams Llama generation chunks via flat parser', async () => {
			const { sdk } = fakeSdk(() => ({
				body: streamFromChunks([
					{ generation: 'one ' },
					{ generation: 'two' },
					{ generation: '', stop_reason: 'stop' },
				]),
			}));
			_injectSdkForTests(sdk);
			const b = new BedrockBackend({ region: 'us-east-1', model: 'meta.llama3-70b-instruct-v1:0' });
			const chunks = [];
			for await (const c of b.generateStream('q', { accounting: ACCOUNTING })) chunks.push(c);
			const contents = chunks.filter((c) => c.deltaContent).map((c) => c.deltaContent);
			assert.deepStrictEqual(contents, ['one ', 'two']);
			assert.strictEqual(chunks[chunks.length - 1].finishReason, 'stop');
		});

		it('throws BedrockBackendError on mid-stream Anthropic upstream error events', async () => {
			const { sdk } = fakeSdk(() => ({
				body: streamFromChunks([
					{ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
					{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } },
					{ type: 'error', error: { type: 'overloaded_error', message: 'Bedrock is overloaded' } },
				]),
			}));
			_injectSdkForTests(sdk);
			const b = new BedrockBackend({ region: 'us-east-1', model: 'anthropic.claude' });
			await assert.rejects(async () => {
				for await (const _c of b.generateStream('q', { accounting: ACCOUNTING })) {
					/* drain */
				}
			}, /stream aborted by upstream error: Bedrock is overloaded/);
		});

		it('caps Anthropic streaming tool-call arguments at 1 MiB', async () => {
			const half = 'x'.repeat(1 << 19);
			const { sdk } = fakeSdk(() => ({
				body: streamFromChunks([
					{ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'a', name: 'fn' } },
					{ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: half } },
					{ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: half } },
					{ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: half } },
				]),
			}));
			_injectSdkForTests(sdk);
			const b = new BedrockBackend({ region: 'us-east-1', model: 'anthropic.claude' });
			await assert.rejects(async () => {
				for await (const _c of b.generateStream(
					{ messages: [{ role: 'user', content: 'q' }] },
					{ accounting: ACCOUNTING }
				)) {
					/* drain */
				}
			}, /tool-call arguments exceed/);
		});
	});

	describe('AbortSignal', () => {
		it('passes caller signal into SDK send() abortSignal option', async () => {
			const ctrl = new AbortController();
			let seenOptions;
			const { sdk } = fakeSdk((_cmd, options) => {
				seenOptions = options;
				return jsonBodyResponse({ content: [{ type: 'text', text: '' }], stop_reason: 'end_turn', usage: {} });
			});
			_injectSdkForTests(sdk);
			const b = new BedrockBackend({ region: 'us-east-1', model: 'anthropic.claude' });
			await b.generate('q', { accounting: ACCOUNTING, signal: ctrl.signal });
			assert.strictEqual(seenOptions?.abortSignal, ctrl.signal);
		});

		it('composes caller signal with timeout via AbortSignal.any', async () => {
			const ctrl = new AbortController();
			let seenSignal;
			const { sdk } = fakeSdk((_cmd, options) => {
				seenSignal = options?.abortSignal;
				return jsonBodyResponse({ content: [{ type: 'text', text: '' }], stop_reason: 'end_turn', usage: {} });
			});
			_injectSdkForTests(sdk);
			const b = new BedrockBackend({ region: 'us-east-1', model: 'anthropic.claude', requestTimeoutMs: 10000 });
			await b.generate('q', { accounting: ACCOUNTING, signal: ctrl.signal });
			assert.ok(seenSignal instanceof AbortSignal);
			assert.notStrictEqual(seenSignal, ctrl.signal);
		});
	});
});

describe('registerBedrockBackend', () => {
	beforeEach(() => clearRegistry());

	it('registers as a generative backend', () => {
		registerBedrockBackend({
			logicalName: 'claude',
			kind: 'generative',
			config: { region: 'us-east-1', model: 'anthropic.claude-opus-4-v1:0' },
		});
		assert.strictEqual(resolveGenerative('claude').name, 'bedrock');
	});

	it('registers as an embedding backend', () => {
		registerBedrockBackend({
			logicalName: 'titan',
			kind: 'embedding',
			config: { region: 'us-east-1', model: 'amazon.titan-embed-text-v2:0' },
		});
		assert.strictEqual(resolveEmbedding('titan').name, 'bedrock');
	});
});
