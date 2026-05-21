import type {
	BackendOpts,
	EmbedOpts,
	GenerateChunk,
	GenerateInput,
	GenerateOpts,
	GenerateResult,
	ModelBackend,
	ModelCallResult,
	ModelCapabilities,
} from './types.ts';

/**
 * Deterministic in-memory backend for Phase 1 tests.
 *
 * Same input always produces the same output — no external services, no model
 * files, no network. Lets the facade, registry, accounting, and analytics
 * paths be exercised end-to-end without an Ollama / OpenAI / fabric backend.
 */
export class TestBackend implements ModelBackend {
	readonly name = 'test';

	capabilities(): ModelCapabilities {
		return { embed: true, generate: true, stream: true, tools: false, adapters: false };
	}

	async embed(input: string | string[], _opts: BackendOpts<EmbedOpts>): Promise<ModelCallResult<Float32Array[]>> {
		const texts = Array.isArray(input) ? input : [input];
		const vectors = texts.map((t) => deterministicVector(t, 16));
		const embeddingTokens = texts.reduce((sum, t) => sum + t.length, 0);
		return { status: 'completed', output: vectors, usage: { embeddingTokens, latencyMs: 0 } };
	}

	async generate(input: GenerateInput, _opts: BackendOpts<GenerateOpts>): Promise<ModelCallResult<GenerateResult>> {
		const text = stringFromInput(input);
		const content = `[TestBackend echoed]: ${text}`;
		return {
			status: 'completed',
			output: { content, finishReason: 'stop' },
			usage: { promptTokens: text.length, completionTokens: content.length, latencyMs: 0 },
		};
	}

	async *generateStream(input: GenerateInput, _opts: BackendOpts<GenerateOpts>): AsyncIterable<GenerateChunk> {
		const text = stringFromInput(input);
		const words = `[TestBackend stream]: ${text}`.split(' ');
		for (const word of words) {
			yield { deltaContent: word + ' ' };
		}
		yield { finishReason: 'stop' };
	}
}

function stringFromInput(input: GenerateInput): string {
	if (typeof input === 'string') return input;
	const messages = Array.isArray(input) ? input : input.messages;
	return messages.map((m) => m.content).join(' ');
}

/**
 * Hash text into a deterministic Float32Array of the given dimension.
 *
 * Uses FNV-1a to seed a Mulberry32 PRNG; values are mapped to [-1, 1).
 * Same input → same vector across runs and platforms; not a cryptographic hash.
 */
function deterministicVector(text: string, dim: number): Float32Array {
	let seed = 2166136261 >>> 0; // FNV-1a 32-bit offset basis
	for (let i = 0; i < text.length; i++) {
		seed ^= text.charCodeAt(i);
		seed = Math.imul(seed, 16777619) >>> 0;
	}
	const vec = new Float32Array(dim);
	let state = seed;
	for (let i = 0; i < dim; i++) {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
		t = (t + Math.imul(t ^ (t >>> 7), t | 61)) >>> 0;
		const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		vec[i] = r * 2 - 1; // map [0, 1) → [-1, 1)
	}
	return vec;
}
