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
	type?: string | readonly string[];
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
	/** Emitted when mapped union members need schemas richer than a JSON Schema `type` array. */
	anyOf?: JsonSchemaFragment[];
	/** Binary encoding of a string-typed value. Emitted on the MCP surface only — not a 3.0.3 keyword. */
	contentEncoding?: string;
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
	/**
	 * The source JSON-Schema type union, verbatim, when `static properties` declared one. `type` holds
	 * the first non-null member so single-type consumers keep working; surfaces that can express a
	 * union (MCP passes it through, OpenAPI 3.0 translates it to `anyOf`) read this instead.
	 */
	types?: readonly string[];
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
	requiredOnSchema?: boolean;
	relationship?: unknown;
	definition?: unknown;
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
		fragment.type = attr.types ? [...attr.types] : 'object';
		fragment.properties = Object.create(null);
		for (const sub of attr.properties) fragment.properties[sub.name] = attributeToFragment(sub);
		if (attr.required) fragment.required = attr.required;
		if (attr.additionalProperties !== undefined) fragment.additionalProperties = attr.additionalProperties;
	} else if (attr.type === 'array' && attr.elements) {
		fragment.type = attr.types ? [...attr.types] : 'array';
		fragment.items = attributeToFragment(attr.elements);
	} else if (attr.types) {
		// A declared union round-trips verbatim; collapsing it to `attr.type` here would make the
		// canonical `Table.properties` disagree with what the author wrote.
		fragment.type = [...attr.types];
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
	if (attr.nullable && !attr.types?.includes('null')) fragment.nullable = true;
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
	const result: Record<string, JsonSchemaFragment> = Object.create(null);
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
const MAX_SCHEMA_DEPTH = 100;
const projectedProperties = new WeakMap<object, { requiredSignature: string; attributes: readonly AttributeLike[] }>();

export class SchemaTraversalError extends Error {}

function fragmentToAttribute(
	name: string,
	fragment: JsonSchemaFragment,
	ancestors: WeakSet<object>,
	depth: number
): AttributeLike {
	if (fragment === null || typeof fragment !== 'object' || Array.isArray(fragment)) {
		throw new TypeError(`Schema property "${name}" must be an object`);
	}
	if (depth > MAX_SCHEMA_DEPTH) throw new RangeError(`Schema property "${name}" exceeds ${MAX_SCHEMA_DEPTH} levels`);
	if (ancestors.has(fragment)) throw new TypeError(`Schema property "${name}" contains a cycle`);
	ancestors.add(fragment);
	const attr: AttributeLike = { name };
	try {
		if (Array.isArray(fragment.type)) {
			if (!fragment.type.every((type) => typeof type === 'string')) {
				throw new TypeError(`Schema property "${name}.type" must contain only strings`);
			}
			attr.types = fragment.type;
			const members = fragment.type.filter((type) => type !== 'null');
			if (members.length !== fragment.type.length) attr.nullable = true;
			if (members.length > 0) attr.type = members[0];
		} else if (fragment.type != null) {
			if (typeof fragment.type !== 'string') throw new TypeError(`Schema property "${name}.type" must be a string`);
			attr.type = fragment.type;
		}
		if (fragment.required !== undefined) {
			if (!Array.isArray(fragment.required) || !fragment.required.every((item) => typeof item === 'string')) {
				throw new TypeError(`Schema property "${name}.required" must be an array of strings`);
			}
			if (new Set(fragment.required).size !== fragment.required.length) {
				throw new TypeError(`Schema property "${name}.required" must contain unique names`);
			}
		}
		let normalizedEnum: JsonSchemaFragment['enum'];
		if (fragment.enum !== undefined) {
			if (!Array.isArray(fragment.enum) || fragment.enum.length === 0) {
				throw new TypeError(`Schema property "${name}.enum" must be a non-empty array`);
			}
			if (
				!fragment.enum.every(
					(value) =>
						value === null ||
						typeof value === 'string' ||
						typeof value === 'boolean' ||
						(typeof value === 'number' && Number.isFinite(value))
				)
			) {
				throw new TypeError(`Schema property "${name}.enum" must contain only JSON scalar values`);
			}
			normalizedEnum = [...new Set(fragment.enum)];
		}
		if (fragment.const !== undefined) {
			if (typeof fragment.const === 'number' && !Number.isFinite(fragment.const)) {
				throw new TypeError(`Schema property "${name}.const" must be JSON-serializable`);
			}
			try {
				if (JSON.stringify(fragment.const) === undefined) throw new TypeError();
			} catch {
				throw new TypeError(`Schema property "${name}.const" must be JSON-serializable`);
			}
		}
		if (normalizedEnum && fragment.const !== undefined && !normalizedEnum.includes(fragment.const as never)) {
			throw new TypeError(`Schema property "${name}.const" must be included in its enum`);
		}
		if (fragment.properties !== undefined) {
			if (
				fragment.properties === null ||
				typeof fragment.properties !== 'object' ||
				Array.isArray(fragment.properties)
			) {
				throw new TypeError(`Schema property "${name}.properties" must be an object`);
			}
			attr.properties = Object.entries(fragment.properties).map(([subName, sub]) =>
				fragmentToAttribute(subName, sub, ancestors, depth + 1)
			);
			attr.type ??= 'object';
			if (fragment.required) attr.required = fragment.required;
			if (fragment.additionalProperties !== undefined) attr.additionalProperties = fragment.additionalProperties;
		}
		const declaredTypes = Array.isArray(fragment.type) ? fragment.type : [fragment.type];
		if (declaredTypes.includes('array') && fragment.items !== undefined) {
			attr.elements = fragmentToAttribute('', fragment.items, ancestors, depth + 1);
		}
		if (fragment.description) attr.description = fragment.description;
		if (fragment.primaryKey) attr.isPrimaryKey = true;
		if (fragment.assignCreatedTime) attr.assignCreatedTime = true;
		if (fragment.assignUpdatedTime) attr.assignUpdatedTime = true;
		if (fragment.hidden) attr.hidden = true;
		if (fragment.nullable !== undefined) attr.nullable = fragment.nullable;
		if (normalizedEnum) attr.enum = normalizedEnum;
		if (fragment.format) attr.format = fragment.format;
		if (fragment.const !== undefined) attr.const = fragment.const;
		return attr;
	} finally {
		ancestors.delete(fragment);
	}
}

/**
 * Project a `Record<string, JsonSchemaFragment>` (the `static properties` form) back into the
 * `Attribute[]` Array the schema-derivation paths consume. Inverse of `projectAttributesToProperties`.
 */
export function projectPropertiesToAttributes(properties: Record<string, JsonSchemaFragment>): AttributeLike[] {
	if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) {
		throw new TypeError('Resource properties must be an object');
	}
	const ancestors = new WeakSet<object>();
	return Object.entries(properties).map(([name, fragment]) => fragmentToAttribute(name, fragment, ancestors, 1));
}

