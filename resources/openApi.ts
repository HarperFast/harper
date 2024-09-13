import { version } from '../bin/version';

const OPENAPI_VERSION = '3.0.3';
// Maps graphql primitive types to open api types
const DATA_TYPES = {
	Int: 'integer',
	Float: 'number',
	Long: 'integer',
	String: 'string',
	Boolean: 'boolean',
	Date: 'string',
	Bytes: 'string',
	BigInt: 'integer',
	array: 'array',
};

const SCHEMA_COMP_REF = '#/components/schemas/';
const DESCRIPTION_200 = 'successful operation';

export function generateJsonApi(resources) {
	const api = {
		openapi: OPENAPI_VERSION,
		info: {
			title: 'HarperDB HTTP REST interface',
			version: version(),
		},
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

	for (const [, resource] of resources) {
		// skip invalid and error resources
		if (!resource.path || resource.Resource.isError) continue;

		const { path } = resource;
		const stripped_path = path.split('/').slice(-1); // strip any namespace from path
		let { attributes, primaryKey, prototype } = resource.Resource;
		primaryKey = primaryKey ?? 'id';
		if (!primaryKey) continue;
		const props = {};
		const query_params_array = [];
		if (attributes) {
			for (const { type, name, elements, relationship, definition } of attributes) {
				if (relationship) {
					if (type === 'array') {
						props[name] = { type: 'array', items: { $ref: SCHEMA_COMP_REF + elements.type } };
					} else {
						props[name] = { $ref: SCHEMA_COMP_REF + type };
					}
				} else {
					const def = definition ?? elements?.definition;
					if (def) {
						if (!api.components.schemas[def.type]) {
							const def_props = {};
							def.properties.forEach((prop) => {
								def_props[prop.name] = new Type(DATA_TYPES[prop.type], prop.type);
							});

							api.components.schemas[def.type] = new ResourceSchema(def_props);
						}

						if (type === 'array') {
							props[name] = { type: 'array', items: { $ref: SCHEMA_COMP_REF + def.type } };
						} else {
							props[name] = { $ref: SCHEMA_COMP_REF + def.type };
						}
					} else if (type === 'array') {
						if (elements.type === 'Any' || elements.type == 'ID') {
							props[name] = { type: 'array', items: { format: elements.type } };
						} else {
							props[name] = { type: 'array', items: new Type(DATA_TYPES[elements.type], elements.type) };
						}
					} else if (type === 'Any' || type == 'ID') {
						props[name] = { format: type };
					} else {
						props[name] = new Type(DATA_TYPES[type], type);
					}
				}
				query_params_array.push(new Parameter(name, 'query', props[name]));
			}
		}

		const props_array = Object.keys(props);
		const primary_key_param = new Parameter(primaryKey, 'path', { format: 'ID' });
		primary_key_param.required = true;
		primary_key_param.description = 'primary key of record';
		const property_param_path = new Parameter('property', 'path', { enum: props_array });
		property_param_path.required = true;
		api.components.schemas[stripped_path] = new ResourceSchema(props);

		const has_post = prototype.post !== Resource.prototype.post || prototype.update;
		const has_put = typeof prototype.put === 'function';
		const has_get = typeof prototype.get === 'function';
		const has_delete = typeof prototype.delete === 'function';

		// API for path structure /my-resource/
		let url = '/' + path + '/';
		if (has_post) {
			api.paths[url] = {};
			api.paths[url].post = new Post(stripped_path, security, 'create a new record auto-assigning a primary key');
		}

		if (has_get) {
			if (!api.paths[url]) api.paths[url] = {};
			api.paths[url].get = new Get(
				query_params_array,
				security,
				{ '200': new Response200({ $ref: SCHEMA_COMP_REF + stripped_path }) },
				'search for records by the specified property name and value pairs'
			);
		}

		if (has_delete) {
			if (!api.paths[url]) api.paths[url] = {};
			api.paths[url].delete = new Delete(
				query_params_array,
				security,
				'delete all the records that match the provided query',
				{
					'204': new Response204(),
				}
			);
		}

		// API for path structure /my-resource/<record-id>
		url = '/' + path + '/{' + primaryKey + '}';
		if (has_get) {
			api.paths[url] = {};
			api.paths[url].get = new Get(
				[primary_key_param],
				security,
				{ '200': new Response200({ $ref: SCHEMA_COMP_REF + stripped_path }) },
				'retrieve a record by its primary key'
			);
		}

		if (has_put) {
			if (!api.paths[url]) api.paths[url] = {};
			api.paths[url].put = new Put(
				[primary_key_param],
				security,
				stripped_path,
				"create or update the record with the URL path that maps to the record's primary key"
			);
		}

		if (has_delete) {
			if (!api.paths[url]) api.paths[url] = {};
			api.paths[url].delete = new Delete([primary_key_param], security, 'delete a record with the given primary key', {
				'204': new Response204(),
			});
		}

		// API for path structure /my-resource/<record-id>.property
		if (has_get && property_param_path.schema.enum.length > 0) {
			url = '/' + path + '/{' + primaryKey + '}.{property}';
			api.paths[url] = {};
			api.paths[url].get = new Get(
				[primary_key_param, property_param_path],
				security,
				{
					'200': new Response200({ enum: props_array }),
				},

				'used to retrieve the specified property of the specified record'
			);
		}
	}

	return api;
}

function Post(path, security, description) {
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
	this.responses = {
		'200': {
			description: DESCRIPTION_200,
			headers: {
				Location: {
					description: 'primary key of new record',
					schema: {
						type: 'string',
						format: 'ID',
					},
				},
			},
			content: {
				'application/json': {
					schema: {
						type: 'string',
						format: 'ID',
					},
				},
			},
		},
	};
}

function Get(parameters, security, responses, description) {
	this.description = description;
	this.parameters = parameters;
	this.security = security;
	this.responses = responses;
}

function Response200(schema) {
	this.description = DESCRIPTION_200;
	this.content = {
		'application/json': {
			schema: schema,
		},
	};
}

function Response204() {
	this.description = 'successfully processed request, no content returned to client';
}

function Put(parameters, security, path, description) {
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
	this.responses = {
		'200': {
			description: DESCRIPTION_200,
		},
	};
}
function Delete(parameters, security, description, responses) {
	this.description = description;
	this.parameters = parameters;
	this.security = security;
	this.responses = responses;
}

function ResourceSchema(properties) {
	this.type = 'object';
	this.properties = properties;
}

function Type(type, format) {
	this.type = type;
	this.format = format;
}

function Parameter(name, i, type) {
	this.name = name;
	this.in = i;
	this.schema = type;
}
