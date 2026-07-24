/**
 * Shared JSON-Schema-aligned types for Harper's class-level metadata surfaces.
 *
 * `JsonSchemaFragment` is the public shape authors write to via `static properties`
 * on Resource/Table classes. It mirrors the JSON Schema vocabulary so the same
 * data can drive MCP tool descriptors, OpenAPI components, and any future schema
 * consumer without an intermediate translation layer.
 *
 * `DATA_TYPES` maps Harper's GraphQL primitive type names to JSON Schema type
 * strings. Used by the OpenAPI generator and the GraphQL parser to keep their
 * type emission in lockstep.
 */

import logger from '../utility/logging/harper_logger.ts';

export type JsonSchemaType = 'string' | 'integer' | 'number' | 'boolean' | 'object' | 'array' | 'null';

export interface JsonSchemaFragment {
	type?: JsonSchemaType | JsonSchemaType[] | string;
	description?: string;
	primaryKey?: boolean;
	assignCreatedTime?: boolean;
	assignUpdatedTime?: boolean;
	hidden?: boolean;
	enum?: readonly (string | number | boolean | null)[];
	nullable?: boolean;
	items?: JsonSchemaFragment;
	properties?: Record<string, JsonSchemaFragment>;
	required?: readonly string[];
	additionalProperties?: boolean;
	format?: string;
	const?: unknown;
}

/**
 * The JSON-Schema scalar/structural type names. A programmatic Resource's `static properties` speaks
 * JSON Schema directly (lowercase), so the MCP and OpenAPI type mappers pass these through unchanged
 * rather than treating them as unknown Harper types. Shared so the two mappers can't drift apart.
 */
export const JSON_SCHEMA_SCALAR_TYPES: ReadonlySet<string> = new Set([
	'string',
	'integer',
	'number',
	'boolean',
	'object',
	'array',
	'null',
]);

export const DATA_TYPES: Record<string, JsonSchemaType> = {
	Int: 'integer',
	Float: 'number',
	Long: 'integer',
	ID: 'string',
	String: 'string',
	Boolean: 'boolean',
	Date: 'string',
	Bytes: 'string',
	BigInt: 'integer',
};

/**
 * Minimal shape needed to project an attribute to its JSON Schema fragment.
 * Subset of `Attribute` to avoid a cyclic import. Real `Attribute` from
 * `Table.ts` is structurally compatible.
 */
export interface AttributeLike {
	name: string;
	type?: string;
	description?: string;
	hidden?: boolean;
	isPrimaryKey?: boolean;
	assignCreatedTime?: boolean;
	assignUpdatedTime?: boolean;
	nullable?: boolean;
	elements?: AttributeLike;
	/** Sub-attributes of a nested object field (the same array form `Table.validate` iterates). */
	properties?: AttributeLike[];
	// JSON-Schema-only hints an author may declare on `static properties`; carried through the
	// projection so they survive the properties <-> attributes round-trip.
	enum?: readonly (string | number | boolean | null)[];
	format?: string;
	const?: unknown;
	/** Object-level constraints for a nested object field, carried through the round-trip. */
	required?: readonly string[];
	additionalProperties?: boolean;
}

/**
 * Project a single attribute to its JSON Schema fragment. Recursive on the
 * `elements` field for array types so an attribute like `tags: [String]`
 * produces `{ type: 'array', items: { type: 'string' } }` instead of the
 * type-only `{ type: 'array' }` that would leave the element shape unknown
 * to MCP / OpenAPI consumers.
 */
