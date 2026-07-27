import { packageJson } from '../utility/packageUtils.js';
import { Resources, routePatternToTemplate } from './Resources.ts';
import { Resource } from './Resource.ts';
import {
	DATA_TYPES,
	type AttributeLike,
	type JsonSchemaFragment,
	attributeToSchema,
	projectPropertiesToAttributes,
	resolveDeclaredType,
} from './jsonSchemaTypes.ts';

const OPENAPI_VERSION = '3.0.3';

/**
 * Emit an attribute as an OpenAPI 3.0.3 property schema. Shares its traversal with the MCP deriver so
 * the two can't describe the same nested fragment differently; the primitive mapping stays
 * OpenAPI-specific (`format` carries the Harper type name, which MCP has no equivalent for).
 * Returns `undefined` for a `@hidden` attribute — callers skip it.
 */
function attributeToOpenApiSchema(attr: AttributeLike): JsonSchemaFragment | undefined {
	return attributeToSchema(attr, {
		dialect: 'openapi-3.0.3',
		// `mapped` is the attribute the recursion actually reached, not the one it started from — a bad
		// type on `profile.creditScore` has to name that, not `profile`.
		mapPrimitive: (type, mapped) => openApiPrimitive(type, mapped.name || attr.name),
	});
}

/** Shared by the nested emitter and the top-level attribute loop so both warn on an unknown type. */
function openApiPrimitive(type: string | undefined, attributeName: string | undefined): JsonSchemaFragment {
	if (type === 'Any' || type === undefined) return {};
	const resolved = resolveDeclaredType(type, `OpenAPI property "${attributeName || '<unnamed>'}"`);
	if (!resolved) return {};
	// 3.0.x has no `'null'` type — nullability is the `nullable` keyword, so a bare `type: 'null'`
	// becomes an untyped nullable schema rather than a type the dialect can't express.
	if (resolved === 'null') return {}; // 3.0 has no null type; a bare `nullable` on an untyped schema says nothing
	// Preserve the Harper type name as `format` for the types where it adds information, matching the
	// top-level `Type()` emitter.
	return Object.hasOwn(DATA_TYPES, type) ? (new Type(resolved, type) as JsonSchemaFragment) : { type: resolved };
}

const SCHEMA_COMP_REF = '#/components/schemas/';
const DESCRIPTION_200 = 'successful operation';

