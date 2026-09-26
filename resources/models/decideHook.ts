/**
 * `@decide` directive write-time hook, the sibling of `embedHook.ts`. `createDefaultDecider`
 * builds the decider a table registers for a `@decide` attribute; `buildDecideBefore` produces
 * the pre-commit callback that runs registered deciders and writes the chosen value, and its
 * probability when the directive names a confidence attribute, onto the record before it commits.
 */
import { isAllowedValue } from './decision.ts';
import { sanitizedHookError, settleAll, sourceState, writeHookApplies } from './embedHook.ts';
import type { DecideInput, DecideOpts, Decision, DecisionLeaf } from './types.ts';

export type DecideConfig = {
	source: string;
	model: string;
	/** Attribute that receives the chosen value's probability; unset when the directive names none. */
	confidence?: string;
	instructions?: string;
	/** The leaf the attribute type and directive arguments resolve to, validated when the schema loads. */
	schema: DecisionLeaf;
};

export type DecideAttribute = {
	name: string;
	decide: DecideConfig;
};

/** What a decider returns: the value to store and its probability. `null` clears both attributes. */
export type DeciderResult = { value: unknown; probability?: number };
export type Decider = (record: any) => Promise<DeciderResult | null | undefined>;

// Matches the public `Models.decide` signature; a named type so tests can inject a fake.
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
	return async (record: any): Promise<DeciderResult | null> => {
		const sourceValue = record?.[source];
		if (sourceValue == null) return null;
		// An object source is program state the primitive serializes itself; anything else is text.
		const state: DecideInput = typeof sourceValue === 'object' ? sourceValue : String(sourceValue);
		const decision = await resolveDecideFn()(state, schema, { model, instructions });
		return { value: decision.value, probability: decision.probability };
	};
}

/**
 * Build the pre-commit callback that runs deciders for every `@decide` attribute whose source
 * field is present in this write. Returns `undefined` when there's nothing to do, so the call
 * site can skip it. Same source-field semantics as `buildEmbedBefore`: a PATCH that omits the
 * source leaves the value and confidence untouched; an explicit `source: null` clears both.
 */
export function buildDecideBefore(
	record: any,
	context: any,
	options: any,
	decideAttributes: DecideAttribute[] | undefined,
	deciders: Record<string, Decider>
): (() => Promise<void>) | undefined {
	if (!decideAttributes || decideAttributes.length === 0) return undefined;
	if (!writeHookApplies(record, context, options)) return undefined;
	if (!decideAttributes.some((attr) => sourceState(record, attr.decide?.source) !== 'absent')) return undefined;
	return () =>
		settleAll(
			decideAttributes.map(async (attr) => {
				const { source, confidence, schema } = attr.decide;
				const state = sourceState(record, source);
				if (state === 'absent' || state === 'op') return;
				const clear = () => {
					record[attr.name] = null;
					if (confidence) record[confidence] = null;
				};
				if (state === 'null') return clear();
				const decider = deciders[attr.name];
				if (!decider) return;
				let result: DeciderResult | null | undefined;
				try {
					result = await decider(record);
				} catch (err) {
					throw sanitizedHookError('Decider', 'decision', attr.name, err);
				}
				if (result == null) return clear();
				// The facade validates `models.decide` output; an author override is checked here so the
				// stored pair keeps the closed-set guarantee a query relies on.
				if (!isAllowedValue(schema, result.value))
					throw new Error(`Decider for attribute "${attr.name}" returned a value outside its @decide set`);
				const probability = result.probability;
				if (probability !== undefined && !(typeof probability === 'number' && probability >= 0 && probability <= 1))
					throw new Error(`Decider for attribute "${attr.name}" returned a probability that is not a number in [0, 1]`);
				record[attr.name] = result.value;
				if (confidence) record[confidence] = probability ?? null;
			})
		);
}
