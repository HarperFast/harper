/**
 * OpenAI backend integration test (#630, Phase 3 of #510).
 *
 * Exercises `OpenAIBackend` end-to-end against the real OpenAI HTTP API to
 * validate that the mocked wire format used in unit tests matches what
 * OpenAI actually produces.
 *
 * The suite SKIPS when `OPENAI_API_KEY` is unset. Set:
 *   - `OPENAI_API_KEY`           (required to run)
 *   - `OPENAI_EMBED_MODEL`       (default `text-embedding-3-small`)
 *   - `OPENAI_GENERATE_MODEL`    (default `gpt-4o-mini`)
 *   - `OPENAI_BASE_URL`          (default `https://api.openai.com/v1`)
 *
 * The full app→Resource→harper.models path is covered by the unit-test
 * suites for jsLoader (`harper.models` export, from Phase 2), bootstrap
 * (registry wiring), and OpenAIBackend (call dispatch). This file is the
 * contract check against the real OpenAI HTTP surface.
 */
import { suite, test, before } from 'node:test';
import { strictEqual, ok } from 'node:assert/strict';
import type { GenerateChunk, GenerateOpts, GenerateResult, Models as ModelsApi } from '../../resources/models/types.ts';

// NOTE: `OpenAIBackend` is imported dynamically inside `before()` rather than
// at the top of the file. Statically importing it from `components/openai/`
// triggers a pre-existing require cycle in Harper's CommonJS graph
// (`utility/common_utils.ts` ↔ `utility/logging/harper_logger.ts`) when this
// test file is loaded by `node --test`, fatal on Node 22+ (ERR_REQUIRE_CYCLE_MODULE).
// Same workaround as `integrationTests/server/ollama-backend.test.ts`.

type OpenAIBackendCtor = new (
	config: { apiKey: string; model?: string; baseUrl?: string; requestTimeoutMs?: number; organization?: string },
	fetchImpl?: typeof fetch
) => {
	embed: (
		input: string | string[],
		opts: object
	) => Promise<{ status: string; output: Float32Array[]; usage: { embeddingTokens?: number } }>;
	generate: (
		input: unknown,
		opts: object
	) => Promise<{
		status: string;
		output: { content: string; finishReason: string; toolCalls?: unknown[] };
		usage: object;
	}>;
	generateStream: (
		input: unknown,
		opts: object
	) => AsyncIterable<{ deltaContent?: string; deltaToolCalls?: unknown[]; finishReason?: string }>;
};

const API_KEY = process.env.OPENAI_API_KEY;
const EMBED_MODEL = process.env.OPENAI_EMBED_MODEL ?? 'text-embedding-3-small';
const GENERATE_MODEL = process.env.OPENAI_GENERATE_MODEL ?? 'gpt-4o-mini';
const BASE_URL = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';

const ACCOUNTING = { tenantId: 'integration', app: '/integration' };

const skip = !API_KEY;

