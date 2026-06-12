/**
 * Derive MCP tool input schemas from a Harper Resource's `Table.attributes`.
 *
 * Harper attribute types map to JSON Schema's primitive types; nested
 * `properties[]` and array `elements` map recursively. `attribute_permissions`
 * (per role, per table) narrows the schema by removing attributes the user
 * can't read (for `get_*`/`search_*`) or write (for `create_*`/`update_*`).
 *
 * Runtime enforcement still happens in `Table.allowUpdate` /
 * `Table.allowCreate` — the schema narrowing here is a UX layer (so the LLM
 * doesn't waste tokens on fields it can't write), NOT a security boundary.
 */

export interface HarperAttribute {
	name: string;
	type?: string;
	description?: string;
	hidden?: boolean;
	nullable?: boolean;
	isPrimaryKey?: boolean;
	properties?: HarperAttribute[];
	elements?: HarperAttribute;
	computed?: unknown;
	computedFromExpression?: string;
	assignCreatedTime?: boolean;
	assignUpdatedTime?: boolean;
	expiresAt?: boolean;
}

export interface AttributePermissionEntry {
	attribute_name: string;
	read?: boolean;
	insert?: boolean;
	update?: boolean;
}

type Mode = 'read' | 'insert' | 'update';

/**
 * Maps a Harper attribute type to a JSON Schema `type` value (or list of
 * types when nullable). Falls back to "string" for unknown types — better
 * than blocking the field entirely; the runtime will validate.
 */
function harperTypeToJsonSchema(type: string | undefined): { type: string | string[] } | object {
	switch (type) {
		case 'Int':
		case 'Long':
		case 'BigInt':
			return { type: 'integer' };
		case 'Float':
			return { type: 'number' };
		case 'Boolean':
			return { type: 'boolean' };
		case 'String':
		case 'ID':
			return { type: 'string' };
		case 'Date':
			// Harper Date may be ISO string or number; allow both for LLM flexibility.
			return { type: ['string', 'number'], description: 'ISO 8601 timestamp or epoch milliseconds.' };
		case 'Bytes':
		case 'Blob':
			return { type: 'string', contentEncoding: 'base64' };
		case 'Any':
		case undefined:
			return {};
		default:
			return { type: 'string' };
	}
}

function attributeToProperty(attr: HarperAttribute): object {
	let base: { type?: string | string[]; description?: string; [key: string]: unknown };
	if (attr.type === 'Object' && attr.properties) {
		base = {
			type: 'object',
			properties: Object.fromEntries(attr.properties.map((p) => [p.name, attributeToProperty(p)])),
		};
	} else if (attr.type === 'Array' && attr.elements) {
		base = {
			type: 'array',
			items: attributeToProperty(attr.elements),
		};
	} else {
		base = harperTypeToJsonSchema(attr.type) as typeof base;
	}
	if (attr.nullable && 'type' in base) {
		const t = base.type;
		const types = Array.isArray(t) ? t : [t as string];
		if (!types.includes('null')) {
			base.type = [...types, 'null'];
		}
	}
	if (attr.description && !base.description) {
		base.description = attr.description;
	}
	return base;
}

/**
 * `true` if the user has the requested mode (read/insert/update) on this
 * attribute. When no per-attribute permissions exist, returns true (the
 * table-level perm gates the call already).
 */
function attributeAllowed(
	attributeName: string,
	permissions: AttributePermissionEntry[] | undefined,
	mode: Mode
): boolean {
	if (!permissions || permissions.length === 0) return true;
	const match = permissions.find((p) => p.attribute_name === attributeName);
	if (!match) return false; // explicit list with no entry → denied
	return match[mode] !== false;
}

/**
 * Composed visibility: an attribute is visible when it is NOT @hidden AND the
 * caller is allowed under attribute_permissions for the requested mode. The
 * `@hidden` directive is a metadata-visibility signal — it suppresses the
 * attribute from MCP descriptors and OpenAPI emit. RBAC remains the
 * enforcement mechanism for data access.
 */
