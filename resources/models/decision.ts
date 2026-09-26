import { ClientError, ServerError } from '../../utility/errors/hdbError.ts';
import type {
	DecideInput,
	Decision,
	DecisionLeaf,
	DecisionOutcome,
	DecisionOutput,
	DecisionSchema,
	FieldDecision,
} from './types.ts';

export const MAX_LEAF_VALUES = 255;
export const MAX_OBJECT_FIELDS = 32;
/** Aggregate allowed values across an object schema; also the ceiling strict structured-output providers place on enum values per request. */
export const MAX_SCHEMA_VALUES = 500;
const PROBABILITY_SUM_TOLERANCE = 1e-3;
const UNSAFE_FIELD_NAMES = new Set(['__proto__', 'constructor', 'prototype']);
const BOOLEAN_VALUES: readonly boolean[] = Object.freeze([false, true]);

export type ObjectDecisionSchema = Extract<DecisionSchema, { type: 'object' }>;

export function isObjectSchema(schema: DecisionSchema): schema is ObjectDecisionSchema {
	return (schema as { type?: unknown }).type === 'object';
}

export class DecisionSchemaError extends ClientError {
	constructor(message: string) {
		super(`Invalid decision schema: ${message}`, 400);
		this.name = 'DecisionSchemaError';
	}
}

export class DecisionInputError extends ClientError {
	constructor(message: string) {
		super(`Invalid decision input: ${message}`, 400);
		this.name = 'DecisionInputError';
	}
}

/** A backend's output violated the decision contract. A backend error: the facade records it and tries the next candidate. */
export class DecisionContractError extends ServerError {
	constructor(backendName: string, message: string) {
		super(`Backend '${backendName}' returned an invalid decision: ${message}`);
		this.name = 'DecisionContractError';
	}
}

export function validateDecisionSchema(schema: unknown): asserts schema is DecisionSchema {
	if (!schema || typeof schema !== 'object' || Array.isArray(schema))
		throw new DecisionSchemaError('schema must be an object');
	const candidate = schema as Record<string, unknown>;
	if (candidate.type === 'object') {
		const properties = candidate.properties;
		if (!properties || typeof properties !== 'object' || Array.isArray(properties))
			throw new DecisionSchemaError('an object schema needs a properties map');
		if (candidate.description !== undefined && typeof candidate.description !== 'string')
			throw new DecisionSchemaError('description must be a string');
		const names = Object.keys(properties);
		if (names.length === 0) throw new DecisionSchemaError('an object schema needs at least one property');
		if (names.length > MAX_OBJECT_FIELDS)
			throw new DecisionSchemaError(
				`an object schema has at most ${MAX_OBJECT_FIELDS} properties, got ${names.length}`
			);
		let total = 0;
		for (const name of names) {
			if (name.length === 0 || UNSAFE_FIELD_NAMES.has(name))
				throw new DecisionSchemaError(`property name '${name}' is not allowed`);
			total += validateLeaf((properties as Record<string, unknown>)[name], `property '${name}'`);
		}
		if (total > MAX_SCHEMA_VALUES)
			throw new DecisionSchemaError(
				`an object schema spans at most ${MAX_SCHEMA_VALUES} values across its properties, got ${total}`
			);
		return;
	}
	validateLeaf(schema, 'schema');
}

