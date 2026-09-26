/**
 * Built-in `decision` backend over a configured generative logical name (#2779). A call either
 * scores every allowed value from the generative model's own likelihoods (#2838), when that name
 * routes to a backend implementing `scoreChoices`, or asks the model for `samples`
 * structured-output completions and reports the vote frequencies as the distribution. Configured
 * as `models.decision.<name>: { backend: generative, scoring: auto | vote | score }`.
 *
 * Every sample and every scoring call flows through the `models` facade, so each one writes its
 * own `hdb_model_calls` row and token metrics; the decide row itself reports no usage, or the
 * tokens would be counted twice (the same reason the agent loop's outer call writes no row).
 */
import { ServerError } from '../../utility/errors/hdbError.ts';
import { composeSignal } from './backendHelpers.ts';
import { setDecision } from './backendRegistry.ts';
import { allowedValues, isObjectSchema, parseDecisionSample, stateToText, toResponseSchema } from './decision.ts';
import { models } from './Models.ts';
import { getRouter } from './routing.ts';
import type {
	BackendOpts,
	ChoiceScores,
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
	ScoreChoicesOpts,
} from './types.ts';

export type ScoringMode = 'auto' | 'vote' | 'score';

export interface GenerativeDecisionConfig {
	/** Logical name of the generative model to sample or score; default `'default'`. */
	generative?: string;
	/** Completions per voted decision (1..25); default 5. */
	samples?: number;
	/** Completions or scoring calls in flight at once (1..25); default 5. */
	concurrency?: number;
	temperature?: number;
	/** Budget for the whole decision, composed with the caller's signal. */
	requestTimeoutMs?: number;
	/**
	 * `auto` (default) scores when the generative name routes to a backend that implements
	 * `scoreChoices` and votes otherwise, also when scoring proves unsupported for a call; `score`
	 * never votes; `vote` never scores, which makes it the rollback setting.
	 */
	scoring?: ScoringMode;
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

const VOTE_SYSTEM_PROMPT =
	'You make a decision about the input. Reply with a single JSON object that matches the required schema, choosing only from the allowed values.';
const SCORE_SYSTEM_PROMPT = 'You make a decision about the input, choosing only from the allowed values.';

export type GenerateFn = (input: GenerateInput, opts: GenerateOpts) => Promise<GenerateResult>;
export type ScoreFn = (
	input: GenerateInput,
	choices: readonly string[],
	opts: ScoreChoicesOpts
) => Promise<ChoiceScores>;

/** The facade calls the adapter makes; injectable for tests. */
export interface GenerativeDecisionDeps {
	generate?: GenerateFn;
	score?: ScoreFn;
	/** Whether the generative name currently routes to a backend that scores; `auto` asks before every decision. */
	canScore?: (logicalName: string) => boolean;
}

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
	deps: GenerativeDecisionDeps = {}
): ModelBackend {
	const generate = deps.generate ?? ((input, opts) => models.generate(input, opts));
	const score = deps.score ?? ((input, choices, opts) => models.scoreChoices(input, choices, opts));
	const canScore = deps.canScore ?? routesToScorer;
	const logicalName = config.generative ?? 'default';
	const samples = boundedCount(config.samples, DEFAULT_SAMPLES);
	const concurrency = boundedCount(config.concurrency, DEFAULT_CONCURRENCY);
	const scoring = config.scoring ?? 'auto';
	const { temperature, requestTimeoutMs } = config;

	const vote = async (
		state: DecideInput,
		schema: DecisionSchema,
		instructions: string | undefined,
		signal: AbortSignal | undefined
	): Promise<DecisionOutput<unknown>> => {
		const input = buildInput(state, schema, instructions, VOTE_SYSTEM_PROMPT, undefined);
		const responseFormat = { schema: toResponseSchema(schema) };
		const votes = await runPool(
			Array.from({ length: samples }, () => async (sampleSignal: AbortSignal) => {
				const result = await generate(input, { model: logicalName, responseFormat, temperature, signal: sampleSignal });
				return parseSample(schema, result.content, logicalName);
			}),
			concurrency,
			signal
		);
		return tally(schema, votes);
	};

	const scoreLeaf = async (
		state: DecideInput,
		schema: DecisionSchema,
		field: string | undefined,
		leaf: DecisionLeaf,
		instructions: string | undefined,
		signal: AbortSignal
	): Promise<DecisionOutcome[]> => {
		const values = allowedValues(leaf);
		const input = buildInput(state, schema, instructions, SCORE_SYSTEM_PROMPT, field);
		const scored = await score(
			input,
			values.map((value) => String(value)),
			{ model: logicalName, signal }
		);
		return softmax(values, scored?.logLikelihoods, logicalName);
	};

	// One scoring call per leaf, through the same pool and budget as voting, so a 32-field schema
	// does not open 32 provider connections at once and a caller abort settles every sibling.
	const scoreAll = async (
		state: DecideInput,
		schema: DecisionSchema,
		instructions: string | undefined,
		signal: AbortSignal | undefined
	): Promise<DecisionOutput<unknown>> => {
		if (!isObjectSchema(schema)) {
			const [distribution] = await runPool(
				[(leafSignal: AbortSignal) => scoreLeaf(state, schema, undefined, schema, instructions, leafSignal)],
				concurrency,
				signal
			);
			return { distribution };
		}
		const entries = Object.entries(schema.properties);
		const marginals = await runPool(
			entries.map(
				([name, leaf]) =>
					(leafSignal: AbortSignal) =>
						scoreLeaf(state, schema, name, leaf, instructions, leafSignal)
			),
			concurrency,
			signal
		);
		return { fields: Object.fromEntries(entries.map(([name], i) => [name, { distribution: marginals[i] }])) };
	};

	// What this adapter controls of its scoring configuration; the model behind the logical name is
	// identified by the config hash the facade records beside it.
	const signatureFor = (mode: ScoringMode) =>
		`generative=${logicalName};mode=${mode};samples=${samples};temperature=${temperature ?? 'default'}`;

	return {
		name: 'generative',
		capabilities: () => CAPABILITIES,
		async decide(
			state: DecideInput,
			schema: DecisionSchema,
			opts: BackendOpts<DecideOpts>
		): Promise<ModelCallResult<DecisionOutput<unknown>>> {
			const signal = composeSignal(opts.signal, requestTimeoutMs);
			const mode: ScoringMode = scoring === 'auto' ? (canScore(logicalName) ? 'score' : 'vote') : scoring;
			if (mode === 'score') {
				try {
					return {
						status: 'completed',
						output: { ...(await scoreAll(state, schema, opts.instructions, signal)), signature: signatureFor('score') },
					};
				} catch (err) {
					if (scoring !== 'auto' || !isScoringUnsupported(err)) throw err;
				}
			}
			return {
				status: 'completed',
				output: { ...(await vote(state, schema, opts.instructions, signal)), signature: signatureFor('vote') },
			};
		},
	};
}