function attributeVisible(
	attr: HarperAttribute,
	permissions: AttributePermissionEntry[] | undefined,
	mode: Mode
): boolean {
	if (attr.hidden) return false;
	return attributeAllowed(attr.name, permissions, mode);
}

/**
 * Build a JSON Schema object covering some subset of the table's attributes.
 * `mode` controls how attribute_permissions are interpreted; `include`
 * optionally limits to a subset (e.g. primary-key-only for `delete_*`).
 */
function buildPropertiesObject(
	attributes: HarperAttribute[],
	permissions: AttributePermissionEntry[] | undefined,
	mode: Mode,
	include?: (a: HarperAttribute) => boolean
): { properties: Record<string, object>; required: string[] } {
	const properties: Record<string, object> = {};
	const required: string[] = [];
	for (const attr of attributes) {
		if (include && !include(attr)) continue;
		if (!attributeVisible(attr, permissions, mode)) continue;
		// Skip auto-managed columns from write inputs — Harper assigns them.
		if (mode !== 'read' && (attr.assignCreatedTime || attr.assignUpdatedTime || attr.expiresAt)) continue;
		if (mode !== 'read' && (attr.computed !== undefined || attr.computedFromExpression !== undefined)) continue;
		properties[attr.name] = attributeToProperty(attr);
		if (mode === 'insert' && !attr.nullable && !attr.isPrimaryKey) {
			required.push(attr.name);
		}
	}
	return { properties, required };
}

function findPrimaryKey(attributes: HarperAttribute[]): HarperAttribute | undefined {
	return attributes.find((a) => a.isPrimaryKey);
}

export function deriveGetSchema(
	attributes: HarperAttribute[],
	_permissions: AttributePermissionEntry[] | undefined
): object {
	const pk = findPrimaryKey(attributes);
	const pkSchema = pk ? attributeToProperty(pk) : { type: 'string' };
	return {
		type: 'object',
		properties: {
			id: { ...pkSchema, description: pk ? `Primary key (${pk.name}).` : 'Primary key.' },
			get_attributes: {
				type: 'array',
				items: { type: 'string' },
				description: 'Attribute names to project; defaults to all readable attributes.',
			},
		},
		required: ['id'],
	};
}

export function deriveSearchSchema(
	attributes: HarperAttribute[],
	permissions: AttributePermissionEntry[] | undefined
): object {
	// `conditions` is freeform — Harper supports many comparators; we expose
	// the common subset and rely on server-side validation for the rest.
	const readableAttrs = attributes.filter((a) => attributeVisible(a, permissions, 'read'));
	const attrNames = readableAttrs.map((a) => a.name);
	return {
		type: 'object',
		properties: {
			conditions: {
				type: 'array',
				items: {
					type: 'object',
					properties: {
						attribute: {
							type: 'string',
							...(attrNames.length > 0 ? { enum: attrNames } : {}),
							description: 'Attribute name to filter on.',
						},
						comparator: {
							type: 'string',
							enum: [
								'equals',
								'not_equals',
								'contains',
								'starts_with',
								'ends_with',
								'greater_than',
								'less_than',
								'greater_than_equal',
								'less_than_equal',
								'between',
							],
							description: 'Comparison operator. Defaults to "equals" if omitted.',
						},
						value: { description: 'Comparison value (any JSON type).' },
					},
					required: ['attribute', 'value'],
				},
			},
			operator: { type: 'string', enum: ['and', 'or'], description: 'How to combine conditions; defaults to "and".' },
			get_attributes: { type: 'array', items: { type: 'string' } },
			limit: { type: 'integer', minimum: 1, description: 'Max records to return on this page.' },
			cursor: { type: 'string', description: 'Opaque pagination cursor returned by a previous call.' },
		},
	};
}