function validateLeaf(leaf: unknown, label: string): number {
	if (!leaf || typeof leaf !== 'object' || Array.isArray(leaf))
		throw new DecisionSchemaError(`${label} must be an object`);
	const candidate = leaf as Record<string, unknown>;
	if (candidate.description !== undefined && typeof candidate.description !== 'string')
		throw new DecisionSchemaError(`${label}: description must be a string`);
	if (Array.isArray(candidate.enum)) {
		if (candidate.enum.length < 2 || candidate.enum.length > MAX_LEAF_VALUES)
			throw new DecisionSchemaError(`${label}: enum needs 2..${MAX_LEAF_VALUES} values, got ${candidate.enum.length}`);
		const type = typeof candidate.enum[0];
		if (type !== 'string' && type !== 'number' && type !== 'boolean')
			throw new DecisionSchemaError(`${label}: enum values must be strings, finite numbers or booleans`);
		const seen = new Set<unknown>();
		for (const value of candidate.enum) {
			if (typeof value !== type)
				throw new DecisionSchemaError(`${label}: enum values must all be of one type (strings, numbers or booleans)`);
			if (type === 'number' && !Number.isFinite(value))
				throw new DecisionSchemaError(`${label}: enum values must be strings, finite numbers or booleans`);
			if (seen.has(value)) throw new DecisionSchemaError(`${label}: enum values must be distinct`);
			seen.add(value);
		}
		return candidate.enum.length;
	}
	if (candidate.type === 'boolean') return BOOLEAN_VALUES.length;
	if (candidate.type === 'integer') {
		const { minimum, maximum } = candidate;
		// Safe integers only: past 2^53 `value++` no longer advances, so a range could never end.
		if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum))
			throw new DecisionSchemaError(`${label}: integer minimum and maximum must be safe integers`);
		const span = (maximum as number) - (minimum as number) + 1;
		if (span < 2 || span > MAX_LEAF_VALUES)
			throw new DecisionSchemaError(`${label}: an integer range spans 2..${MAX_LEAF_VALUES} values, got ${span}`);
		return span;
	}
	throw new DecisionSchemaError(`${label} must be an enum, a boolean, or a bounded integer`);
}

function integerRange(minimum: number, maximum: number): number[] {
	const span = maximum - minimum + 1;
	const values: number[] = new Array(span);
	for (let i = 0; i < span; i++) values[i] = minimum + i;
	return values;
}

/** In the order ties resolve; assumes a validated leaf. */
export function allowedValues(leaf: DecisionLeaf): readonly unknown[] {
	if ('enum' in leaf) return leaf.enum;
	if (leaf.type === 'boolean') return BOOLEAN_VALUES;
	return integerRange(leaf.minimum, leaf.maximum);
}

/** Assumes a validated leaf. */
export function isAllowedValue(leaf: DecisionLeaf, raw: unknown): boolean {
	if ('enum' in leaf) return (leaf.enum as readonly unknown[]).includes(raw);
	if (leaf.type === 'boolean') return typeof raw === 'boolean';
	return Number.isInteger(raw) && (raw as number) >= leaf.minimum && (raw as number) <= leaf.maximum;
}

/** The text form of a `decide` state, or a `DecisionInputError` for a value no backend could serialize. */
export function stateToText(state: DecideInput): string {
	if (typeof state === 'string') return state;
	if (!state || typeof state !== 'object') throw new DecisionInputError('state must be a string or an object');
	let text: string | undefined;
	try {
		text = JSON.stringify(state);
	} catch (err) {
		throw new DecisionInputError(`state is not JSON-serializable (${(err as Error)?.message ?? err})`);
	}
	if (typeof text !== 'string') throw new DecisionInputError('state is not JSON-serializable');
	return text;
}

/**
 * Check a backend's output against the schema and shape it for the caller: complete distributions
 * sorted descending (ties keep schema order), the argmax as `value`, per-field marginals for object
 * schemas. `calibrated` falls back to the backend's capability when the output does not say.
 * Messages never echo backend-supplied values, because they can reach an error response.
 */