export function attributeToFragment(attr: AttributeLike): JsonSchemaFragment {
	const fragment: JsonSchemaFragment = {};
	// A nested object field carries its sub-attributes on `.properties` (the array form the parser
	// emits and `Table.validate` iterates) — recurse into them rather than emitting the bare GraphQL
	// type name as a JSON-Schema `type`. GraphQL parser emits list types as `prop.type === 'array'`
	// with `.elements`; map that to JSON Schema's items shape; otherwise fall through to the primitive
	// mapping.
	if (attr.properties) {
		fragment.type = 'object';
		fragment.properties = {};
		for (const sub of attr.properties) fragment.properties[sub.name] = attributeToFragment(sub);
		if (attr.required) fragment.required = attr.required;
		if (attr.additionalProperties !== undefined) fragment.additionalProperties = attr.additionalProperties;
	} else if (attr.type === 'array' && attr.elements) {
		fragment.type = 'array';
		fragment.items = attributeToFragment(attr.elements);
	} else {
		const jsonType = attr.type ? DATA_TYPES[attr.type] : undefined;
		if (jsonType) fragment.type = jsonType;
		else if (attr.type) fragment.type = attr.type;
	}
	if (attr.description) fragment.description = attr.description;
	if (attr.isPrimaryKey) fragment.primaryKey = true;
	if (attr.assignCreatedTime) fragment.assignCreatedTime = true;
	if (attr.assignUpdatedTime) fragment.assignUpdatedTime = true;
	if (attr.hidden) fragment.hidden = true;
	if (attr.nullable) fragment.nullable = true;
	// NOTE: enum/format/const are deliberately NOT emitted here. This projector feeds the canonical,
	// front-end-neutral `Table.properties` Record, where a code-first `types.enum` column must stay
	// identical to its GraphQL `String` equivalent (types.enum is advisory — see defineTable.ts). The
	// MCP/OpenAPI schema paths (derive.ts / openApi.ts) surface those hints for programmatic Resources.
	return fragment;
}

/**
 * Project an `Attribute[]` array into a `Record<string, JsonSchemaFragment>`
 * keyed by attribute name. Default canonical-properties source when an author
 * hasn't declared `static properties` on the class.
 */
export function projectAttributesToProperties(attributes: AttributeLike[]): Record<string, JsonSchemaFragment> {
	const result: Record<string, JsonSchemaFragment> = {};
	for (const attr of attributes) {
		result[attr.name] = attributeToFragment(attr);
	}
	return result;
}

/**
 * Structural inverse of `attributeToFragment`: rebuild an attribute from a JSON Schema fragment.
 * A programmatic Resource may declare `static properties` (the Record form) without populating the
 * `attributes` Array; the schema-derivation paths (MCP `derive.ts`, OpenAPI) read attributes, so a
 * bare declaration would otherwise yield a skeletal schema. Projecting the fragments back into
 * attributes lets those paths produce the same rich schema they build for table-backed resources.
 */
function fragmentToAttribute(name: string, fragment: JsonSchemaFragment): AttributeLike {
	const attr: AttributeLike = { name };
	if (fragment.properties) {
		attr.properties = Object.entries(fragment.properties).map(([subName, sub]) => fragmentToAttribute(subName, sub));
		if (fragment.required) attr.required = fragment.required;
		if (fragment.additionalProperties !== undefined) attr.additionalProperties = fragment.additionalProperties;
	} else if (fragment.type === 'array' && fragment.items) {
		attr.type = 'array';
		// The element attribute's name is unused (attributeToFragment ignores it); keep it empty rather
		// than misleadingly reusing the array field's own name.
		attr.elements = fragmentToAttribute('', fragment.items);
	} else if (Array.isArray(fragment.type)) {
		// JSON-Schema union type. Fold a `'null'` member into `nullable` (the OpenAPI-expressible form)
		// and keep the remaining member. A single non-null member is the common `['T','null']` case; a
		// genuine multi-type union isn't expressible on an attribute, so the first member is kept.
		const members = fragment.type.filter((t) => t !== 'null');
		if (members.length !== fragment.type.length) attr.nullable = true;
		if (members.length > 0) attr.type = members[0];
	} else if (fragment.type != null) {
		attr.type = fragment.type;
	}
	if (fragment.description) attr.description = fragment.description;
	if (fragment.primaryKey) attr.isPrimaryKey = true;
	if (fragment.assignCreatedTime) attr.assignCreatedTime = true;
	if (fragment.assignUpdatedTime) attr.assignUpdatedTime = true;
	if (fragment.hidden) attr.hidden = true;
	if (fragment.nullable) attr.nullable = true;
	if (fragment.enum) attr.enum = fragment.enum;
	if (fragment.format) attr.format = fragment.format;
	if (fragment.const !== undefined) attr.const = fragment.const;
	return attr;
}

/**
 * Project a `Record<string, JsonSchemaFragment>` (the `static properties` form) back into the
 * `Attribute[]` Array the schema-derivation paths consume. Inverse of `projectAttributesToProperties`.
 */