export function deriveCreateSchema(
	attributes: HarperAttribute[],
	permissions: AttributePermissionEntry[] | undefined
): object {
	const { properties, required } = buildPropertiesObject(attributes, permissions, 'insert');
	const schema: { type: string; properties: Record<string, object>; required?: string[] } = {
		type: 'object',
		properties,
	};
	if (required.length > 0) schema.required = required;
	return schema;
}

export function deriveUpdateSchema(
	attributes: HarperAttribute[],
	permissions: AttributePermissionEntry[] | undefined
): object {
	const pk = findPrimaryKey(attributes);
	const { properties } = buildPropertiesObject(attributes, permissions, 'update', (a) => !a.isPrimaryKey);
	return {
		type: 'object',
		properties: {
			id: pk
				? { ...attributeToProperty(pk), description: `Primary key (${pk.name}). Required.` }
				: { type: 'string', description: 'Primary key. Required.' },
			...properties,
		},
		required: ['id'],
	};
}

export function deriveDeleteSchema(
	attributes: HarperAttribute[],
	_permissions: AttributePermissionEntry[] | undefined
): object {
	const pk = findPrimaryKey(attributes);
	return {
		type: 'object',
		properties: {
			id: pk
				? { ...attributeToProperty(pk), description: `Primary key (${pk.name}).` }
				: { type: 'string', description: 'Primary key.' },
		},
		required: ['id'],
	};
}

/**
 * Full record shape — every visible attribute as it appears in returned records.
 * Used as the outputSchema for get/create/update/patch. Reflects what the
 * server returns, not what the client sends: server-assigned fields
 * (@createdTime, @updatedTime, @primaryKey) appear as required in output even
 * though they're optional on input.
 *
 * `search_*` deliberately omits outputSchema — envelope shape (records vs
 * data, cursor vs nextCursor) is tracked in the sibling issue.
 */
function deriveRecordSchema(
	attributes: HarperAttribute[],
	permissions: AttributePermissionEntry[] | undefined
): object {
	const properties: Record<string, object> = {};
	const required: string[] = [];
	for (const attr of attributes) {
		if (!attributeVisible(attr, permissions, 'read')) continue;
		properties[attr.name] = attributeToProperty(attr);
		const requiredOnOutput =
			attr.nullable === false || attr.assignCreatedTime || attr.assignUpdatedTime || attr.isPrimaryKey;
		if (requiredOnOutput) required.push(attr.name);
	}
	const schema: {
		type: string;
		properties: Record<string, object>;
		required?: string[];
		additionalProperties: boolean;
	} = {
		type: 'object',
		properties,
		additionalProperties: false,
	};
	if (required.length > 0) schema.required = required;
	return schema;
}

export function deriveGetOutputSchema(
	attributes: HarperAttribute[],
	permissions: AttributePermissionEntry[] | undefined
): object {
	return deriveRecordSchema(attributes, permissions);
}

export function deriveCreateOutputSchema(
	attributes: HarperAttribute[],
	permissions: AttributePermissionEntry[] | undefined
): object {
	return deriveRecordSchema(attributes, permissions);
}

export function deriveUpdateOutputSchema(
	attributes: HarperAttribute[],
	permissions: AttributePermissionEntry[] | undefined
): object {
	return deriveRecordSchema(attributes, permissions);
}

export function derivePatchOutputSchema(
	attributes: HarperAttribute[],
	permissions: AttributePermissionEntry[] | undefined
): object {
	return deriveRecordSchema(attributes, permissions);
}

/**
 * Output schema for delete responses. Table.delete returns Promise<boolean>;
 * makeDeleteHandler wraps it as wrapResult(data ?? { ok: true }) — so on
 * success the MCP response carries a text content of "true" with no
 * structuredContent. Advertise the actual contract (boolean) rather than a
 * synthesized object envelope the handler never produces.
 */
export function deriveDeleteOutputSchema(_attributes: HarperAttribute[]): object {
	return {
		type: 'boolean',
		description: 'True when the record was deleted; false when no record matched the primary key.',
	};
}
