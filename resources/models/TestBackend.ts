import { allowedValues, isObjectSchema } from './decision.ts';
import { ServerError } from '../../utility/errors/hdbError.ts';
import type {
	BackendOpts,
	ChoiceScores,
	DecideInput,
	DecideOpts,
	DecisionLeaf,
	DecisionOutcome,
	DecisionOutput,
	DecisionSchema,
	EmbedOpts,
	GenerateChunk,
	GenerateInput,
	GenerateOpts,
	GenerateResult,
	ModelBackend,
	ModelCallResult,
	ModelCapabilities,
	ScoreChoicesOpts,
} from './types.ts';

/**
 * Deterministic in-memory backend for Phase 1 tests.
 *
 * Same input always produces the same output — no external services, no model
 * files, no network. Lets the facade, registry, accounting, and analytics
 * paths be exercised end-to-end without an Ollama / OpenAI / fabric backend.
 *
 * `contextWindow` (characters) gives `embed` a limit: a longer input fails with
 * `contextWindowExceeded`, or with `truncate: true` is cut to the window, keeping its start.
 */
export class TestBackend implements ModelBackend {
	readonly name = 'test';
	readonly #contextWindow?: number;

	constructor(options: { contextWindow?: number } = {}) {
		this.#contextWindow = options.contextWindow;
	}

	capabilities(): ModelCapabilities {
		return {
			embed: true,
			generate: true,
			stream: true,
			tools: false,
			adapters: false,
			decide: true,
			calibrated: false,
			scoreChoices: true,
			truncate: true,
		};
	}

	async embed(input: string | string[], opts: BackendOpts<EmbedOpts>): Promise<ModelCallResult<Float32Array[]>> {
		const window = this.#contextWindow;
		const texts = (Array.isArray(input) ? input : [input]).map((text) => {
			if (window === undefined || text.length <= window) return text;
			if (opts.truncate === true) return text.slice(0, window);
			throw Object.assign(
				new ServerError(
					`TestBackend input of ${text.length} characters exceeds its ${window}-character context window`
				),
				{ contextWindowExceeded: true }
			);
		});
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

	async decide(
		state: DecideInput,
		schema: DecisionSchema,
		_opts: BackendOpts<DecideOpts>
	): Promise<ModelCallResult<DecisionOutput<unknown>>> {
		const text = typeof state === 'string' ? state : JSON.stringify(state);
		const output: DecisionOutput<unknown> = isObjectSchema(schema)
			? {
					fields: Object.fromEntries(
						Object.entries(schema.properties).map(([name, leaf]) => [
							name,
							{ distribution: deterministicDistribution(`${text}\n${name}`, leaf) },
						])
					),
				}
			: { distribution: deterministicDistribution(text, schema) };
		return { status: 'completed', output, usage: { promptTokens: text.length, latencyMs: 0 } };
	}

	async scoreChoices(
		input: GenerateInput,
		choices: readonly string[],
		_opts: BackendOpts<ScoreChoicesOpts>
	): Promise<ModelCallResult<ChoiceScores>> {
		const text = stringFromInput(input);
		const logLikelihoods = choices.map((choice) => deterministicVector(`${text}\n${choice}`, 1)[0] * 4);
		return { status: 'completed', output: { logLikelihoods }, usage: { promptTokens: text.length, latencyMs: 0 } };
	}
}

function stringFromInput(input: GenerateInput): string {
	if (typeof input === 'string') return input;
	const messages = Array.isArray(input) ? input : input.messages;
	return messages.map((m) => m.content).join(' ');
}

/** A complete distribution over the leaf's values, seeded by the text so the same input always decides the same way. */
function deterministicDistribution(text: string, leaf: DecisionLeaf): DecisionOutcome[] {
	const values = allowedValues(leaf);
	const weights = Array.from(deterministicVector(text, values.length), (w) => (w + 1) / 2 + 0.01);
	const total = weights.reduce((sum, w) => sum + w, 0);
	return values.map((value, i) => ({ value, probability: weights[i] / total }));
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
