/**
 * Anthropic backend integration test (#633, Phase 6 of #510).
 *
 * Exercises `AnthropicBackend` against the real Anthropic API to validate
 * that the mocked wire format used in unit tests matches what the API
 * actually produces. SKIPS when `ANTHROPIC_API_KEY` is unset.
 *
 * Override defaults via env:
 *   - `ANTHROPIC_API_KEY`        (required to run)
 *   - `ANTHROPIC_MODEL`          (default `claude-opus-4-7`)
 *   - `ANTHROPIC_BASE_URL`       (default `https://api.anthropic.com`)
 *
 * Dynamic import inside before() — same workaround as openai for the
 * pre-existing CJS require cycle (`harper_logger` ↔ `common_utils`).
 */
import { suite, test, before } from 'node:test';
import { strictEqual, ok } from 'node:assert/strict';

type AnthropicBackendCtor = new (
	config: { apiKey: string; model?: string; baseUrl?: string; requestTimeoutMs?: number },
	fetchImpl?: typeof fetch
) => {
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

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-opus-4-7';
const BASE_URL = process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com';

const ACCOUNTING = { tenantId: 'integration', app: '/integration' };

const skip = !API_KEY;

suite('AnthropicBackend against the real Anthropic API', { skip }, () => {
	let backend: InstanceType<AnthropicBackendCtor>;

	before(async () => {
		const mod = (await import('../../components/anthropic/index.ts')) as { AnthropicBackend: AnthropicBackendCtor };
		backend = new mod.AnthropicBackend({ apiKey: API_KEY!, baseUrl: BASE_URL });
	});

	test('generate produces non-empty content', async () => {
		const result = await backend.generate('Reply with just OK.', {
			accounting: ACCOUNTING,
			model: MODEL,
			maxTokens: 10,
			temperature: 0,
		});
		strictEqual(result.status, 'completed');
		ok(typeof result.output.content === 'string' && result.output.content.length > 0);
		ok(['stop', 'length', 'tool_calls'].includes(result.output.finishReason));
	});

	test('generate via messages-array with system prompt', async () => {
		const result = await backend.generate(
			{
				messages: [{ role: 'user', content: 'reply OK' }],
				system: 'be brief',
			},
			{ accounting: ACCOUNTING, model: MODEL, maxTokens: 10, temperature: 0 }
		);
		strictEqual(result.status, 'completed');
		ok(typeof result.output.content === 'string' && result.output.content.length > 0);
	});

	test('generate with tools (toolMode: return) surfaces tool_use blocks', async () => {
		const tools = [
			{
				name: 'get_weather',
				description: 'Get current weather for a location',
				parameters: {
					type: 'object',
					properties: { location: { type: 'string' } },
					required: ['location'],
				},
			},
		];
		const result = await backend.generate(
			{
				messages: [{ role: 'user', content: 'Weather in Tokyo? Call the tool.' }],
				tools,
			},
			{ accounting: ACCOUNTING, model: MODEL, maxTokens: 256, temperature: 0 }
		);
		strictEqual(result.status, 'completed');
		if (result.output.finishReason === 'tool_calls') {
			ok(Array.isArray(result.output.toolCalls));
			ok((result.output.toolCalls?.length ?? 0) > 0);
			const tc = result.output.toolCalls![0] as { name: string; arguments: object };
			strictEqual(tc.name, 'get_weather');
		}
	});

	test('generateStream yields content + finishReason', async () => {
		const chunks: { deltaContent?: string; finishReason?: string }[] = [];
		for await (const chunk of backend.generateStream('Count: 1 2 3.', {
			accounting: ACCOUNTING,
			model: MODEL,
			maxTokens: 30,
			temperature: 0,
		})) {
			chunks.push(chunk);
		}
		ok(chunks.length > 0);
		const hasContent = chunks.some((c) => typeof c.deltaContent === 'string' && c.deltaContent.length > 0);
		ok(hasContent);
		const terminal = chunks[chunks.length - 1];
		ok(['stop', 'length', 'tool_calls'].includes(terminal.finishReason ?? ''));
	});
});