export function normalizeDecision<T>(
	schema: DecisionSchema,
	output: DecisionOutput<unknown>,
	backendName: string,
	calibratedDefault: boolean
): Omit<Decision<T>, 'id' | 'usage'> {
	if (!output || typeof output !== 'object') throw new DecisionContractError(backendName, 'output must be an object');
	const calibrated = typeof output.calibrated === 'boolean' ? output.calibrated : calibratedDefault;
	if (isObjectSchema(schema)) {
		const fields = output.fields;
		if (!fields || typeof fields !== 'object')
			throw new DecisionContractError(backendName, 'an object schema needs a fields map');
		const marginals: Record<string, FieldDecision> = {};
		const value: Record<string, unknown> = {};
		for (const name of Object.keys(schema.properties)) {
			if (!Object.hasOwn(fields, name)) throw new DecisionContractError(backendName, `missing field '${name}'`);
			const marginal = normalizeLeaf(schema.properties[name], fields[name], backendName, `field '${name}'`);
			marginals[name] = marginal;
			value[name] = marginal.value;
		}
		for (const name of Object.keys(fields)) {
			if (!Object.hasOwn(schema.properties, name))
				throw new DecisionContractError(backendName, `unexpected field '${name}'`);
		}
		return { value: value as T, fields: marginals, calibrated };
	}
	const leaf = normalizeLeaf(schema, output, backendName, 'output');
	return { value: leaf.value as T, probability: leaf.probability, distribution: leaf.distribution, calibrated };
}

function normalizeLeaf(
	leaf: DecisionLeaf,
	output: DecisionOutput<unknown> | undefined,
	backendName: string,
	label: string
): FieldDecision {
	const allowed = allowedValues(leaf);
	const distribution = output?.distribution;
	if (!Array.isArray(distribution)) throw new DecisionContractError(backendName, `${label}: distribution is required`);
	if (distribution.length !== allowed.length)
		throw new DecisionContractError(
			backendName,
			`${label}: distribution needs one entry per allowed value (${allowed.length}), got ${distribution.length}`
		);
	const byValue = new Map<unknown, number>();
	let sum = 0;
	for (let i = 0; i < distribution.length; i++) {
		const entry = distribution[i];
		if (!entry || typeof entry !== 'object')
			throw new DecisionContractError(backendName, `${label}: distribution entry ${i} is not an object`);
		const { value, probability } = entry;
		if (!isAllowedValue(leaf, value))
			throw new DecisionContractError(backendName, `${label}: distribution entry ${i} is not an allowed value`);
		if (typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1)
			throw new DecisionContractError(
				backendName,
				`${label}: the probability of distribution entry ${i} must be a finite number in [0, 1]`
			);
		if (byValue.has(value))
			throw new DecisionContractError(backendName, `${label}: distribution entry ${i} duplicates an earlier entry`);
		byValue.set(value, probability);
		sum += probability;
	}
	if (Math.abs(sum - 1) > PROBABILITY_SUM_TOLERANCE)
		throw new DecisionContractError(backendName, `${label}: probabilities sum to ${sum}, expected 1`);
	const sorted: DecisionOutcome[] = allowed.map((value) => ({ value, probability: byValue.get(value)! }));
	sorted.sort((a, b) => b.probability - a.probability);
	const top = sorted[0].probability;
	const chosen = output!.value;
	if (chosen !== undefined && chosen !== sorted[0].value) {
		if (byValue.get(chosen) !== top)
			throw new DecisionContractError(backendName, `${label}: value is not a most-probable outcome`);
		const index = sorted.findIndex((entry) => entry.value === chosen);
		sorted.unshift(...sorted.splice(index, 1));
	}
	return { value: sorted[0].value, probability: top, distribution: sorted };
}

/**
 * The JSON Schema a generative backend is asked to honor for one sample: an object at the root
 * (leaf answers wrapped as `{ value }`), every property required, no additional properties, and
 * bounded integers as an explicit enum — the shape strict structured-output modes accept.
 */
export function toResponseSchema(schema: DecisionSchema): object {
	if (isObjectSchema(schema)) {
		const properties: Record<string, object> = {};
		for (const [name, leaf] of Object.entries(schema.properties)) properties[name] = leafJsonSchema(leaf);
		const out: Record<string, unknown> = {
			type: 'object',
			properties,
			required: Object.keys(schema.properties),
			additionalProperties: false,
		};
		if (schema.description) out.description = schema.description;
		return out;
	}
	return {
		type: 'object',
		properties: { value: leafJsonSchema(schema) },
		required: ['value'],
		additionalProperties: false,
	};
}