function freezeAttribute(attr: AttributeLike): AttributeLike {
	if (attr.properties) attr.properties = Object.freeze(attr.properties.map(freezeAttribute)) as AttributeLike[];
	if (attr.elements) freezeAttribute(attr.elements);
	return Object.freeze(attr);
}

export function filterAttributeTree(
	attributes: AttributeLike[],
	include: (attribute: AttributeLike) => boolean = (attribute) => !attribute.hidden
): AttributeLike[] {
	const ancestors = new WeakSet<object>();
	const visit = (attribute: AttributeLike, depth: number): AttributeLike | undefined => {
		if (!include(attribute)) return undefined;
		if (depth > MAX_SCHEMA_DEPTH) {
			throw new SchemaTraversalError(`Schema attribute "${attribute.name}" exceeds ${MAX_SCHEMA_DEPTH} levels`);
		}
		if (ancestors.has(attribute))
			throw new SchemaTraversalError(`Schema attribute "${attribute.name}" contains a cycle`);
		ancestors.add(attribute);
		try {
			const visible = { ...attribute };
			const reference = attribute.relationship || attribute.definition || attribute.elements?.definition;
			if (reference) {
				delete visible.properties;
				return visible;
			}
			if (attribute.properties && Object.prototype.propertyIsEnumerable.call(attribute, 'properties')) {
				visible.properties = attribute.properties
					.map((child) => visit(child, depth + 1))
					.filter((child): child is AttributeLike => child !== undefined);
				if (attribute.required) {
					const names = new Set(visible.properties.map((child) => child.name));
					const required = attribute.required.filter((name) => names.has(name));
					if (required.length) visible.required = required;
					else delete visible.required;
				}
			}
			if (attribute.elements) {
				const elements = visit(attribute.elements, depth + 1);
				if (elements) visible.elements = elements;
				else delete visible.elements;
			}
			return visible;
		} finally {
			ancestors.delete(attribute);
		}
	};
	return attributes
		.map((attribute) => visit(attribute, 1))
		.filter((attribute): attribute is AttributeLike => attribute !== undefined);
}

