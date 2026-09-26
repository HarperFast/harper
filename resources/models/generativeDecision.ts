/**
 * Built-in `decision` backend over a configured generative logical name (#2779): each call asks
 * the generative model for `samples` structured-output completions and reports the vote
 * frequencies as the distribution. Configured as `models.decision.<name>: { backend: generative }`.
 *
 * Every sample flows through `models.generate`, so each one writes its own `hdb_model_calls`
 * row and token metrics; the decide row itself reports no usage, or the tokens would be
 * counted twice (the same reason the agent loop's outer call writes no row).
 */
import { ServerError } from '../../utility/errors/hdbError.ts';
import { composeSignal } from './backendHelpers.ts';
import { setDecision } from './backendRegistry.ts';
import { allowedValues, isObjectSchema, parseDecisionSample, stateToText, toResponseSchema } from './decision.ts';
import { models } from './Models.ts';
import type {
	BackendOpts,
	DecideInput,
	DecideOpts,
	DecisionLeaf,
	DecisionOutcome,
	DecisionOutput,
	DecisionSchema,
	GenerateInput,
	GenerateOpts,
	GenerateResult,
	ModelBackend,
	ModelCallResult,
	ModelCapabilities,
	ModelKind,
} from './types.ts';

export interface GenerativeDecisionConfig {
	/** Logical name of the generative model to sample; default `'default'`. */
	generative?: string;
	/** Completions per decision (1..25); default 5. */
	samples?: number;
	/** Completions in flight at once (1..25); default 5, never more than `samples`. */
	concurrency?: number;
	temperature?: number;
	/** Budget for the whole decision, composed with the caller's signal. */
	requestTimeoutMs?: number;
}

export const DEFAULT_SAMPLES = 5;
export const MAX_SAMPLES = 25;
const DEFAULT_CONCURRENCY = 5;

const CAPABILITIES: ModelCapabilities = Object.freeze({
	embed: false,
	generate: false,
	stream: false,
	tools: false,
	adapters: false,
	decide: true,
	calibrated: false,
});

const SYSTEM_PROMPT =
	'You make a decision about the input. Reply with a single JSON object that matches the required schema, choosing only from the allowed values.';

export type GenerateFn = (input: GenerateInput, opts: GenerateOpts) => Promise<GenerateResult>;

export class GenerativeDecisionError extends ServerError {
	constructor(message: string) {
		super(message);
		this.name = 'GenerativeDecisionError';
	}
}

export function registerGenerativeDecisionBackend(args: {
	logicalName: string;
	kind: ModelKind;
	config: GenerativeDecisionConfig;
}): void {
	if (args.kind !== 'decision')
		throw new GenerativeDecisionError(`backend 'generative' serves models.decision entries, not models.${args.kind}`);
	setDecision(args.logicalName, createGenerativeDecisionBackend(args.config));
}

export function createGenerativeDecisionBackend(
	config: GenerativeDecisionConfig = {},
	generate: GenerateFn = (input, opts) => models.generate(input, opts)
): ModelBackend {
	const logicalName = config.generative ?? 'default';
	const samples = boundedCount(config.samples, DEFAULT_SAMPLES);
	const concurrency = Math.min(boundedCount(config.concurrency, DEFAULT_CONCURRENCY), samples);
	const { temperature, requestTimeoutMs } = config;
	return {
		name: 'generative',
		capabilities: () => CAPABILITIES,
		async decide(
			state: DecideInput,
			schema: DecisionSchema,
			opts: BackendOpts<DecideOpts>
		): Promise<ModelCallResult<DecisionOutput<unknown>>> {
			const input = buildInput(state, schema, opts.instructions);
			const responseFormat = { schema: toResponseSchema(schema) };
			const signal = composeSignal(opts.signal, requestTimeoutMs);
			// The workers settle before anything is thrown: no sample rejects unobserved, and the facade
			// never falls back to another candidate while calls are still in flight.
			const controller = new AbortController();
			const onAbort = () => controller.abort(signal?.reason);
			if (signal?.aborted) onAbort();
			else signal?.addEventListener('abort', onAbort, { once: true });
			const votes: unknown[] = new Array(samples);
			let failure: unknown;
			let failed = false;
			let next = 0;
			const worker = async (): Promise<void> => {
				while (next < samples && !controller.signal.aborted) {
					const index = next++;
					try {
						const result = await generate(input, {
							model: logicalName,
							responseFormat,
							temperature,
							signal: controller.signal,
						});
						votes[index] = parseSample(schema, result.content, logicalName);
					} catch (err) {
						if (!failed) {
							failed = true;
							failure = err;
						}
						controller.abort(err);
						return;
					}
				}
			};
			try {
				await Promise.all(Array.from({ length: concurrency }, worker));
			} finally {
				signal?.removeEventListener('abort', onAbort);
			}
			if (failed) throw failure;
			signal?.throwIfAborted();
			return { status: 'completed', output: tally(schema, votes) };
		},
	};
}

function boundedCount(value: number | undefined, fallback: number): number {
	if (!Number.isInteger(value) || (value as number) < 1) return fallback;
	return Math.min(value as number, MAX_SAMPLES);
}

function parseSample(schema: DecisionSchema, content: string, logicalName: string): unknown {
	try {
		return parseDecisionSample(schema, content);
	} catch (err) {
		throw new GenerativeDecisionError(
			`generative model '${logicalName}' produced a sample outside the decision schema: ${(err as Error).message}`
		);
	}
}

function buildInput(state: DecideInput, schema: DecisionSchema, instructions: string | undefined): GenerateInput {
	const lines: string[] = [];
	if (instructions) lines.push(instructions, '');
	if (schema.description) lines.push(schema.description, '');
	if (isObjectSchema(schema)) {
		lines.push('Decide each field:');
		for (const [name, leaf] of Object.entries(schema.properties)) lines.push(`- ${name}: ${describeLeaf(leaf)}`);
	} else {
		lines.push(`Decide "value": ${describeLeaf(schema)}`);
	}
	lines.push('', 'Input:', stateToText(state));
	return { system: SYSTEM_PROMPT, messages: [{ role: 'user', content: lines.join('\n') }] };
}

function describeLeaf(leaf: DecisionLeaf): string {
	const range =
		!('enum' in leaf) && leaf.type === 'integer'
			? `an integer from ${leaf.minimum} to ${leaf.maximum}`
			: `one of ${allowedValues(leaf)
					.map((value) => JSON.stringify(value))
					.join(', ')}`;
	return leaf.description ? `${leaf.description} (${range})` : range;
}

function tally(schema: DecisionSchema, votes: unknown[]): DecisionOutput<unknown> {
	if (isObjectSchema(schema)) {
		const fields: Record<string, DecisionOutput<unknown>> = {};
		for (const [name, leaf] of Object.entries(schema.properties)) {
			fields[name] = {
				distribution: frequencies(
					leaf,
					votes.map((vote) => (vote as Record<string, unknown>)[name])
				),
			};
		}
		return { fields };
	}
	return { distribution: frequencies(schema, votes) };
}

function frequencies(leaf: DecisionLeaf, votes: unknown[]): DecisionOutcome[] {
	const counts = new Map<unknown, number>();
	for (const vote of votes) counts.set(vote, (counts.get(vote) ?? 0) + 1);
	return allowedValues(leaf).map((value) => ({ value, probability: (counts.get(value) ?? 0) / votes.length }));
}