export function projectPropertiesToAttributes(properties: Record<string, JsonSchemaFragment>): AttributeLike[] {
	return Object.entries(properties).map(([name, fragment]) => fragmentToAttribute(name, fragment));
}

/**
 * The schema dialect a consumer surface emits. The two differ in exactly one respect that matters
 * here: JSON Schema expresses nullability as a `'null'` member of a type union, while OpenAPI 3.0.3
 * has no union types and uses the `nullable` keyword.
 */
export type SchemaDialect = 'json-schema' | 'openapi-3.0.3';

export interface SchemaEmitOptions {
	dialect: SchemaDialect;
	/**
	 * Maps a leaf attribute's declared type to its base schema. Each surface keeps its own primitive
	 * mapping — MCP widens `Date` to `['string','number']` and tags `Bytes` with `contentEncoding`,
	 * OpenAPI emits a `format`. Those differences are deliberate, so they stay with the caller; only
	 * the traversal around them is shared. The attribute is passed so a diagnostic can name the
	 * property the type was declared on, rather than whatever the recursion started from.
	 */
	mapPrimitive: (type: string | undefined, attr: AttributeLike) => JsonSchemaFragment;
	/**
	 * Emit the attribute even when it is `hidden`. Only for the primary key, which verb tools surface
	 * as the `id` addressing argument rather than as a field — `@hidden` suppresses a field from the
	 * schema, but the key you address a record by is still required to call the tool.
	 */
	ignoreHidden?: boolean;
}

/**
 * Harper primitive type names that carry no `DATA_TYPES` entry. `Any` is deliberately untyped (it
 * accepts anything); `Blob` is a first-class column type that serializes as a string. Both are in
 * `graphql.ts`'s `PRIMITIVE_TYPES`, so neither is a typo and neither should warn.
 */
const UNMAPPED_HARPER_TYPES: Record<string, JsonSchemaType | undefined> = { Any: undefined, Blob: 'string' };

const warnedUnknownTypes = new Set<string>();

/**
 * Resolve a declared type name to its JSON Schema equivalent, or `undefined` when the name belongs to
 * neither vocabulary. Harper recognizes both the capitalized GraphQL names (`String`, `Int`) and the
 * lowercase JSON Schema names a `static properties` fragment uses.
 *
 * An unrecognized name used to resolve differently per surface — MCP coerced it to `'string'`, OpenAPI
 * emitted an untyped `{}` — with no signal to the author. Warn once per name so a typo is visible
 * instead of silently producing two different wrong schemas (#1942).
 */
export function resolveDeclaredType(type: string | undefined, context?: string): JsonSchemaType | undefined {
	if (!type) return undefined;
	// `Object.hasOwn`, not a bare index: `DATA_TYPES` is an object literal, so `type: 'constructor'`
	// or `'__proto__'` would otherwise resolve to a prototype member and put a function (or
	// `Object.prototype`) into an emitted schema.
	if (Object.hasOwn(DATA_TYPES, type)) return DATA_TYPES[type];
	if (Object.hasOwn(UNMAPPED_HARPER_TYPES, type)) return UNMAPPED_HARPER_TYPES[type];
	if (JSON_SCHEMA_SCALAR_TYPES.has(type)) return type as JsonSchemaType;
	if (!warnedUnknownTypes.has(type)) {
		warnedUnknownTypes.add(type);
		const harperTypes = [...Object.keys(DATA_TYPES), ...Object.keys(UNMAPPED_HARPER_TYPES)].join(', ');
		logger.warn(
			`Unrecognized schema type "${type}"${context ? ` on ${context}` : ''}: not a Harper type (${harperTypes}) nor a JSON Schema type (${[...JSON_SCHEMA_SCALAR_TYPES].join(', ')}). The property will be emitted without a type.`
		);
	}
	return undefined;
}

/** Test hook: the unknown-type warning is once-per-process, which would leak across test cases. */
export function _resetUnknownTypeWarningsForTest(): void {
	warnedUnknownTypes.clear();
}

