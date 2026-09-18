import { ClientError } from '../utility/errors/hdbError.ts';

const FULL_TEXT_ARGUMENTS = new Set([
	'fields',
	'analyzer',
	'stopWords',
	'positions',
	'surfaceTerms',
	'synonyms',
	'highlighting',
]);
const SOURCE_ARGUMENTS = new Set(['name', 'weight', 'highlight']);
const SYNONYM_ARGUMENTS = new Set(['source', 'replacements']);
const HIGHLIGHTING_ARGUMENTS = new Set(['maxFragments', 'fragmentLength']);

const DEFAULT_ANALYZER = 'english@1';
const DEFAULT_MAX_FRAGMENTS = 3;
const DEFAULT_FRAGMENT_LENGTH = 160;

export type FullTextSource = {
	name: string;
	weight: number;
	highlight?: boolean;
};

export type FullTextSynonymRule = {
	source: string;
	replacements: string[];
};

export type FullTextHighlighting = {
	maxFragments: number;
	fragmentLength: number;
};

export type FullTextDefinition = {
	fields: FullTextSource[];
	analyzer: 'english@1';
	stopWords: boolean;
	positions: boolean;
	surfaceTerms: boolean;
	synonyms: FullTextSynonymRule[];
	highlighting?: FullTextHighlighting;
};

type SchemaAttribute = {
	name: string;
	type?: string;
	elements?: { type?: string };
	indexed?: unknown;
	computed?: unknown;
	computedFromExpression?: unknown;
	embed?: unknown;
	relationship?: unknown;
	isPrimaryKey?: boolean;
	assignCreatedTime?: boolean;
	assignUpdatedTime?: boolean;
	expiresAt?: boolean;
	enumerable?: boolean;
	nullable?: boolean;
	fullText?: FullTextDefinition;
};

export function assertFullTextSourcesRemain(
	attributes: readonly SchemaAttribute[],
	removed: ReadonlySet<string>
): void {
	for (const attribute of attributes) {
		if (removed.has(attribute.name) || !attribute.fullText) continue;
		const source = attribute.fullText.fields.find((field) => removed.has(field.name));
		if (source)
			throw schemaError(
				`Cannot remove attribute '${source.name}' while @fullText field '${attribute.name}' references it`
			);
	}
}

export function compileFullTextDefinition(
	target: SchemaAttribute,
	value: unknown,
	attributes: readonly SchemaAttribute[]
): FullTextDefinition {
	if (target.type !== 'FullText')
		throw schemaError(`@fullText on "${target.name}" requires the FullText scalar type; got "${displayType(target)}"`);
	if (target.indexed) throw schemaError(`@fullText on "${target.name}" cannot be combined with @indexed`);
	if (target.enumerable) throw schemaError(`@fullText on "${target.name}" cannot be combined with @enumerable`);
	if (target.nullable === false) throw schemaError(`@fullText on "${target.name}" must be nullable`);
	if (
		target.computed ||
		target.embed ||
		target.relationship ||
		target.isPrimaryKey ||
		target.assignCreatedTime ||
		target.assignUpdatedTime ||
		target.expiresAt
	)
		throw schemaError(`@fullText on "${target.name}" cannot be combined with another field-lifecycle directive`);
	const definition = requireObject(value, `@fullText on "${target.name}"`);
	assertKnownKeys(definition, FULL_TEXT_ARGUMENTS, `@fullText on "${target.name}"`);

	if (!Array.isArray(definition.fields) || definition.fields.length === 0)
		throw schemaError(`@fullText on "${target.name}" requires a non-empty "fields" list`);
	const attributesByName = new Map(attributes.map((attribute) => [attribute.name, attribute]));
	const sourceNames = new Set<string>();
	const fields = definition.fields.map((entry, index) => {
		const source = requireObject(entry, `@fullText fields[${index}] on "${target.name}"`);
		assertKnownKeys(source, SOURCE_ARGUMENTS, `@fullText fields[${index}] on "${target.name}"`);
		if (typeof source.name !== 'string' || source.name.length === 0)
			throw schemaError(`@fullText fields[${index}] on "${target.name}" requires a non-empty string "name"`);
		if (sourceNames.has(source.name))
			throw schemaError(`@fullText on "${target.name}" declares source field "${source.name}" more than once`);
		const attribute = attributesByName.get(source.name);
		if (!attribute) throw schemaError(`@fullText on "${target.name}" references unknown source field "${source.name}"`);
		if (!isSupportedSource(attribute))
			throw schemaError(
				`@fullText source field "${source.name}" must be String or [String]; got "${displayType(attribute)}"`
			);
		if (attribute.computed || attribute.computedFromExpression || attribute.relationship)
			throw schemaError(
				`@fullText source field "${source.name}" must be stored record data and cannot use @computed or @relationship`
			);
		const weight = source.weight === undefined ? 1 : source.weight;
		if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0)
			throw schemaError(`@fullText source field "${source.name}" requires a finite weight greater than zero`);
		const highlight = source.highlight;
		if (highlight !== undefined && highlight !== null && typeof highlight !== 'boolean')
			throw schemaError(`@fullText source field "${source.name}" requires a Boolean "highlight" value`);
		sourceNames.add(source.name);
		const compiled: FullTextSource = { name: source.name, weight };
		if (typeof highlight === 'boolean') compiled.highlight = highlight;
		return compiled;
	});

	const analyzer = definition.analyzer === undefined ? DEFAULT_ANALYZER : definition.analyzer;
	if (analyzer !== DEFAULT_ANALYZER)
		throw schemaError(`@fullText on "${target.name}" supports only the versioned analyzer "${DEFAULT_ANALYZER}"`);
	const stopWords = booleanOption(definition, 'stopWords', true, target.name);
	const positions = booleanOption(definition, 'positions', true, target.name);
	const surfaceTerms = booleanOption(definition, 'surfaceTerms', true, target.name);
	const synonyms = compileSynonyms(definition.synonyms, target.name);
	const highlighting = compileHighlighting(definition.highlighting, target.name);

	return {
		fields,
		analyzer,
		stopWords,
		positions,
		surfaceTerms,
		synonyms,
		...(highlighting ? { highlighting } : {}),
	};
}

