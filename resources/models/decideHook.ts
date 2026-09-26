/** `@decide` directive write-time hook, the sibling of `embedHook.ts`. */
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
	instructions?: string;
	/** Resolved from the attribute type and the directive arguments, and validated, when the schema loads. */
	schema: DecisionLeaf;
};

export type DecideAttribute = {
	name: string;
	decide: DecideConfig;
};

/** `null` clears the attribute and its confidence; `probability` is required when the directive names a confidence attribute. */
export type DeciderResult = { value: unknown; probability?: number };
export type Decider = (record: any, hook?: WriteHookContext) => Promise<DeciderResult | null | undefined>;

type DecideFn = (state: DecideInput, schema: DecisionLeaf, opts: DecideOpts) => Promise<Decision>;

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
	return async (record: any, hook?: WriteHookContext): Promise<DeciderResult | null> => {
		const sourceValue = record?.[source];
		if (sourceValue == null) return null;
		// An object source is program state the primitive serializes itself; anything else is text.
		const state: DecideInput = typeof sourceValue === 'object' ? sourceValue : String(sourceValue);
		const decision = await resolveDecideFn()(state, schema, { model, instructions, signal: hook?.signal });
		return { value: decision.value, probability: decision.probability };
	};
}

/**
 * Build the pre-commit callback that runs deciders for every `@decide` attribute whose source
 * field is present in this write, or `undefined` when nothing applies. Same source-field
 * semantics as `buildEmbedBefore`: a PATCH that omits the source leaves the value and
 * confidence untouched; an explicit `source: null` clears both.
 */
export function buildDecideBefore(
	record: any,
	context: any,
	options: any,
	decideAttributes: DecideAttribute[] | undefined,
	deciders: Record<string, Decider>
): WriteHook | undefined {
	if (!decideAttributes || decideAttributes.length === 0) return undefined;
	if (!writeHookApplies(record, context, options)) return undefined;
	let present = false;
	for (const attr of decideAttributes) if (sourceState(record, attr.decide?.source) !== 'absent') present = true;
	if (!present) return undefined;
	return (signal) =>
		runWriteJobs(
			decideAttributes.map((attr) => async (jobSignal) => {
				const { source, confidence, schema } = attr.decide;
				const state = sourceState(record, source);
				if (state === 'absent' || state === 'op') return;
				const clear = () => {
					record[attr.name] = null;
					if (confidence) record[confidence] = null;
				};
				if (state === 'null') return clear();
				const decider = deciders[attr.name];
				// Committing the source without its pair would be indistinguishable from a decision later.
				if (!decider) throw new Error(`No decider is registered for the @decide attribute "${attr.name}"`);
				let result: DeciderResult | null | undefined;
				try {
					result = await decider(record, { signal: jobSignal });
				} catch (err) {
					// A sibling's failure aborted this one; that failure is the one reported and logged.
					if (jobSignal.aborted) throw err;
					throw sanitizedHookError('Decider', 'decision', attr.name, err);
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
			}),
			signal
		);
}