/**
 * Emit an attribute as a schema fragment for a *consumer* surface (MCP tool descriptors, the OpenAPI
 * document), as opposed to `attributeToFragment`, which produces the canonical, front-end-neutral
 * `Table.properties` Record.
 *
 * Returns `undefined` for a `hidden` attribute so callers skip it — at every nesting level, not just
 * the top one. Suppression used to be implemented in each surface's top-level loop, so a hidden
 * sub-property of a nested object was emitted anyway, and OpenAPI additionally leaked `hidden: true`
 * into the public document as a schema key (#1941).
 *
 * Per-property hints (`description`, `enum`, `format`, `const`) propagate at every level too; OpenAPI
 * previously attached them only to top-level properties, so the two surfaces described the same nested
 * fragment differently (#1942).
 */
export function attributeToSchema(attr: AttributeLike, options: SchemaEmitOptions): JsonSchemaFragment | undefined {
	if (attr.hidden && !options.ignoreHidden) return undefined;
	const fragment: JsonSchemaFragment = {};
	// `ignoreHidden` applies to this attribute only — a hidden sub-property of a surfaced primary key
	// is still a hidden field and stays suppressed.
	const childOptions = options.ignoreHidden ? { ...options, ignoreHidden: false } : options;

	if (attr.properties) {
		fragment.type = 'object';
		fragment.properties = {};
		const visibleNames = new Set<string>();
		for (const sub of attr.properties) {
			const subSchema = attributeToSchema(sub, childOptions);
			if (!subSchema) continue;
			fragment.properties[sub.name] = subSchema;
			visibleNames.add(sub.name);
		}
		// Drop suppressed sub-properties from `required` too — advertising a required property the
		// schema does not define makes the object unsatisfiable for any client that validates. Omit the
		// key entirely when nothing survives: JSON Schema draft-04 (which OpenAPI 3.0.3 inherits)
		// requires `required` to have at least one element, so `required: []` fails validators.
		if (attr.required) {
			const visibleRequired = attr.required.filter((name) => visibleNames.has(name));
			if (visibleRequired.length > 0) fragment.required = visibleRequired;
		}
		if (attr.additionalProperties !== undefined) fragment.additionalProperties = attr.additionalProperties;
	} else if (attr.type === 'array') {
		fragment.type = 'array';
		// `{ type: 'array' }` with no element schema is valid — an array of anything.
		if (attr.elements) {
			const items = attributeToSchema(attr.elements, childOptions);
			if (items) fragment.items = items;
		}
	} else {
		Object.assign(fragment, options.mapPrimitive(attr.type, attr));
	}

	if (attr.nullable) applyNullability(fragment, options.dialect);
	if (attr.description && fragment.description === undefined) fragment.description = attr.description;
	if (attr.enum && fragment.enum === undefined) fragment.enum = attr.enum;
	if (attr.format && fragment.format === undefined) fragment.format = attr.format;
	if (attr.const !== undefined && fragment.const === undefined) fragment.const = attr.const;
	// `hidden` / `primaryKey` / `assignCreatedTime` / `assignUpdatedTime` are Harper directives, not
	// schema vocabulary — they never belong in an emitted document.
	return fragment;
}

function applyNullability(fragment: JsonSchemaFragment, dialect: SchemaDialect): void {
	// Both dialects express nullability as a modification of `type`, so neither has anything to say
	// about a fragment that never resolved one.
	if (!('type' in fragment) || fragment.type === undefined) return;
	if (dialect === 'openapi-3.0.3') {
		// OpenAPI 3.0.3 has no union types; `nullable` is the spec-provided expression.
		fragment.nullable = true;
		return;
	}
	const types = Array.isArray(fragment.type) ? fragment.type : [fragment.type];
	if (!types.includes('null')) fragment.type = [...types, 'null'] as JsonSchemaType[];
}

/**
 * The effective attribute Array for a Resource/Table class: its declared `attributes` when present,
 * otherwise the projection of a bare `static properties` declaration. Keeps MCP and OpenAPI schema
 * derivation identical for table-backed and programmatic Resources.
 */
export function resolveAttributes(source?: {
	attributes?: AttributeLike[];
	properties?: Record<string, JsonSchemaFragment>;
}): AttributeLike[] {
	if (source?.attributes?.length) return source.attributes;
	if (source?.properties) return projectPropertiesToAttributes(source.properties);
	return [];
}