export function generateJsonApi(resources: Resources, serverHttpURL: string) {
	const api = {
		openapi: OPENAPI_VERSION,
		info: {
			title: 'Harper HTTP REST interface',
			version: packageJson.version,
		},
		servers: [
			{
				description: 'REST API',
				url: serverHttpURL,
			},
		],
		paths: {},
		components: {
			schemas: {},
			securitySchemes: {
				basicAuth: {
					type: 'http',
					scheme: 'basic',
				},
				bearerAuth: {
					type: 'http',
					scheme: 'bearer',
					bearerFormat: 'JWT',
				},
			},
		},
	};

	const security = [
		{
			basicAuth: [],
			bearerAuth: [],
		},
	];

	const includeDefinitionInSchema = (def) => {
		if (def.type && !api.components.schemas[def.type]) {
			// Immediately define the type so we don't get caught in infinite recursions, until...
			api.components.schemas[def.type] = {};
			const defProps: Record<string, unknown> = {};
			const defRequired: string[] = [];
			// Iterate the Array form of the type's attributes. After the graphql parser
			// alignment, top-level typeDefs from `resources.allTypes` carry both
			// `.attributes` (Array, internal) and `.properties` (Record, canonical) —
			// we want the Array here. For nested sub-attribute defs (passed via
			// `prop` recursion below), `.properties` remains the Array form attached
			// by `Object.defineProperty` in graphql.ts. Coalesce so both call sites work.
			const subAttributes = def.attributes ?? def.properties;
			if (!subAttributes) {
				return;
			}
			for (const prop of subAttributes) {
				// @hidden: suppress the property from the emitted OpenAPI document.
				if (prop.hidden) continue;
				let entry: any;
				if (DATA_TYPES[prop.type]) {
					entry = new Type(DATA_TYPES[prop.type], prop.type);
				} else if (prop.properties) {
					entry = new Ref(prop.type);
					includeDefinitionInSchema(prop);
				} else if (prop.type === 'array' && prop.elements) {
					// Sub-attribute array. Primitive element types (e.g. [String], [Int]) go to a
					// Type-typed items entry; complex-typed elements recurse like the top-level path.
					if (prop.elements.properties) {
						entry = new ArrayRef(prop.elements.type);
						includeDefinitionInSchema(prop.elements);
					} else if (DATA_TYPES[prop.elements.type]) {
						entry = { type: 'array', items: new Type(DATA_TYPES[prop.elements.type], prop.elements.type) };
					} else {
						// Unknown / `Any` element — emit a loose array shape rather than dropping.
						entry = { type: 'array', items: { format: prop.elements.type } };
					}
				}
				if (entry) {
					if (prop.description) entry.description = prop.description;
					defProps[prop.name] = entry;
				}
				if (prop.nullable === false) {
					defRequired.push(prop.name);
				}
			}
			// ... down here we actually define the value for the new type.
			api.components.schemas[def.type] = new ResourceSchema(defProps, !def.sealed, defRequired, def.description);
		}
	};

	for (const [, resource] of resources) {
		// skip invalid and error resources
		if (!resource.path || resource.Resource.isError) continue;
		// @hidden type-level: drop the Resource from the OpenAPI document entirely.
		// Data remains queryable through Harper's other interfaces under RBAC.
		if (resource.Resource.hidden === true) continue;
		// request-contract resources (`defineResource`/`Resource.withSchema`) at a static (non-parameterised)
		// path are emitted below, alongside their parameterised counterparts, off the declared contract —
		// not the table-CRUD assumptions this loop makes (primary key, generated schema component, etc).
		if (resource.Resource.requestContract) continue;

		const { path } = resource;
		const strippedPath = path.split('/').pop(); // strip any namespace from path
		let { attributes, sealed } = resource.Resource;
		const { prototype, primaryKey = 'id' } = resource.Resource;
		// Class-level description from @table docstring or programmatic `static description`.
		// Used as both the schema-level `description` (in components.schemas) and as a prefix
		// on each path-level operation description.
		const tableDoc: string | undefined = resource.Resource.description;
		// A programmatic Resource may declare `static properties` (Record) without an `attributes`
		// Array; project it so per-property schemas are emitted instead of a skeletal object.
		if (!attributes?.length && resource.Resource.properties) {
			attributes = projectPropertiesToAttributes(resource.Resource.properties);
		}
		if (!attributes?.length && resources.allTypes.has(resource.path)) {
			const possibleType = resources.allTypes.get(resource.path);
			sealed = possibleType.sealed;
			attributes = possibleType.attributes ?? projectPropertiesToAttributes(possibleType.properties ?? {});
		}
		if (!primaryKey) continue;
		const props = {};
		const queryParamsArray = [];
		const resourceRequired: string[] = [];

		if (attributes) {
			for (const attr of attributes) {
				const { type, name, elements, relationship, definition, nullable, description, hidden } = attr;
				// @hidden field-level: suppress the attribute from props, query params, and required.
				if (hidden) continue;
				const def = definition ?? elements?.definition;
				if (def) {
					includeDefinitionInSchema(def);
				}

				if (nullable === false) {
					resourceRequired.push(name);
				}
				if (relationship) {
					if (type === 'array') {
						props[name] = { type: 'array', items: { $ref: SCHEMA_COMP_REF + elements.type } };
					} else {
						props[name] = { $ref: SCHEMA_COMP_REF + type };
					}
				} else {
					if (def) {
						if (type === 'array') {
							props[name] = { type: 'array', items: { $ref: SCHEMA_COMP_REF + def.type } };
						} else {
							props[name] = { $ref: SCHEMA_COMP_REF + def.type };
						}
					} else if (attr.properties) {
						// Nested object from `static properties` — emit the full object schema through the
						// shared emitter (sub-properties recursed, @hidden suppressed at every level, hints
						// carried); OpenAPI's table path uses $refs instead.
						props[name] = attributeToOpenApiSchema(attr) ?? {};
					} else if (type === 'array') {
						if (!elements) {
							// `{ type: 'array' }` with no items — valid JSON Schema (array of anything).
							props[name] = { type: 'array' };
						} else if (elements.type === 'Any') {
							props[name] = { type: 'array', items: { format: elements.type } };
						} else {
							// Object and primitive elements alike go through the shared emitter, so an item's
							// enum/format/const/description survives instead of being flattened to its type.
							props[name] = { type: 'array', items: attributeToOpenApiSchema(elements) ?? {} };
						}
					} else if (type === 'Any') {
						// `format: 'Any'` with no `type` — preserved from the original emitter.
						props[name] = { format: type };
					} else {
						// Through the shared primitive mapper so an unrecognized type name warns here too.
						// Previously only the MCP deriver warned, so a typo went unreported whenever the MCP
						// component was disabled — the exact silence #1942 set out to remove.
						props[name] = openApiPrimitive(type, name);
					}
				}
				// Attach per-property JSON-Schema hints (description/enum/format/const) so they surface in
				// Swagger UI / Redoc; enum in particular tells clients the allowed values. `nullable` is
				// OpenAPI 3.0.3's expression of a nullable property — it was previously computed only to
				// derive `required` and never emitted, so a nullable property was advertised as
				// non-nullable while a nested one (via the shared emitter) was not (#1942).
				if (props[name] && typeof props[name] === 'object' && !('$ref' in props[name])) {
					const prop = props[name] as {
						description?: string;
						enum?: unknown[];
						type?: unknown;
						format?: string;
						const?: unknown;
						nullable?: boolean;
					};
					if (description) prop.description = description;
					if (attr.enum && prop.enum === undefined) prop.enum = attr.enum;
					// An author-declared `format` outranks the Harper type name `Type()` stamps on.
					if (attr.format) prop.format = attr.format;
					// `const` is draft-06; this document declares 3.0.3 (the draft-04 subset), so emit the
					// equivalent single-value `enum`. Intersect when both are declared, so OpenAPI never
					// advertises a wider value set than MCP from the same declaration.
					if (attr.const !== undefined) {
						prop.enum = Array.isArray(prop.enum) ? prop.enum.filter((value) => value === attr.const) : [attr.const];
					}
					// Only a typed schema can be nullable — a bare `{ nullable: true }` says nothing in 3.0,
					// matching the guard the shared emitter applies.
					if (nullable && prop.nullable === undefined && prop.type !== undefined) prop.nullable = true;
					// 3.0's `nullable` does not widen an `enum`; without `null` in the list a validator
					// rejects it regardless of the flag.
					if (prop.nullable && Array.isArray(prop.enum) && !prop.enum.includes(null)) {
						prop.enum = [...prop.enum, null];
					}
				}
				queryParamsArray.push(new Parameter(name, 'query', props[name]));
			}
		}

		const propsArray = Object.keys(props);
		const primaryKeyParam = new Parameter(primaryKey, 'path', { type: 'string', format: 'ID' });
		primaryKeyParam.required = true;
		primaryKeyParam.description = 'primary key of record';
		const propertyParamPath = new Parameter('property', 'path', { enum: propsArray });
		propertyParamPath.required = true;
		api.components.schemas[strippedPath] = new ResourceSchema(props, !sealed, resourceRequired, tableDoc);

		const hasPost = prototype.post !== Resource.prototype.post || prototype.update;
		const hasPut = typeof prototype.put === 'function';
		const hasGet = typeof prototype.get === 'function';
		const hasDelete = typeof prototype.delete === 'function';
		const hasPatch = typeof prototype.patch === 'function';

		// Prepend the class-level docstring to each verb's path-level description when present.
		// Otherwise the existing hardcoded sentence stands alone.
		const withDoc = (sentence: string) => (tableDoc ? `${tableDoc} ${sentence}` : sentence);

		const url = `/${path}/`;
		if (!api.paths[url]) {
			api.paths[url] = {};
		}

		// API for path structure /my-resource/
		if (hasPost) {
			api.paths[url].post = new Post(
				strippedPath,
				security,
				{
					'200': new Response200(
						{ $ref: SCHEMA_COMP_REF + strippedPath },
						{
							Location: {
								description: 'primary key of new record',
								schema: {
									type: 'string',
									format: 'ID',
								},
							},
						}
					),
				},
				withDoc('create a new record auto-assigning a primary key')
			);
		}

		api.paths[url].options = new Options(
			queryParamsArray,
			security,
			{ '200': new ResponseOptions200() },
			'retrieve information about the communication options available for a target resource or the server as a whole, without performing any resource action'
		);

		if (hasGet) {
			api.paths[url].get = new Get(
				queryParamsArray,
				security,
				{ '200': new Response200({ type: 'array', items: { $ref: SCHEMA_COMP_REF + strippedPath } }) },
				withDoc('search for records by the specified property name and value pairs')
			);
		}

		if (hasDelete) {
			api.paths[url].delete = new Delete(
				queryParamsArray,
				security,
				withDoc('delete all the records that match the provided query'),
				{
					'204': new Response204(),
				}
			);
		}

		// API for path structure /my-resource/<record-id>
		const urlById = '/' + path + '/{' + primaryKey + '}';
		if (!api.paths[urlById]) {
			api.paths[urlById] = {};
		}

		api.paths[urlById].options = new Options(
			queryParamsArray,
			security,
			{ '200': new ResponseOptions200() },
			'retrieve information about the communication options available for a target resource or the server as a whole, without performing any resource action'
		);

		if (hasGet) {
			api.paths[urlById].get = new Get(
				[primaryKeyParam],
				security,
				{ '200': new Response200({ $ref: SCHEMA_COMP_REF + strippedPath }) },
				withDoc('retrieve a record by its primary key')
			);
		}

		if (hasPut) {
			api.paths[urlById].put = new Put(
				[primaryKeyParam],
				security,
				strippedPath,
				{ '200': new Response200({ $ref: SCHEMA_COMP_REF + strippedPath }) },
				withDoc("create or update the record with the URL path that maps to the record's primary key")
			);
		}

		if (hasPatch) {
			api.paths[urlById].patch = new Patch(
				[primaryKeyParam],
				security,
				strippedPath,
				{ '200': new Response200({ $ref: SCHEMA_COMP_REF + strippedPath }) },
				withDoc("patch the record with the URL path that maps to the record's primary key")
			);
		}

		if (hasDelete) {
			api.paths[urlById].delete = new Delete(
				[primaryKeyParam],
				security,
				withDoc('delete a record with the given primary key'),
				{
					'204': new Response204(),
				}
			);
		}

		// API for path structure /my-resource/<record-id>.property
		if (hasGet && propertyParamPath.schema.enum.length > 0) {
			const urlByProperty = `/${path}/{${primaryKey}}.{property}`;
			if (!api.paths[urlByProperty]) {
				api.paths[urlByProperty] = {};
			}
			api.paths[urlByProperty].get = new Get(
				[primaryKeyParam, propertyParamPath],
				security,
				{
					'200': new Response200({ enum: propsArray }),
				},

				withDoc('used to retrieve the specified property of the specified record')
			);
		}
	}

	// Emit OpenAPI paths for a request-contract resource (`defineResource`/`Resource.withSchema`), whether
	// declared at a static path (`/OrderIntake`) or a parameterised one (`/widget/:id`) — each verb's
	// query/body/response is driven off the shared `inputSchemas`/`outputSchemas` the contract compiled,
	// the same `JsonSchemaFragment` IR that drives runtime validation/coercion, so the spec matches what
	// the server actually enforces (rather than the table-CRUD generation above).
	const emitContractRoutes = (url: string, entry: { Resource: any }, pathParams: any[]) => {
		if (!entry?.Resource) return;
		const { prototype } = entry.Resource;
		if (!prototype) return;

		const tableDoc: string | undefined = entry.Resource.description;
		const withDoc = (sentence: string) => (tableDoc ? `${tableDoc} ${sentence}` : sentence);
		const genericResponseSchema = { type: 'object' };
		// custom (non-table) resources have no generated schema component, so request bodies default to
		// loosely typed — UNLESS a request contract declares the query/body/response,
		// in which case each verb is driven off the shared JsonSchemaFragment below.
		const genericRequestBody = { content: { 'application/json': { schema: { type: 'object' } } } };
		const inputSchemas = entry.Resource.inputSchemas ?? {};
		const outputSchemas = entry.Resource.outputSchemas ?? {};
		// query params declared on the verb's contract, appended to the path params
		const paramsFor = (verb: string) => [...pathParams, ...queryParametersFromFragment(inputSchemas[verb]?.query)];
		const bodyFor = (verb: string) =>
			inputSchemas[verb]?.body
				? { content: { 'application/json': { schema: fragmentToOpenApiSchema(inputSchemas[verb].body) } } }
				: genericRequestBody;
		const responseFor = (verb: string) =>
			outputSchemas[verb] ? fragmentToOpenApiSchema(outputSchemas[verb]) : genericResponseSchema;

		const hasPost = prototype.post !== Resource.prototype.post || prototype.update;
		const hasPut = typeof prototype.put === 'function';
		const hasGet = typeof prototype.get === 'function';
		const hasDelete = typeof prototype.delete === 'function';
		const hasPatch = typeof prototype.patch === 'function';

		if (!api.paths[url]) api.paths[url] = {};
		api.paths[url].options = new Options(
			pathParams,
			security,
			{ '200': new ResponseOptions200() },
			'retrieve information about the communication options available for a target resource or the server as a whole, without performing any resource action'
		);
		if (hasGet) {
			api.paths[url].get = new Get(
				paramsFor('get'),
				security,
				{ '200': new Response200(responseFor('get')) },
				withDoc('handle a GET request for this route')
			);
		}
		if (hasPost) {
			api.paths[url].post = {
				description: withDoc('handle a POST request for this route'),
				parameters: paramsFor('post'),
				security,
				requestBody: bodyFor('post'),
				responses: { '200': new Response200(responseFor('post')) },
			};
		}
		if (hasPut) {
			api.paths[url].put = {
				description: withDoc('handle a PUT request for this route'),
				parameters: paramsFor('put'),
				security,
				requestBody: bodyFor('put'),
				responses: { '200': new Response200(responseFor('put')) },
			};
		}
		if (hasPatch) {
			api.paths[url].patch = {
				description: withDoc('handle a PATCH request for this route'),
				parameters: paramsFor('patch'),
				security,
				requestBody: bodyFor('patch'),
				responses: { '200': new Response200(responseFor('patch')) },
			};
		}
		if (hasDelete) {
			api.paths[url].delete = new Delete(
				paramsFor('delete'),
				security,
				withDoc('handle a DELETE request for this route'),
				{
					'204': new Response204(),
				}
			);
		}
	};

	// Request-contract resources declared at a static (non-parameterised) path (e.g. `defineResource({path:
	// '/OrderIntake', ...})`) — skipped by the table-CRUD loop above, emitted here off the declared contract.
	for (const [, entry] of resources) {
		if (!entry) continue;
		if (!entry.path || !entry.Resource?.requestContract || entry.Resource.isError || entry.Resource.hidden === true)
			continue;
		const path = entry.path.startsWith('/') ? entry.path : '/' + entry.path;
		emitContractRoutes(path, entry, []);
	}

	// Parameterised routes (e.g. `/widget/:id/action/:action`) live outside the resource Map; emit them as templated
	// paths with `{param}` path parameters so they appear in the OpenAPI document like any other endpoint.
	for (const route of resources.paramRoutes ?? []) {
		const entry = route.entry;
		if (!entry?.path || entry.Resource?.isError) continue;
		// @hidden: drop the Resource from the OpenAPI document entirely.
		if (entry.Resource?.hidden === true) continue;

		const { template, params } = routePatternToTemplate(route.segments);
		const url = `/${template}`;
		const pathParams = params.map((param) => {
			const parameter = new Parameter(param.name, 'path', { type: 'string' });
			parameter.required = true;
			parameter.description = param.wildcard
				? 'captures the remaining path segments'
				: `value bound from the :${param.name} path segment`;
			return parameter;
		});

		emitContractRoutes(url, entry, pathParams);
	}

	for (const [, value] of resources.allTypes) {
		includeDefinitionInSchema(value);
		if (value.sealed && api.components.schemas[value.type].additionalProperties) {
			api.components.schemas[value.type].additionalProperties = false;
		}
	}

	return api;
}

