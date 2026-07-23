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
	if (attr.enum) fragment.enum = attr.enum;
	if (attr.format) fragment.format = attr.format;
	if (attr.const !== undefined) fragment.const = attr.const;
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
	} else if (fragment.type === 'array' && fragment.items) {
		attr.type = 'array';
		attr.elements = fragmentToAttribute(name, fragment.items);
	} else if (fragment.type != null) {
		attr.type = Array.isArray(fragment.type) ? fragment.type[0] : fragment.type;
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
