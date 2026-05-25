/**
 * Ollama backend integration test (#629, Phase 2 of #510).
 *
 * Exercises `OllamaBackend` end-to-end against a real local Ollama HTTP API
 * to validate that the mocked wire format used in unit tests matches what
 * Ollama actually produces.
 *
 * The suite SKIPS when:
 *   - `OLLAMA_HOST` (default `http://localhost:11434`) is unreachable, OR
 *   - the configured embedding / generative models aren't pulled.
 *
 * Override defaults via env:
 *   - `OLLAMA_HOST`            (default `http://localhost:11434`)
 *   - `OLLAMA_EMBED_MODEL`     (default `nomic-embed-text`)
 *   - `OLLAMA_GENERATE_MODEL`  (default `llama3.2`)
 *
 * The full app→Resource→harper.models path is covered by the unit-test
 * suites for jsLoader (`harper.models` export), bootstrap (registry wiring),
 * and OllamaBackend (call dispatch). This file is the contract check
 * against the real Ollama HTTP surface.
 */
import { suite, test, before } from 'node:test';
import { strictEqual, ok } from 'node:assert/strict';

// NOTE: `OllamaBackend` is imported dynamically inside `before()` rather than
// at the top of the file. Statically importing it from `components/ollama/`
// triggers a pre-existing require cycle in Harper's CommonJS graph
// (`utility/common_utils.ts` ↔ `utility/logging/harper_logger.ts`) when this
// test file is loaded by `node --test`, which is fatal on Node 22+ (ERR_REQUIRE_CYCLE_MODULE).
// Other integration tests don't hit it because they only import the
// `@harperfast/integration-testing` package and spawn Harper as a subprocess.
// Deferring the import past the static graph build sidesteps the cycle.

type OllamaBackendCtor = new (
	config: { host?: string; model?: string; requestTimeoutMs?: number },
	fetchImpl?: typeof fetch
) => {
	embed: (input: string | string[], opts: object) => Promise<{ status: string; output: Float32Array[] }>;
	generate: (
		input: unknown,
		opts: object
	) => Promise<{ status: string; output: { content: string; finishReason: string } }>;
	generateStream: (input: unknown, opts: object) => AsyncIterable<{ deltaContent?: string; finishReason?: string }>;
};

const OLLAMA_HOST = process.env.OLLAMA_HOST ?? 'http://localhost:11434';
const EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL ?? 'nomic-embed-text';
const GENERATE_MODEL = process.env.OLLAMA_GENERATE_MODEL ?? 'llama3.2';

const ACCOUNTING = { tenantId: 'integration', app: '/integration' };

async function reachable(): Promise<boolean> {
	try {
		const res = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(2000) });
		if (!res.ok) return false;
		const data = (await res.json()) as { models?: Array<{ name: string }> };
		const names = (data.models ?? []).map((m) => m.name);
		const hasEmbed = names.some((n) => n === EMBED_MODEL || n.startsWith(`${EMBED_MODEL}:`));
		const hasGen = names.some((n) => n === GENERATE_MODEL || n.startsWith(`${GENERATE_MODEL}:`));
		return hasEmbed && hasGen;
	} catch {
		return false;
	}
}

const skip = !(await reachable());

suite('OllamaBackend against a real Ollama instance', { skip }, () => {
	let backend: InstanceType<OllamaBackendCtor>;

	before(async () => {
		const mod = (await import('../../components/ollama/index.ts')) as { OllamaBackend: OllamaBackendCtor };
		backend = new mod.OllamaBackend({ host: OLLAMA_HOST.replace(/^https?:\/\//, '') });
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

	test('generate via chat shape (messages array) produces non-empty content', async () => {
		const result = await backend.generate([{ role: 'user', content: 'Reply with the single word OK.' }], {
			accounting: ACCOUNTING,
			model: GENERATE_MODEL,
			maxTokens: 10,
			temperature: 0,
		});
		strictEqual(result.status, 'completed');
		ok(typeof result.output.content === 'string' && result.output.content.length > 0);
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

	test('AbortSignal cancels an in-flight stream', async () => {
		const ctrl = new AbortController();
		const iter = backend
			.generateStream('Write a long paragraph about the ocean.', {
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
		// (AbortError / abort-flavored error) or by reaching `done`. The
		// real failure mode this guards against is the stream hanging,
		// where neither happens. Race a 5 s deadline so a hang fails the
		// test instead of timing the suite out.
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