function compileSynonyms(value: unknown, targetName: string): FullTextSynonymRule[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw schemaError(`@fullText synonyms on "${targetName}" must be a list`);
	const rules = new Set<string>();
	return value.map((entry, index) => {
		const rule = requireObject(entry, `@fullText synonyms[${index}] on "${targetName}"`);
		assertKnownKeys(rule, SYNONYM_ARGUMENTS, `@fullText synonyms[${index}] on "${targetName}"`);
		if (typeof rule.source !== 'string' || rule.source.length === 0)
			throw schemaError(`@fullText synonyms[${index}] on "${targetName}" requires a non-empty string "source"`);
		if (!Array.isArray(rule.replacements) || rule.replacements.length === 0)
			throw schemaError(`@fullText synonyms[${index}] on "${targetName}" requires non-empty "replacements"`);
		const replacements = rule.replacements.map((replacement) => {
			if (typeof replacement !== 'string' || replacement.length === 0)
				throw schemaError(`@fullText synonyms[${index}] on "${targetName}" requires string replacements`);
			if (replacement === rule.source)
				throw schemaError(`@fullText synonyms[${index}] on "${targetName}" cannot replace a term with itself`);
			return replacement;
		});
		if (new Set(replacements).size !== replacements.length)
			throw schemaError(`@fullText synonyms[${index}] on "${targetName}" contains duplicate replacements`);
		const key = JSON.stringify([rule.source, [...replacements].sort()]);
		if (rules.has(key)) throw schemaError(`@fullText on "${targetName}" declares a duplicate synonym rule`);
		rules.add(key);
		return { source: rule.source, replacements };
	});
}

function compileHighlighting(value: unknown, targetName: string): FullTextHighlighting | undefined {
	if (value == null) return;
	const highlighting = requireObject(value, `@fullText highlighting on "${targetName}"`);
	assertKnownKeys(highlighting, HIGHLIGHTING_ARGUMENTS, `@fullText highlighting on "${targetName}"`);
	const maxFragments = highlighting.maxFragments === undefined ? DEFAULT_MAX_FRAGMENTS : highlighting.maxFragments;
	const fragmentLength =
		highlighting.fragmentLength === undefined ? DEFAULT_FRAGMENT_LENGTH : highlighting.fragmentLength;
	if (typeof maxFragments !== 'number' || !Number.isSafeInteger(maxFragments) || maxFragments <= 0)
		throw schemaError(`@fullText highlighting.maxFragments on "${targetName}" must be a positive integer`);
	if (typeof fragmentLength !== 'number' || !Number.isSafeInteger(fragmentLength) || fragmentLength <= 0)
		throw schemaError(`@fullText highlighting.fragmentLength on "${targetName}" must be a positive integer`);
	return { maxFragments, fragmentLength };
}

function booleanOption(
	definition: Record<string, unknown>,
	name: 'stopWords' | 'positions' | 'surfaceTerms',
	fallback: boolean,
	targetName: string
): boolean {
	const value = definition[name];
	if (value === undefined) return fallback;
	if (typeof value !== 'boolean') throw schemaError(`@fullText ${name} on "${targetName}" must be a Boolean`);
	return value;
}

function isSupportedSource(attribute: SchemaAttribute): boolean {
	return attribute.type === 'String' || (attribute.type === 'array' && attribute.elements?.type === 'String');
}

function displayType(attribute: SchemaAttribute): string {
	return attribute.type === 'array' ? `[${attribute.elements?.type ?? '?'}]` : (attribute.type ?? '?');
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw schemaError(`${label} must be an object`);
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) throw schemaError(`${label} must be an object`);
	return value as Record<string, unknown>;
}

function assertKnownKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
	const unknown = Object.keys(value).find((name) => !allowed.has(name));
	if (unknown) throw schemaError(`${label} does not support the "${unknown}" option`);
}

function schemaError(message: string): ClientError {
	return new ClientError(message, 400);
}