function Post(path, security, responses, description) {
	this.description = description;
	this.requestBody = {
		content: {
			'application/json': {
				schema: {
					$ref: SCHEMA_COMP_REF + path,
				},
			},
		},
	};

	this.security = security;
	this.responses = responses;
}

function Get(parameters, security, responses, description) {
	this.description = description;
	this.parameters = parameters;
	this.security = security;
	this.responses = responses;
}

function Options(parameters, security, responses, description) {
	this.description = description;
	this.parameters = parameters;
	this.security = security;
	this.responses = responses;
}

function ResponseOptions200() {
	this.description = DESCRIPTION_200;
	this.headers = {};
	this.content = {};
}

function Response200(schema, headers?: any) {
	this.description = DESCRIPTION_200;
	this.content = {
		'application/json': {
			schema,
		},
	};
	this.headers = headers;
}

function Response204() {
	this.description = 'successfully processed request, no content returned to client';
}

function Put(parameters, security, path, responses, description) {
	this.description = description;
	this.parameters = parameters;
	this.security = security;
	this.requestBody = {
		content: {
			'application/json': {
				schema: {
					$ref: SCHEMA_COMP_REF + path,
				},
			},
		},
	};
	this.responses = responses;
}

function Patch(parameters, security, path, responses, description) {
	this.description = description;
	this.parameters = parameters;
	this.security = security;
	this.requestBody = {
		content: {
			'application/json': {
				schema: {
					$ref: SCHEMA_COMP_REF + path,
				},
			},
		},
	};
	this.responses = responses;
}