function routesToScorer(logicalName: string): boolean {
	return getRouter().route({ kind: 'generative', logicalName, requires: ['scoreChoices'] }).length > 0;
}

/** The errors after which `auto` votes: the backend declined this call, or lost the capability since the probe. */
function isScoringUnsupported(err: unknown): boolean {
	const name = (err as { name?: string } | null)?.name;
	return name === 'ChoiceScoringUnsupportedError' || name === 'ModelCapabilityError';
}

/**
 * Run `tasks` with at most `concurrency` in flight under one AbortController. The first failure
 * aborts the rest, and the pool settles before that failure is thrown, so no task rejects
 * unobserved and the facade never falls back to another candidate while calls are in flight.
 * Siblings are aborted with a fresh reason, not the failure itself: a call that was cut short is
 * recorded as aborted, not as a second copy of the failure with the same billed usage.
 */
async function runPool<T>(
	tasks: ReadonlyArray<(signal: AbortSignal) => Promise<T>>,
	concurrency: number,
	signal: AbortSignal | undefined
): Promise<T[]> {
	const controller = new AbortController();
	const onAbort = () => controller.abort(signal?.reason);
	if (signal?.aborted) onAbort();
	else signal?.addEventListener('abort', onAbort, { once: true });
	const results: T[] = new Array(tasks.length);
	let failure: unknown;
	let failed = false;
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < tasks.length && !controller.signal.aborted) {
			const index = next++;
			try {
				results[index] = await tasks[index](controller.signal);
			} catch (err) {
				if (!failed) {
					failed = true;
					failure = err;
				}
				controller.abort(new DOMException('another call in this decision failed', 'AbortError'));
				return;
			}
		}
	};
	try {
		await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
	} finally {
		signal?.removeEventListener('abort', onAbort);
	}
	if (failed) throw failure;
	signal?.throwIfAborted();
	return results;
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

/** Normalize the backend's log-likelihoods over the leaf's values; the shape is checked because no backend's arithmetic is trusted. */
function softmax(values: readonly unknown[], logLikelihoods: unknown, logicalName: string): DecisionOutcome[] {
	if (
		!Array.isArray(logLikelihoods) ||
		logLikelihoods.length !== values.length ||
		!logLikelihoods.every((x) => typeof x === 'number' && Number.isFinite(x))
	)
		throw new GenerativeDecisionError(
			`generative model '${logicalName}' did not return one finite log-likelihood per allowed value (${values.length})`
		);
	const scores = logLikelihoods as number[];
	const max = Math.max(...scores);
	const weights = scores.map((x) => Math.exp(x - max));
	const total = weights.reduce((sum, w) => sum + w, 0);
	return values.map((value, i) => ({ value, probability: weights[i] / total }));
}

function buildInput(
	state: DecideInput,
	schema: DecisionSchema,
	instructions: string | undefined,
	system: string,
	field: string | undefined
): GenerateInput {
	const lines: string[] = [];
	if (instructions) lines.push(instructions, '');
	if (schema.description) lines.push(schema.description, '');
	if (!isObjectSchema(schema)) {
		lines.push(`Decide "value": ${describeLeaf(schema)}`);
	} else if (field !== undefined) {
		lines.push(`Decide "${field}": ${describeLeaf(schema.properties[field])}`);
	} else {
		lines.push('Decide each field:');
		for (const [name, leaf] of Object.entries(schema.properties)) lines.push(`- ${name}: ${describeLeaf(leaf)}`);
	}
	lines.push('', 'Input:', stateToText(state));
	return { system, messages: [{ role: 'user', content: lines.join('\n') }] };
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
