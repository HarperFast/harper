import { ClientError } from '../../utility/errors/hdbError.ts';
import { isAllowedValue } from './decision.ts';
import {
	runWriteJobs,
	sanitizedHookError,
	sourceState,
	writeHookApplies,
	type WriteHook,
	type WriteHookContext,
} from './embedHook.ts';
import type { DecideInput, DecideOpts, Decision, DecisionLeaf } from './types.ts';

export type DecideConfig = {
	source: string;
	model: string;
	confidence?: string;
	/** A nullable `String` attribute that receives the durable `Decision.id`; the decision is recorded only when this is named (#2852). */
	decision?: string;
	instructions?: string;
	/** Resolved from the attribute type and the directive arguments, and validated, when the schema loads. */
	schema: DecisionLeaf;
};

export type DecideAttribute = {
	name: string;
	decide: DecideConfig;
};

/**
 * `null` clears the attribute, its confidence and its decision id; `probability` is required when the
 * directive names a confidence attribute. `id` must come from a `models.decide` call; an override for a
 * directive without a `decision` attribute that calls `models.decide` passes `persist: false`.
 */
export type DeciderResult = { value: unknown; probability?: number; id?: string };
export type Decider = (record: any, hook?: WriteHookContext) => Promise<DeciderResult | null | undefined>;

type DecideFn = (
	state: DecideInput,
	schema: DecisionLeaf,
	opts: Omit<DecideOpts, 'persist'> & { persist: boolean }
) => Promise<Omit<Decision, 'id'> & { id?: string }>;

// Lazy-imported so this module can be unit-tested without loading the transaction
// stack `Models.ts` pulls in. Overridable via `__setDecideFnForTest`.
let _decideFn: DecideFn | undefined;
function resolveDecideFn(): DecideFn {
	if (_decideFn) return _decideFn;
	const { Models } = require('#src/resources/models/Models'); // eslint-disable-line @typescript-eslint/no-var-requires
	const models = new Models();
	_decideFn = (state, schema, opts) => models.decide(state, schema, opts);
	return _decideFn;
}

/** Test seam: override the decide function. Pass `undefined` to reset to `Models.decide`. */
export function __setDecideFnForTest(fn: DecideFn | undefined): void {
	_decideFn = fn;
}

export function createDefaultDecider(config: DecideConfig): Decider {
	const { source, model, instructions, schema } = config;
	const persist = Boolean(config.decision);
	return async (record: any, hook?: WriteHookContext): Promise<DeciderResult | null> => {
		const sourceValue = record?.[source];
		if (sourceValue == null) return null;
		// An object source is program state the primitive serializes itself; anything else is text.
		const state: DecideInput = typeof sourceValue === 'object' ? sourceValue : String(sourceValue);
		const decision = await resolveDecideFn()(state, schema, { model, instructions, signal: hook?.signal, persist });
		return { value: decision.value, probability: decision.probability, id: decision.id };
	};
}

export function buildDecideBefore(
	record: any,
	context: any,
	options: any,
	decideAttributes: DecideAttribute[] | undefined,
	deciders: Record<string, Decider>
): WriteHook | undefined {
	if (!decideAttributes || decideAttributes.length === 0) return undefined;
	const applies = writeHookApplies(record, context, options);
	if (record && typeof record === 'object' && options?.isNotification !== true && context?.alreadyLogged !== true)
		for (const attr of decideAttributes) {
			const { decision, source } = attr.decide;
			if (!decision || !(decision in record)) continue;
			const state = applies ? sourceState(record, source) : 'absent';
			// The id is provenance a later outcome report trusts, so only a write that derives or clears it may carry it.
			if (state !== 'value' && state !== 'null') {
				const error = new ClientError(
					`"${decision}" is written by @decide on "${attr.name}"; a write may carry it only with a value for "${source}"`,
					400
				);
				return () => Promise.reject(error);
			}
		}
	if (!applies) return undefined;
	let present = false;
	for (const attr of decideAttributes) if (sourceState(record, attr.decide?.source) !== 'absent') present = true;
	if (!present) return undefined;
	return (signal) =>
		runWriteJobs(
			decideAttributes.map((attr) => async (jobSignal) => {
				const { source, confidence, decision, schema } = attr.decide;
				const state = sourceState(record, source);
				if (state === 'absent' || state === 'op') return;
				const clear = () => {
					record[attr.name] = null;
					if (confidence) record[confidence] = null;
					if (decision) record[decision] = null;
				};
				if (state === 'null') return clear();
				const decider = deciders[attr.name];
				// Committing the source without its pair would be indistinguishable from a decision later.
				if (!decider) throw new Error(`No decider is registered for the @decide attribute "${attr.name}"`);
				let result: DeciderResult | null | undefined;
				try {
					result = await decider(record, { signal: jobSignal });
				} catch (err) {
					// An aborted job failed because a sibling did; only that failure is worth a log line.
					throw sanitizedHookError('Decider', 'decision', attr.name, err, !jobSignal.aborted);
				}
				if (result == null) return clear();
				// The facade validates `models.decide` output; an author override is checked here so the
				// stored pair keeps the closed-set guarantee a query relies on.
				if (!isAllowedValue(schema, result.value))
					throw new Error(`Decider for attribute "${attr.name}" returned a value outside its @decide set`);
				if (confidence) {
					const probability = result.probability;
					if (!(typeof probability === 'number' && probability >= 0 && probability <= 1))
						throw new Error(
							`Decider for attribute "${attr.name}" must return a probability in [0, 1] for its confidence attribute "${confidence}"`
						);
					record[attr.name] = result.value;
					record[confidence] = probability;
				} else {
					record[attr.name] = result.value;
				}
				if (decision) record[decision] = typeof result.id === 'string' && result.id !== '' ? result.id : null;
			}),
			signal
		);
}