function Delete(parameters, security, description, responses) {
	this.description = description;
	this.parameters = parameters;
	this.security = security;
	this.responses = responses;
}

function ResourceSchema(properties, additionalProperties?: boolean, required?: string[], description?: string) {
	this.type = 'object';
	this.properties = properties;
	this.additionalProperties = additionalProperties;
	// Omit an empty list rather than emitting `required: []`. JSON Schema draft-04, which OpenAPI
	// 3.0.3 inherits, requires at least one element, so `[]` fails strict validators — and a schema
	// whose attributes are all nullable produces exactly that.
	if (required?.length) this.required = required;
	if (description) this.description = description;
}

function Type(type, format?) {
	this.type = type;
	if (type === 'string' || type === 'number' || type === 'integer') {
		if (format !== undefined && format !== 'String') {
			this.format = format;
		}
	}
}

function Ref(ref: string) {
	this.$ref = `#/components/schemas/${ref}`;
}

function ArrayRef(ref: string) {
	this.type = 'array';
	this.items = new Ref(ref);
}

function Parameter(name, i, type) {
	this.name = name;
	this.in = i;
	this.schema = type;
}

/**
 * Project a shared `JsonSchemaFragment` (from a request contract's inputSchemas/outputSchemas) into an
 * OpenAPI schema object. The fragment vocabulary already mirrors JSON Schema, so this mostly copies the
 * standard keys recursively and drops Harper-only metadata (primaryKey, assignCreatedTime, hidden).
 */
