import { version } from '../bin/version';

const OPENAPI_VERSION = '3.0.3';
// Maps graphql primitive types to open api types
const DATA_TYPES = {
	ID: 'string',
	Int: 'integer',
	Float: 'number',
	Long: 'integer',
	String: 'string',
	Boolean: 'boolean',
	Date: 'string',
	Bytes: 'string',
	Any: 'string',
	BigInt: 'integer',
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
		if (!resource.path) continue;

		const { path } = resource;
		let { attributes, primaryKey, prototype } = resource.Resource;
		primaryKey = primaryKey ?? 'id';
		if (!primaryKey) continue;
		const props = {};
		const query_params_array = [];
		if (attributes) {
			for (const { type, name } of attributes) {
				props[name] = new Type(DATA_TYPES[type], type);
				query_params_array.push(new Parameter(name, 'query', props[name]));
			}
		}

		const props_array = Object.keys(props);
		const primary_key_param = new Parameter(primaryKey, 'path', new Type(DATA_TYPES.ID, 'ID'));
		primary_key_param.required = true;
		primary_key_param.description = 'primary key of record';
		const property_param_path = new Parameter('property', 'path', { enum: props_array });
		property_param_path.required = true;
		api.components.schemas[path] = new ResourceSchema(props);

		const has_post = prototype.post !== Resource.prototype.post || prototype.update;
		const has_put = prototype.hasOwnProperty('put');
		const has_get = prototype.hasOwnProperty('get');
		const has_delete = prototype.hasOwnProperty('delete');

		// API for path structure /my-resource/
		let url = '/' + path + '/';
		if (has_post) {
			api.paths[url] = {};
			api.paths[url].post = new Post(path, security, 'create a new record auto-assigning a primary key');
		}

		if (has_get) {
			if (!api.paths[url]) api.paths[url] = {};
			api.paths[url].get = new Get(
				query_params_array,
				security,
				{ '200': new Response200({ $ref: SCHEMA_COMP_REF + path }) },
				'search for records by the specified property name and value'
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
				{ '200': new Response200({ $ref: SCHEMA_COMP_REF + path }) },
				'retrieve a record by its primary key'
			);
		}

		if (has_put) {
			if (!api.paths[url]) api.paths[url] = {};
			api.paths[url].put = new Put(
				[primary_key_param],
				security,
				path,
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
