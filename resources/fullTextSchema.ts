import { ClientError } from '../utility/errors/hdbError.ts';

const FULL_TEXT_ARGUMENTS = new Set([
	'name',
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
	name: string;
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
	computed?: unknown;
	computedFromExpression?: unknown;
	relationship?: unknown;
};

export function assertFullTextSourcesRemain(
	definitions: readonly FullTextDefinition[],
	removed: ReadonlySet<string>
): void {
	for (const definition of definitions) {
		const source = definition.fields.find((field) => removed.has(field.name));
		if (source)
			throw schemaError(
				`Cannot remove attribute '${source.name}' while @fullText index '${definition.name}' references it`
			);
	}
}

export function compileFullTextDefinitions(
	values: readonly unknown[],
	attributes: readonly SchemaAttribute[]
): FullTextDefinition[] {
	const names = new Set<string>();
	const definitions = values.map((value) => {
		const definition = compileFullTextDefinition(value, attributes);
		if (names.has(definition.name))
			throw schemaError(`@fullText index "${definition.name}" is declared more than once`);
		names.add(definition.name);
		return definition;
	});
	return definitions.sort((left, right) => left.name.localeCompare(right.name));
}

export function compileFullTextDefinition(value: unknown, attributes: readonly SchemaAttribute[]): FullTextDefinition {
	const definition = requireObject(value, '@fullText');
	assertKnownKeys(definition, FULL_TEXT_ARGUMENTS, '@fullText');
	if (typeof definition.name !== 'string' || definition.name.length === 0)
		throw schemaError('@fullText requires a non-empty string "name"');
	const indexName = definition.name;

	if (!Array.isArray(definition.fields) || definition.fields.length === 0)
		throw schemaError(`@fullText index "${indexName}" requires a non-empty "fields" list`);
	const attributesByName = new Map(attributes.map((attribute) => [attribute.name, attribute]));
	const sourceNames = new Set<string>();
	const fields = definition.fields.map((entry, index) => {
		const source = requireObject(entry, `@fullText fields[${index}] on index "${indexName}"`);
		assertKnownKeys(source, SOURCE_ARGUMENTS, `@fullText fields[${index}] on index "${indexName}"`);
		if (typeof source.name !== 'string' || source.name.length === 0)
			throw schemaError(`@fullText fields[${index}] on index "${indexName}" requires a non-empty string "name"`);
		if (sourceNames.has(source.name))
			throw schemaError(`@fullText index "${indexName}" declares source field "${source.name}" more than once`);
		const attribute = attributesByName.get(source.name);
		if (!attribute)
			throw schemaError(`@fullText index "${indexName}" references unknown source field "${source.name}"`);
		if (attribute.computed || attribute.computedFromExpression || attribute.relationship)
			throw schemaError(
				`@fullText source field "${source.name}" must be stored record data and cannot use @computed or @relationship`
			);
		if (!isSupportedSource(attribute))
			throw schemaError(
				`@fullText source field "${source.name}" must be String or [String]; got "${displayType(attribute)}"`
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
		throw schemaError(`@fullText index "${indexName}" supports only the versioned analyzer "${DEFAULT_ANALYZER}"`);
	const stopWords = booleanOption(definition, 'stopWords', true, indexName);
	const positions = booleanOption(definition, 'positions', true, indexName);
	const surfaceTerms = booleanOption(definition, 'surfaceTerms', true, indexName);
	const synonyms = compileSynonyms(definition.synonyms, indexName);
	const highlighting = compileHighlighting(definition.highlighting, indexName);

	return {
		name: indexName,
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
