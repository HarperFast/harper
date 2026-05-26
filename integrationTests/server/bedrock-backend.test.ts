/**
 * Bedrock backend integration test (#633, Phase 6 of #510).
 *
 * Exercises `BedrockBackend` against the real AWS Bedrock API. SKIPS when:
 *   - `RUN_BEDROCK_INTEGRATION` env is not set (opt-in — AWS calls cost money), OR
 *   - `@aws-sdk/client-bedrock-runtime` is not installed locally (it's an
 *     optional peerDependency, not a Harper direct dep).
 *
 * AWS credentials resolve via the SDK chain (env vars, IAM roles, shared
 * profile, etc.). Set the standard `AWS_REGION`, `AWS_ACCESS_KEY_ID`, and
 * `AWS_SECRET_ACCESS_KEY` (or use a profile) in the calling shell.
 *
 * Override defaults via env:
 *   - `BEDROCK_REGION`           (default `us-east-1`)
 *   - `BEDROCK_GENERATE_MODEL`   (default `anthropic.claude-3-haiku-20240307-v1:0`)
 *   - `BEDROCK_EMBED_MODEL`      (default `amazon.titan-embed-text-v2:0`)
 */
import { suite, test, before } from 'node:test';
import { strictEqual, ok } from 'node:assert/strict';

type BedrockBackendCtor = new (config: { region?: string; model?: string; requestTimeoutMs?: number }) => {
	embed: (input: string | string[], opts: object) => Promise<{ status: string; output: Float32Array[]; usage: object }>;
	generate: (
		input: unknown,
		opts: object
	) => Promise<{ status: string; output: { content: string; finishReason: string }; usage: object }>;
	generateStream: (input: unknown, opts: object) => AsyncIterable<{ deltaContent?: string; finishReason?: string }>;
};

const OPT_IN = process.env.RUN_BEDROCK_INTEGRATION === '1';
const REGION = process.env.BEDROCK_REGION ?? 'us-east-1';
const GEN_MODEL = process.env.BEDROCK_GENERATE_MODEL ?? 'anthropic.claude-3-haiku-20240307-v1:0';
const EMBED_MODEL = process.env.BEDROCK_EMBED_MODEL ?? 'amazon.titan-embed-text-v2:0';

const ACCOUNTING = { tenantId: 'integration', app: '/integration' };

async function sdkInstalled(): Promise<boolean> {
	try {
		// @ts-expect-error optional peerDependency
		await import('@aws-sdk/client-bedrock-runtime');
		return true;
	} catch {
		return false;
	}
}

const skip = !OPT_IN || !(await sdkInstalled());

suite('BedrockBackend against the real AWS Bedrock API', { skip }, () => {
	let Ctor: BedrockBackendCtor;

	before(async () => {
		const mod = (await import('../../components/bedrock/index.ts')) as { BedrockBackend: BedrockBackendCtor };
		Ctor = mod.BedrockBackend;
	});

	test('generate against an Anthropic-on-Bedrock model', async () => {
		const backend = new Ctor({ region: REGION, model: GEN_MODEL });
		const result = await backend.generate('Reply with just OK.', {
			accounting: ACCOUNTING,
			maxTokens: 20,
			temperature: 0,
		});
		strictEqual(result.status, 'completed');
		ok(typeof result.output.content === 'string' && result.output.content.length > 0);
	});

	test('generateStream against an Anthropic-on-Bedrock model', async () => {
		const backend = new Ctor({ region: REGION, model: GEN_MODEL });
		const chunks: { deltaContent?: string; finishReason?: string }[] = [];
		for await (const c of backend.generateStream('Count: 1 2 3.', {
			accounting: ACCOUNTING,
			maxTokens: 30,
			temperature: 0,
		})) {
			chunks.push(c);
		}
		ok(chunks.length > 0);
		const hasContent = chunks.some((c) => typeof c.deltaContent === 'string' && c.deltaContent.length > 0);
		ok(hasContent);
		const terminal = chunks[chunks.length - 1];
		ok(['stop', 'length', 'tool_calls'].includes(terminal.finishReason ?? ''));
	});

	test('embed against a Titan embedding model', async () => {
		const backend = new Ctor({ region: REGION, model: EMBED_MODEL });
		const result = await backend.embed('integration test', { accounting: ACCOUNTING });
		strictEqual(result.status, 'completed');
		strictEqual(result.output.length, 1);
		ok(result.output[0] instanceof Float32Array);
		ok(result.output[0].length > 0);
	});
});
