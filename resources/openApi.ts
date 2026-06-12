import { packageJson } from '../utility/packageUtils.js';
import { Resources } from './Resources.ts';
import { Resource } from './Resource.ts';
import { DATA_TYPES } from './jsonSchemaTypes.ts';

const OPENAPI_VERSION = '3.0.3';

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

		const { path } = resource;
		const strippedPath = path.split('/').pop(); // strip any namespace from path
		let { attributes, sealed } = resource.Resource;
		const { prototype, primaryKey = 'id' } = resource.Resource;
		// Class-level description from @table docstring or programmatic `static description`.
		// Used as both the schema-level `description` (in components.schemas) and as a prefix
		// on each path-level operation description.
		const tableDoc: string | undefined = resource.Resource.description;
		if (!attributes && resources.allTypes.has(resource.path)) {
			const possibleType = resources.allTypes.get(resource.path);
			sealed = possibleType.sealed;
			attributes = possibleType.attributes ?? possibleType.properties;
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
					} else if (type === 'array') {
						if (elements.type === 'Any') {
							props[name] = { type: 'array', items: { format: elements.type } };
						} else {
							props[name] = { type: 'array', items: new Type(DATA_TYPES[elements.type], elements.type) };
						}
					} else if (type === 'Any') {
						props[name] = { format: type };
					} else {
						props[name] = new Type(DATA_TYPES[type], type);
					}
				}
				// Attach per-property description so it surfaces in Swagger UI / Redoc.
				if (description && props[name] && typeof props[name] === 'object' && !('$ref' in props[name])) {
					(props[name] as { description?: string }).description = description;
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
	this.required = required;
	if (description) this.description = description;
}

function Type(type, format) {
	this.type = type;
	if (type === 'string' || type === 'number' || type === 'integer') {
		if (format !== 'String') {
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