suite('OpenAIBackend against the real OpenAI API', { skip }, () => {
	let backend: InstanceType<OpenAIBackendCtor>;

	before(async () => {
		const mod = (await import('../../components/openai/index.ts')) as { OpenAIBackend: OpenAIBackendCtor };
		backend = new mod.OpenAIBackend({
			apiKey: API_KEY!,
			baseUrl: BASE_URL,
		});
	});

	test('embed returns a non-empty Float32Array vector', async () => {
		const result = await backend.embed('integration test', {
			accounting: ACCOUNTING,
			model: EMBED_MODEL,
		});
		strictEqual(result.status, 'completed');
		ok(Array.isArray(result.output));
		strictEqual(result.output.length, 1);
		ok(result.output[0] instanceof Float32Array);
		ok(result.output[0].length > 0, 'expected non-empty vector');
		ok(typeof result.usage.embeddingTokens === 'number' && result.usage.embeddingTokens > 0);
	});

	test('embed returns multiple vectors for an array input', async () => {
		const result = await backend.embed(['one', 'two'], {
			accounting: ACCOUNTING,
			model: EMBED_MODEL,
		});
		strictEqual(result.status, 'completed');
		strictEqual(result.output.length, 2);
	});

	test('generate produces non-empty content', async () => {
		const result = await backend.generate('Reply with the single word OK.', {
			accounting: ACCOUNTING,
			model: GENERATE_MODEL,
			maxTokens: 10,
			temperature: 0,
		});
		strictEqual(result.status, 'completed');
		ok(typeof result.output.content === 'string' && result.output.content.length > 0);
		ok(['stop', 'length'].includes(result.output.finishReason));
	});

	test('generate via messages-array shape produces non-empty content', async () => {
		const result = await backend.generate([{ role: 'user', content: 'Reply with the single word OK.' }], {
			accounting: ACCOUNTING,
			model: GENERATE_MODEL,
			maxTokens: 10,
			temperature: 0,
		});
		strictEqual(result.status, 'completed');
		ok(typeof result.output.content === 'string' && result.output.content.length > 0);
	});

	test('generate with tools (toolMode: return) surfaces a tool_calls response', async () => {
		const tools = [
			{
				name: 'get_weather',
				description: 'Get the current weather for a location',
				parameters: {
					type: 'object',
					properties: { location: { type: 'string', description: 'City name' } },
					required: ['location'],
				},
			},
		];
		const result = await backend.generate(
			{
				messages: [{ role: 'user', content: 'What is the weather in San Francisco? Use the tool.' }],
				tools,
			},
			{ accounting: ACCOUNTING, model: GENERATE_MODEL, temperature: 0, toolMode: 'return' }
		);
		strictEqual(result.status, 'completed');
		// The model SHOULD call the tool given the directive. If it didn't,
		// finishReason will be 'stop' instead of 'tool_calls' — that's a model
		// decision, not a contract failure. We assert structure when present.
		if (result.output.finishReason === 'tool_calls') {
			ok(Array.isArray(result.output.toolCalls));
			ok((result.output.toolCalls?.length ?? 0) > 0);
			const tc = result.output.toolCalls![0] as { id: string; name: string; arguments: object };
			strictEqual(tc.name, 'get_weather');
			ok(typeof tc.arguments === 'object' && tc.arguments !== null);
		}
	});

	test('generateStream yields content chunks and a terminating finishReason', async () => {
		const chunks: { deltaContent?: string; finishReason?: string }[] = [];
		for await (const chunk of backend.generateStream('Count: 1 2 3.', {
			accounting: ACCOUNTING,
			model: GENERATE_MODEL,
			maxTokens: 20,
			temperature: 0,
		})) {
			chunks.push(chunk);
		}
		ok(chunks.length > 0, 'expected at least one chunk');
		const hasContent = chunks.some((c) => typeof c.deltaContent === 'string' && c.deltaContent.length > 0);
		ok(hasContent, 'expected at least one chunk with deltaContent');
		const terminal = chunks[chunks.length - 1];
		ok(['stop', 'length'].includes(terminal.finishReason ?? ''));
	});

	test('generateStream with tools accumulates and surfaces a fully-assembled tool call', async () => {
		const tools = [
			{
				name: 'get_weather',
				description: 'Get the current weather for a location',
				parameters: {
					type: 'object',
					properties: { location: { type: 'string' } },
					required: ['location'],
				},
			},
		];
		const chunks: { deltaContent?: string; deltaToolCalls?: unknown[]; finishReason?: string }[] = [];
		for await (const chunk of backend.generateStream(
			{
				messages: [{ role: 'user', content: 'Weather in Tokyo? Use the tool.' }],
				tools,
			},
			{ accounting: ACCOUNTING, model: GENERATE_MODEL, temperature: 0 }
		)) {
			chunks.push(chunk);
		}
		ok(chunks.length > 0);
		const terminal = chunks[chunks.length - 1];
		if (terminal.finishReason === 'tool_calls') {
			ok(Array.isArray(terminal.deltaToolCalls));
			ok((terminal.deltaToolCalls?.length ?? 0) > 0);
		}
	});

	test('AbortSignal cancels an in-flight stream', async () => {
		const ctrl = new AbortController();
		const iter = backend
			.generateStream('Write a long paragraph about the ocean and waves and tides.', {
				accounting: ACCOUNTING,
				model: GENERATE_MODEL,
				signal: ctrl.signal,
				maxTokens: 1000,
				temperature: 0.5,
			})
			[Symbol.asyncIterator]();
		// Get one chunk to confirm the stream started, then abort.
		await iter.next();
		ctrl.abort();
		// After abort, the iterator must terminate — either by rejecting
		// (AbortError) or by reaching `done`. The real failure mode this
		// guards against is the stream hanging. Race a 5 s deadline.
		const drain = (async () => {
			try {
				while (true) {
					const next = await iter.next();
					if (next.done) return 'done' as const;
				}
			} catch (err) {
				const name = (err as Error).name;
				const isAbort = name === 'AbortError' || /abort/i.test(String(err));
				return isAbort ? ('aborted' as const) : ('errored' as const);
			}
		})();
		const HANG = Symbol('hang');
		const deadline = new Promise<typeof HANG>((resolve) => setTimeout(() => resolve(HANG), 5000));
		const outcome = await Promise.race([drain, deadline]);
		ok(
			outcome === 'done' || outcome === 'aborted',
			`expected abort to terminate stream (done or AbortError); got ${String(outcome)}`
		);
	});
});