function fragmentToOpenApiSchema(fragment: any): any {
	if (!fragment || typeof fragment !== 'object') return { type: 'object' };
	const schema: any = {};
	if (fragment.type != null) schema.type = fragment.type;
	if (fragment.format) schema.format = fragment.format;
	if (fragment.description) schema.description = fragment.description;
	if (fragment.enum) schema.enum = fragment.enum;
	if (fragment.nullable) schema.nullable = true;
	if (fragment.const !== undefined) schema.const = fragment.const;
	if (fragment.items) schema.items = fragmentToOpenApiSchema(fragment.items);
	if (fragment.properties) {
		schema.properties = {};
		for (const [key, sub] of Object.entries(fragment.properties)) schema.properties[key] = fragmentToOpenApiSchema(sub);
		if (fragment.required) schema.required = fragment.required;
		if (fragment.additionalProperties !== undefined) schema.additionalProperties = fragment.additionalProperties;
	}
	return schema;
}

/** Build OpenAPI query `Parameter`s from a contract verb's query fragment (`{ type:'object', properties }`). */
function queryParametersFromFragment(queryFragment: any): any[] {
	if (!queryFragment?.properties) return [];
	const required = new Set(queryFragment.required ?? []);
	return Object.entries(queryFragment.properties).map(([name, sub]) => {
		const parameter = new Parameter(name, 'query', fragmentToOpenApiSchema(sub));
		if (required.has(name)) parameter.required = true;
		return parameter;
	});
}