function leafJsonSchema(leaf: DecisionLeaf): object {
	const out: Record<string, unknown> = {};
	if ('enum' in leaf) {
		out.type = typeof leaf.enum[0];
		out.enum = [...leaf.enum];
	} else if (leaf.type === 'boolean') {
		out.type = 'boolean';
	} else {
		out.type = 'integer';
		out.enum = integerRange(leaf.minimum, leaf.maximum);
	}
	if (leaf.description) out.description = leaf.description;
	return out;
}

/**
 * Parse one generative sample against the schema: the leaf value, or a `{ [property]: value }`
 * map for object schemas. Throws a plain `Error` naming what did not fit, never quoting the
 * sample itself; the caller wraps it.
 */
export function parseDecisionSample(schema: DecisionSchema, content: unknown): unknown {
	if (typeof content !== 'string') throw new Error('the sample has no text');
	let answer: unknown;
	let answerKey: string | undefined;
	let lastError: Error | undefined;
	for (const candidate of jsonObjectSpans(content)) {
		let values: unknown;
		try {
			values = extractSampleValues(schema, candidate);
		} catch (err) {
			lastError = err as Error;
			continue;
		}
		const key = JSON.stringify(values);
		if (answerKey === undefined) {
			answer = values;
			answerKey = key;
		} else if (key !== answerKey) {
			throw new Error('the sample contains more than one answer');
		}
	}
	if (answerKey !== undefined) return answer;
	throw lastError ?? new Error('the sample contains no JSON object');
}

function extractSampleValues(schema: DecisionSchema, sample: Record<string, unknown>): unknown {
	if (isObjectSchema(schema)) {
		const values: Record<string, unknown> = {};
		for (const [name, leaf] of Object.entries(schema.properties)) {
			if (!Object.hasOwn(sample, name)) throw new Error(`the sample has no '${name}'`);
			values[name] = checkSampleValue(leaf, sample[name], `'${name}'`);
		}
		return values;
	}
	return checkSampleValue(schema, sample.value, "'value'");
}

const MAX_OBJECT_SPANS = 64;
const MAX_SCAN_STEPS_PER_CHAR = 256;

/**
 * Every balanced `{`…`}` span that parses to a JSON object. A backend that ignores
 * `responseFormat` (Anthropic, Bedrock) answers from the prompt alone and may wrap the object in
 * code fences or prose with braces and stray quotes of its own; the schema check on each candidate
 * is what tells the answer from the rest, so no span is preferred over another. String tracking
 * starts at each opening brace, so quotes in the prose before an object cannot hide it, while
 * braces inside the object's own strings are text. The scan fails loudly, never partially: past
 * `MAX_OBJECT_SPANS` balanced spans, or once the character steps exceed
 * `MAX_SCAN_STEPS_PER_CHAR` times the reply's length.
 */
function* jsonObjectSpans(text: string): Generator<Record<string, unknown>> {
	const work = { left: MAX_SCAN_STEPS_PER_CHAR * text.length };
	let spans = 0;
	for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
		const end = balancedClose(text, start, work);
		if (end < 0) continue;
		if (++spans > MAX_OBJECT_SPANS) throw new Error('the sample has too many objects');
		let parsed: unknown;
		try {
			parsed = JSON.parse(text.slice(start, end + 1));
		} catch {
			continue;
		}
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) yield parsed as Record<string, unknown>;
	}
}

/** Index of the `}` that balances the `{` at `start`, reading JSON strings as text, or -1. */
function balancedClose(text: string, start: number, work: { left: number }): number {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i++) {
		if (--work.left < 0) throw new Error('the sample is too long to scan');
		const ch = text[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === '\\') escaped = true;
			else if (ch === '"') inString = false;
		} else if (ch === '"') inString = true;
		else if (ch === '{') depth++;
		else if (ch === '}' && --depth === 0) return i;
	}
	return -1;
}

function checkSampleValue(leaf: DecisionLeaf, raw: unknown, label: string): unknown {
	if (isAllowedValue(leaf, raw)) return raw;
	throw new Error(`${label} is not an allowed value`);
}