/**
 * The `toolMode: 'auto'` agent loop (#612 / #851) end-to-end over the REAL OpenAI
 * backend. The unit suite (`unitTests/resources/models/agentLoop.test.js`) proves the
 * loop's logic against a scripted backend; this suite proves it drives a real
 * tool-calling model — a genuine `tool_calls` round is dispatched through
 * `opts.toolHandlers`, the result is fed back, and the model produces a terminal
 * answer GROUNDED in that result — plus the same over the streaming path. Skipped
 * without `OPENAI_API_KEY`, same posture as the backend-direct suite above.
 *
 * Wiring: we drive `runAgentLoop` / `runAgentLoopStream` directly with a thin `Models`
 * stand-in over the real `OpenAIBackend`. The stand-in replicates exactly what
 * `Models.generate`'s single-shot path does (unwrap `ModelCallResult`, merge `usage`
 * onto the output) and nothing more. This is deliberate: the loop is the engine under
 * review, and importing the full `Models` facade here pulls the `transaction → databases
 * → Table` graph, which doesn't resolve under bare `node --test`. `Models.generate`'s
 * two-line `toolMode === 'auto'` delegation is covered by `Models.test.js` instead.
 */
suite('toolMode:auto agent loop over the real OpenAI backend', { skip }, () => {
	type AgentLoopMod = typeof import('../../resources/models/agentLoop.ts');
	let runLoop: AgentLoopMod['runAgentLoop'];
	let runLoopStream: AgentLoopMod['runAgentLoopStream'];
	let models: Pick<ModelsApi, 'generate' | 'generateStream'>;

	const weatherTool = {
		name: 'get_weather',
		description: 'Get the current weather for a location. Always use this for any weather question.',
		parameters: {
			type: 'object',
			properties: { location: { type: 'string', description: 'City name' } },
			required: ['location'],
		},
	};

	before(async () => {
		// Import BOTH the loop and the backend from COMPILED dist (relative `../../dist/...`,
		// the established integration-test convention — see `integrationTests/deploy/*.test.ts`),
		// NOT the `.ts` source. The source graph pulls `hdbError → harper_logger` and the backend
		// pulls `common_utils → harper_logger`, hitting Harper's documented
		// `common_utils ↔ harper_logger` require cycle that is fatal under `node --test`'s ESM
		// loader (`ERR_REQUIRE_CYCLE_MODULE`). The CJS dist tolerates the cycle. Requires a prior
		// `npm run build` (the integration job builds before testing); the loop's logic itself
		// is unit-tested from source in `unitTests/resources/models/agentLoop.test.js`.
		const loop = (await import('../../dist/resources/models/agentLoop.js')) as AgentLoopMod;
		runLoop = loop.runAgentLoop;
		runLoopStream = loop.runAgentLoopStream;
		const mod = (await import('../../dist/components/openai/index.js')) as unknown as {
			OpenAIBackend: OpenAIBackendCtor;
		};
		// Constructed WITH a model so the inner `toolMode: 'return'` calls need no per-call model.
		const backend = new mod.OpenAIBackend({ apiKey: API_KEY!, baseUrl: BASE_URL, model: GENERATE_MODEL });
		models = {
			async generate(input, opts: GenerateOpts = {}) {
				const r = await backend.generate(input, { ...opts, accounting: ACCOUNTING });
				if (r.status !== 'completed') throw new Error(`backend returned status '${r.status}'`);
				// Mirror Models.generate: surface usage on the output for the loop's budget tally.
				return (r.usage ? { ...r.output, usage: r.usage } : r.output) as GenerateResult;
			},
			generateStream(input, opts: GenerateOpts = {}) {
				return backend.generateStream(input, { ...opts, accounting: ACCOUNTING }) as AsyncIterable<GenerateChunk>;
			},
		};
	});

	test('resolves a real tool call and grounds the final answer in the tool result', async () => {
		const calls: { location?: string }[] = [];
		const result = await runLoop({
			models: models as ModelsApi,
			input: {
				messages: [
					{
						role: 'user',
						content:
							'What is the current weather in San Francisco? You must call the get_weather tool, then answer in one sentence.',
					},
				],
				tools: [weatherTool],
			},
			opts: {
				temperature: 0,
				includeToolTrace: true,
				toolHandlers: {
					get_weather: (args: { location?: string }) => {
						calls.push(args);
						// A sentinel the model can only surface by actually receiving the tool
						// result back through the loop — not from its own training data.
						return { tempF: 72, conditions: 'foggy' };
					},
				},
			},
			accounting: ACCOUNTING,
		});

		ok(calls.length >= 1, 'the loop must dispatch the real tool call');
		ok(
			/san|francisco/i.test(String(calls[0].location ?? '')),
			`expected a location arg; got ${JSON.stringify(calls[0])}`
		);
		strictEqual(result.finishReason, 'stop');
		ok(result.content.length > 0, 'expected a terminal answer');
		ok(/72|fog/i.test(result.content), `final answer should reflect the tool result; got: ${result.content}`);
		ok(Array.isArray(result.trace) && result.trace.length >= 1, 'trace populated with includeToolTrace');
		const entry = result.trace!.find((e) => e.toolName === 'get_weather');
		ok(entry, 'trace should include the get_weather invocation');
		ok(/72/.test(entry!.result ?? ''), 'trace should capture the serialized tool result');
	});

	test('streaming auto loop dispatches the tool and emits one terminal finishReason after content', async () => {
		const calls: unknown[] = [];
		const chunks: GenerateChunk[] = [];
		for await (const chunk of runLoopStream({
			models: models as ModelsApi,
			input: {
				messages: [
					{
						role: 'user',
						content: 'What is the weather in Tokyo? You must call get_weather, then answer in one sentence.',
					},
				],
				tools: [weatherTool],
			},
			opts: {
				temperature: 0,
				toolHandlers: {
					get_weather: (a: unknown) => {
						calls.push(a);
						return { tempF: 72, conditions: 'foggy' };
					},
				},
			},
			accounting: ACCOUNTING,
		})) {
			chunks.push(chunk);
		}

		ok(calls.length >= 1, 'streaming loop must dispatch the tool');
		const text = chunks.map((c) => c.deltaContent ?? '').join('');
		ok(text.length > 0, 'expected streamed content');
		ok(/72|fog/i.test(text), `streamed answer should reflect the tool result; got: ${text}`);
		// The loop strips inline finishReasons and re-emits exactly one terminal chunk
		// AFTER any conversation append — assert that contract holds over the real wire.
		const finals = chunks.filter((c) => c.finishReason);
		strictEqual(finals.length, 1, 'exactly one terminal finishReason chunk');
		strictEqual(finals[0].finishReason, 'stop');
		strictEqual(finals[0].deltaContent, undefined, 'terminal chunk carries no content');
	});

	test('terminal-first answer (no tools needed) passes through without dispatching', async () => {
		const calls: unknown[] = [];
		const result = await runLoop({
			models: models as ModelsApi,
			input: 'Reply with exactly the single word: OK',
			opts: {
				temperature: 0,
				includeToolTrace: true,
				toolHandlers: {
					get_weather: (a: unknown) => {
						calls.push(a);
						return {};
					},
				},
			},
			accounting: ACCOUNTING,
		});

		strictEqual(result.finishReason, 'stop');
		ok(result.content.length > 0, 'expected a terminal answer');
		strictEqual(calls.length, 0, 'no tool should be dispatched when none is needed');
		ok(Array.isArray(result.trace) && result.trace.length === 0, 'empty trace when no tools ran');
	});
});
