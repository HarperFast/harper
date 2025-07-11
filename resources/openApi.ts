import { packageJson } from '../utility/packageUtils.js';

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
			version: packageJson.version,
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
		const strippedPath = path.split('/').slice(-1); // strip any namespace from path
		let { attributes, primaryKey, prototype } = resource.Resource;
		primaryKey = primaryKey ?? 'id';
		if (!primaryKey) continue;
		const props = {};
		const queryParamsArray = [];
		if (attributes) {
			for (const { type, name, elements, relationship, definition } of attributes) {
				const def = definition ?? elements?.definition;
				if (def) {
					if (!api.components.schemas[def.type]) {
						const defProps = {};
						def.properties.forEach((prop) => {
							defProps[prop.name] = new Type(DATA_TYPES[prop.type], prop.type);
						});
						api.components.schemas[def.type] = new ResourceSchema(defProps);
					}
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
				queryParamsArray.push(new Parameter(name, 'query', props[name]));
			}
		}

		const propsArray = Object.keys(props);
		const primaryKeyParam = new Parameter(primaryKey, 'path', { format: 'ID' });
		primaryKeyParam.required = true;
		primaryKeyParam.description = 'primary key of record';
		const propertyParamPath = new Parameter('property', 'path', { enum: propsArray });
		propertyParamPath.required = true;
		api.components.schemas[strippedPath] = new ResourceSchema(props);

		const hasPost = prototype.post !== Resource.prototype.post || prototype.update;
		const hasPut = typeof prototype.put === 'function';
		const hasGet = typeof prototype.get === 'function';
		const hasDelete = typeof prototype.delete === 'function';
		const hasPatch = typeof prototype.patch === 'function';

		// API for path structure /my-resource/
		let url = '/' + path + '/';
		if (hasPost) {
			api.paths[url] = {};
			api.paths[url].post = new Post(strippedPath, security, 'create a new record auto-assigning a primary key');
		}

		if (hasGet) {
			if (!api.paths[url]) api.paths[url] = {};
			api.paths[url].get = new Get(
				queryParamsArray,
				security,
				{ '200': new Response200({ $ref: SCHEMA_COMP_REF + strippedPath }) },
				'search for records by the specified property name and value pairs'
			);
		}

		if (!api.paths[url]) api.paths[url] = {};
		api.paths[url].options = new Options(
			queryParamsArray,
			security,
			{ '200': new ResponseOptions200() },
			'retrieve information about the communication options available for a target resource or the server as a whole, without performing any resource action'
		);

		if (hasDelete) {
			if (!api.paths[url]) api.paths[url] = {};
			api.paths[url].delete = new Delete(
				queryParamsArray,
				security,
				'delete all the records that match the provided query',
				{
					'204': new Response204(),
				}
			);
		}

		// API for path structure /my-resource/<record-id>
		url = '/' + path + '/{' + primaryKey + '}';
		if (hasGet) {
			api.paths[url] = {};
			api.paths[url].get = new Get(
				[primaryKeyParam],
				security,
				{ '200': new Response200({ $ref: SCHEMA_COMP_REF + strippedPath }) },
				'retrieve a record by its primary key'
			);
		}

		if (hasPut) {
			if (!api.paths[url]) api.paths[url] = {};
			api.paths[url].put = new Put(
				[primaryKeyParam],
				security,
				strippedPath,
				"create or update the record with the URL path that maps to the record's primary key"
			);
		}

		if (hasPatch) {
			if (!api.paths[url]) api.paths[url] = {};
			api.paths[url].patch = new Patch(
				[primaryKeyParam],
				security,
				strippedPath,
				"patch the record with the URL path that maps to the record's primary key"
			);
		}

		if (hasDelete) {
			if (!api.paths[url]) api.paths[url] = {};
			api.paths[url].delete = new Delete([primaryKeyParam], security, 'delete a record with the given primary key', {
				'204': new Response204(),
			});
		}

		// API for path structure /my-resource/<record-id>.property
		if (hasGet && propertyParamPath.schema.enum.length > 0) {
			url = '/' + path + '/{' + primaryKey + '}.{property}';
			api.paths[url] = {};
			api.paths[url].get = new Get(
				[primaryKeyParam, propertyParamPath],
				security,
				{
					'200': new Response200({ enum: propsArray }),
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

function Response200(schema) {
	this.description = DESCRIPTION_200;
	this.content = {
		'application/json': {
			schema,
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

function Patch(parameters, security, path, description) {
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