function validateTopLevelRequired(required: readonly string[] | undefined, properties: object): readonly string[] {
	if (required === undefined) return [];
	if (!Array.isArray(required) || !required.every((name) => typeof name === 'string')) {
		throw new TypeError('Resource required must be an array of strings');
	}
	if (new Set(required).size !== required.length) throw new TypeError('Resource required must contain unique names');
	for (const name of required) {
		if (!Object.hasOwn(properties, name))
			throw new TypeError(`Resource required references unknown property "${name}"`);
	}
	return required;
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
 * Returns `undefined` for a `hidden` attribute so callers skip it at every nesting level.
 */
export function attributeToSchema(attr: AttributeLike, options: SchemaEmitOptions): JsonSchemaFragment | undefined {
	return emitAttributeSchema(attr, options, new WeakSet(), 0);
}

function emitAttributeSchema(
	attr: AttributeLike,
	options: SchemaEmitOptions,
	ancestors: WeakSet<object>,
	depth: number
): JsonSchemaFragment | undefined {
	if (attr.hidden && !options.ignoreHidden) return undefined;
	if (depth > MAX_SCHEMA_DEPTH)
		throw new SchemaTraversalError(`Schema attribute "${attr.name}" exceeds ${MAX_SCHEMA_DEPTH} levels`);
	if (ancestors.has(attr)) throw new SchemaTraversalError(`Schema attribute "${attr.name}" contains a cycle`);
	ancestors.add(attr);
	try {
		const fragment: JsonSchemaFragment = {};
		const reference = attr.relationship;
		if (reference) {
			const target = reference as { database?: string; table?: string; type?: string };
			const label = [target.database, target.table ?? target.type].filter(Boolean).join('.');
			if (attr.type === 'array') {
				return {
					type: 'array',
					items: {},
					...(attr.description || label ? { description: attr.description ?? `Reference to ${label}.` } : {}),
				};
			}
			return attr.description || label ? { description: attr.description ?? `Reference to ${label}.` } : {};
		}
		// `ignoreHidden` applies to this attribute only — a hidden sub-property of a surfaced primary key
		// is still a hidden field and stays suppressed.
		const childOptions = options.ignoreHidden ? { ...options, ignoreHidden: false } : options;
		const unionTypes = attr.types?.filter((member) => member !== 'null');
		const structuralUnionMember = (member: string): JsonSchemaFragment | undefined => {
			if (member === 'object' && attr.properties) {
				return emitAttributeSchema(
					{
						name: attr.name,
						type: 'object',
						properties: attr.properties,
						required: attr.required,
						additionalProperties: attr.additionalProperties,
					},
					childOptions,
					ancestors,
					depth + 1
				);
			}
			if (member === 'array') {
				return emitAttributeSchema(
					{ name: attr.name, type: 'array', elements: attr.elements },
					childOptions,
					ancestors,
					depth + 1
				);
			}
			return options.mapPrimitive(member, attr);
		};

		if (unionTypes && unionTypes.length > 1) {
			const mapped = [
				...new Map(
					unionTypes
						.map(structuralUnionMember)
						.filter((schema): schema is JsonSchemaFragment => Boolean(schema && Object.keys(schema).length > 0))
						.map((schema) => [JSON.stringify(schema), schema])
				).values(),
			];
			if (mapped.length === 1) {
				Object.assign(fragment, mapped[0]);
			} else if (mapped.length > 1) {
				const onlyTypes = mapped.every((schema) => Object.keys(schema).length === 1 && schema.type !== undefined);
				if (options.dialect === 'json-schema' && onlyTypes) {
					fragment.type = [
						...new Set(mapped.flatMap((schema) => (Array.isArray(schema.type) ? schema.type : [schema.type]))),
					] as JsonSchemaType[];
				} else {
					fragment.anyOf = mapped;
				}
			}
		} else if (attr.properties) {
			fragment.type = 'object';
			fragment.properties = Object.create(null);
			const suppressedNames = new Set<string>();
			for (const sub of attr.properties) {
				const subSchema = emitAttributeSchema(sub, childOptions, ancestors, depth + 1);
				if (!subSchema) {
					suppressedNames.add(sub.name);
					continue;
				}
				fragment.properties[sub.name] = subSchema;
			}
			// Drop suppressed sub-properties from `required` too — advertising a required property the
			// schema does not define makes the object unsatisfiable for any client that validates. Omit the
			// key entirely when nothing survives: JSON Schema draft-04 (which OpenAPI 3.0.3 inherits)
			// requires `required` to have at least one element, so `required: []` fails validators.
			if (attr.required) {
				const visibleRequired = attr.required.filter((name) => !suppressedNames.has(name));
				if (visibleRequired.length > 0) fragment.required = visibleRequired;
			}
			if (attr.additionalProperties !== undefined) fragment.additionalProperties = attr.additionalProperties;
		} else if (attr.type === 'array') {
			fragment.type = 'array';
			if (attr.elements) {
				const items = emitAttributeSchema(attr.elements, childOptions, ancestors, depth + 1);
				if (items) fragment.items = items;
			}
			if (options.dialect === 'openapi-3.0.3' && fragment.items === undefined) fragment.items = {};
		} else {
			if (attr.types?.every((member) => member === 'null')) {
				Object.assign(fragment, options.mapPrimitive('null', attr));
			} else {
				Object.assign(fragment, options.mapPrimitive(attr.type, attr));
			}
		}

		const nullOnly = attr.types?.every((member) => member === 'null');
		if (attr.nullable && !nullOnly) applyNullability(fragment, options.dialect);
		// An explicitly declared `description`/`format` outranks whatever the primitive mapper supplied as a
		// default — an author writing `{ type: 'Date', format: 'date-time' }` means `date-time`, not the
		// Harper type name the mapper stamps on.
		if (attr.description) fragment.description = attr.description;
		if (attr.enum && fragment.enum === undefined) fragment.enum = attr.enum;
		if (attr.format) fragment.format = attr.format;
		if (attr.const !== undefined) {
			// `const` is JSON Schema draft-06. OpenAPI 3.0.3's Schema Object is the draft-04 subset, so it
			// has no such keyword — emit the equivalent single-value `enum` for that dialect. MCP speaks
			// current JSON Schema and takes `const` directly.
			if (options.dialect === 'openapi-3.0.3') {
				// Intersect rather than skip when both are declared: dropping the `const` would leave OpenAPI
				// advertising a wider value set than MCP, from one declaration.
				fragment.enum = fragment.enum
					? (fragment.enum.filter((value) => value === attr.const) as never[])
					: [attr.const as never];
			} else if (fragment.const === undefined) {
				fragment.const = attr.const;
			}
		}
		// Harper's explicit `nullable` directive widens a value constraint; a JSON Schema type union does
		// not override the intersection semantics of a co-declared `enum`.
		const explicitlyNullable = attr.nullable && !attr.types?.includes('null');
		if (attr.const === undefined && explicitlyNullable && fragment.enum && !fragment.enum.includes(null)) {
			fragment.enum = [...fragment.enum, null];
		}
		// `hidden` / `primaryKey` / `assignCreatedTime` / `assignUpdatedTime` are Harper directives, not
		// schema vocabulary — they never belong in an emitted document.
		return fragment;
	} finally {
		ancestors.delete(attr);
	}
}

function applyNullability(fragment: JsonSchemaFragment, dialect: SchemaDialect): void {
	if ((!('type' in fragment) || fragment.type === undefined) && fragment.anyOf === undefined) return;
	if (fragment.type === undefined) {
		fragment.anyOf = [
			...fragment.anyOf,
			dialect === 'openapi-3.0.3' ? { nullable: true, enum: [null] } : { type: 'null' },
		];
		return;
	}
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
	properties?: Record<string, JsonSchemaFragment> | AttributeLike[];
	required?: readonly string[];
}): AttributeLike[] {
	if (source?.attributes?.length) return source.attributes;
	if (Array.isArray(source?.properties)) return source.properties;
	if (source?.properties !== undefined) {
		const required = validateTopLevelRequired(source.required, source.properties);
		const requiredSignature = JSON.stringify(required);
		const cached = projectedProperties.get(source.properties);
		if (cached?.requiredSignature === requiredSignature) return cached.attributes as AttributeLike[];
		const requiredNames = new Set(required);
		const attributes = projectPropertiesToAttributes(source.properties).map((attr) =>
			freezeAttribute(requiredNames.has(attr.name) ? { ...attr, requiredOnSchema: true } : attr)
		);
		Object.freeze(attributes);
		projectedProperties.set(source.properties, { requiredSignature, attributes });
		return attributes;
	}
	return [];
}
