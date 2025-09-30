const { expect } = require('chai');
require('../test_utils');
const { packageJson } = require('../../utility/packageUtils');
const { generateJsonApi } = require('../../resources/openApi');

describe('test openApi module', () => {
	let resources;

	before(async function () {
		/*this.timeout(10000); // this seems to be causing a syntax error?
		const { setupTestApp } = await import('../apiTests/setupTestApp.mjs');
		await setupTestApp();
		({ resources } = require('../../resources/Resources'));*/
	});

	// TODO: this tests a zillion things that are irrelevant to the actual test, needs to be fixed to
	// actually test the openApi module and not the shape of every single resource in unit tests and producing false
	// positives
	it.skip('Test API spec is returned', () => {
		const result = generateJsonApi(resources);
		expect(result).to.eql({
			openapi: '3.0.3',
			info: { title: 'HarperDB HTTP REST interface', version: packageJson.version },
			paths: {
				'/VariedProps/': {
					post: {
						description: 'create a new record auto-assigning a primary key',
						requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/VariedProps' } } } },
						security: [{ basicAuth: [], bearerAuth: [] }],
						responses: {
							200: {
								description: 'successful operation',
								headers: {
									Location: { description: 'primary key of new record', schema: { type: 'string', format: 'ID' } },
								},
								content: { 'application/json': { schema: { type: 'string', format: 'ID' } } },
							},
						},
					},
					get: {
						description: 'search for records by the specified property name and value pairs',
						parameters: [
							{ name: 'id', in: 'query', schema: { format: 'ID' } },
							{ name: 'name', in: 'query', schema: { type: 'string', format: 'String' } },
						],
						security: [{ basicAuth: [], bearerAuth: [] }],
						responses: {
							200: {
								description: 'successful operation',
								content: { 'application/json': { schema: { $ref: '#/components/schemas/VariedProps' } } },
							},
						},
					},
					delete: {
						description: 'delete all the records that match the provided query',
						parameters: [
							{ name: 'id', in: 'query', schema: { format: 'ID' } },
							{ name: 'name', in: 'query', schema: { type: 'string', format: 'String' } },
						],
						security: [{ basicAuth: [], bearerAuth: [] }],
						responses: { 204: { description: 'successfully processed request, no content returned to client' } },
					},
				},
				'/VariedProps/{id}': {
					get: {
						description: 'retrieve a record by its primary key',
						parameters: [
							{
								name: 'id',
								in: 'path',
								schema: { format: 'ID' },
								required: true,
								description: 'primary key of record',
							},
						],
						security: [{ basicAuth: [], bearerAuth: [] }],
						responses: {
							200: {
								description: 'successful operation',
								content: { 'application/json': { schema: { $ref: '#/components/schemas/VariedProps' } } },
							},
						},
					},
					put: {
						description: "create or update the record with the URL path that maps to the record's primary key",
						parameters: [
							{
								name: 'id',
								in: 'path',
								schema: { format: 'ID' },
								required: true,
								description: 'primary key of record',
							},
						],
						security: [{ basicAuth: [], bearerAuth: [] }],
						requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/VariedProps' } } } },
						responses: { 200: { description: 'successful operation' } },
					},
					delete: {
						description: 'delete a record with the given primary key',
						parameters: [
							{
								name: 'id',
								in: 'path',
								schema: { format: 'ID' },
								required: true,
								description: 'primary key of record',
							},
						],
						security: [{ basicAuth: [], bearerAuth: [] }],
						responses: { 204: { description: 'successfully processed request, no content returned to client' } },
					},
				},
				'/VariedProps/{id}.{property}': {
					get: {
						description: 'used to retrieve the specified property of the specified record',
						parameters: [
							{
								name: 'id',
								in: 'path',
								schema: { format: 'ID' },
								required: true,
								description: 'primary key of record',
							},
							{ name: 'property', in: 'path', schema: { enum: ['id', 'name'] }, required: true },
						],
						security: [{ basicAuth: [], bearerAuth: [] }],
						responses: {
							200: {
								description: 'successful operation',
								content: { 'application/json': { schema: { enum: ['id', 'name'] } } },
							},
						},
					},
				},
				'/SimpleRecord/': {
					post: {
						description: 'create a new record auto-assigning a primary key',
						requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/SimpleRecord' } } } },
						security: [{ basicAuth: [], bearerAuth: [] }],
						responses: {
							200: {
								description: 'successful operation',
								headers: {
									Location: { description: 'primary key of new record', schema: { type: 'string', format: 'ID' } },
								},
								content: { 'application/json': { schema: { type: 'string', format: 'ID' } } },
							},
						},
					},
					get: {
						description: 'search for records by the specified property name and value pairs',
						parameters: [
							{ name: 'id', in: 'query', schema: { format: 'ID' } },
							{ name: 'name', in: 'query', schema: { type: 'string', format: 'String' } },
						],
						security: [{ basicAuth: [], bearerAuth: [] }],
						responses: {
							200: {
								description: 'successful operation',
								content: { 'application/json': { schema: { $ref: '#/components/schemas/SimpleRecord' } } },
							},
						},
					},
					delete: {
						description: 'delete all the records that match the provided query',
						parameters: [
							{ name: 'id', in: 'query', schema: { format: 'ID' } },
							{ name: 'name', in: 'query', schema: { type: 'string', format: 'String' } },
						],
						security: [{ basicAuth: [], bearerAuth: [] }],
						responses: { 204: { description: 'successfully processed request, no content returned to client' } },
					},
				},
				'/SimpleRecord/{id}': {
					get: {
						description: 'retrieve a record by its primary key',
						parameters: [
							{
								name: 'id',
								in: 'path',
								schema: { format: 'ID' },
								required: true,
								description: 'primary key of record',
							},
						],
						security: [{ basicAuth: [], bearerAuth: [] }],
						responses: {
							200: {
								description: 'successful operation',
								content: { 'application/json': { schema: { $ref: '#/components/schemas/SimpleRecord' } } },
							},
						},
					},
					put: {
						description: "create or update the record with the URL path that maps to the record's primary key",
						parameters: [
							{
								name: 'id',
								in: 'path',
								schema: { format: 'ID' },
								required: true,
								description: 'primary key of record',
							},
						],
						security: [{ basicAuth: [], bearerAuth: [] }],
						requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/SimpleRecord' } } } },
						responses: { 200: { description: 'successful operation' } },
					},
					delete: {
						description: 'delete a record with the given primary key',
						parameters: [
							{
								name: 'id',
								in: 'path',
								schema: { format: 'ID' },
								required: true,
								description: 'primary key of record',
							},
						],
						security: [{ basicAuth: [], bearerAuth: [] }],
						responses: { 204: { description: 'successfully processed request, no content returned to client' } },
					},
				},
				'/SimpleRecord/{id}.{property}': {
					get: {
						description: 'used to retrieve the specified property of the specified record',
						parameters: [
							{
								name: 'id',
								in: 'path',
								schema: { format: 'ID' },
								required: true,
								description: 'primary key of record',
							},
							{ name: 'property', in: 'path', schema: { enum: ['id', 'name'] }, required: true },
						],
						security: [{ basicAuth: [], bearerAuth: [] }],
						responses: {
							200: {
								description: 'successful operation',
								content: { 'application/json': { schema: { enum: ['id', 'name'] } } },
							},
						},
					},
				},
				'/FourProp/': {
					post: {
						description: 'create a new record auto-assigning a primary key',
						requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/FourProp' } } } },
						security: [{ basicAuth: [], bearerAuth: [] }],
						responses: {
							200: {
								description: 'successful operation',
								headers: {
									Location: { description: 'primary key of new record', schema: { type: 'string', format: 'ID' } },
								},
								content: { 'application/json': { schema: { type: 'string', format: 'ID' } } },
							},
						},
					},
					get: {
						description: 'search for records by the specified property name and value pairs',
						parameters: [
							{ name: 'id', in: 'query', schema: { format: 'ID' } },
							{ name: 'name', in: 'query', schema: { type: 'string', format: 'String' } },
							{ name: 'age', in: 'query', schema: { type: 'integer', format: 'Int' } },
							{ name: 'title', in: 'query', schema: { type: 'string', format: 'String' } },
							{ name: 'birthday', in: 'query', schema: { type: 'string', format: 'Date' } },
							{ name: 'ageInMonths', in: 'query', schema: { type: 'integer', format: 'Int' } },
							{ name: 'nameTitle', in: 'query', schema: { type: 'integer', format: 'Int' } },
						],
						security: [{ basicAuth: [], bearerAuth: [] }],
						responses: {
							200: {
								description: 'successful operation',
								content: { 'application/json': { schema: { $ref: '#/components/schemas/FourProp' } } },
							},
						},
					},
					delete: {
						description: 'delete all the records that match the provided query',
						parameters: [
							{ name: 'id', in: 'query', schema: { format: 'ID' } },
							{ name: 'name', in: 'query', schema: { type: 'string', format: 'String' } },
							{ name: 'age', in: 'query', schema: { type: 'integer', format: 'Int' } },
							{ name: 'title', in: 'query', schema: { type: 'string', format: 'String' } },
							{ name: 'birthday', in: 'query', schema: { type: 'string', format: 'Date' } },
							{ name: 'ageInMonths', in: 'query', schema: { type: 'integer', format: 'Int' } },
							{ name: 'nameTitle', in: 'query', schema: { type: 'integer', format: 'Int' } },
						],
						security: [{ basicAuth: [], bearerAuth: [] }],
						responses: { 204: { description: 'successfully processed request, no content returned to client' } },
					},
				},
				'/FourProp/{id}': {
					get: {
						description: 'retrieve a record by its primary key',
						parameters: [
							{
								name: 'id',
								in: 'path',
								schema: { format: 'ID' },
								required: true,
								description: 'primary key of record',
							},
						],
						security: [{ basicAuth: [], bearerAuth: [] }],
						responses: {
							200: {
								description: 'successful operation',
								content: { 'application/json': { schema: { $ref: '#/components/schemas/FourProp' } } },
							},
						},
					},
					put: {
						description: "create or update the record with the URL path that maps to the record's primary key",
						parameters: [
							{
								name: 'id',
								in: 'path',
								schema: { format: 'ID' },
								required: true,
								description: 'primary key of record',
							},
						],
						security: [{ basicAuth: [], bearerAuth: [] }],
						requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/FourProp' } } } },
						responses: { 200: { description: 'successful operation' } },
					},
					delete: {
						description: 'delete a record with the given primary key',
						parameters: [
							{
								name: 'id',
								in: 'path',
								schema: { format: 'ID' },
								required: true,
								description: 'primary key of record',
							},
						],
						security: [{ basicAuth: [], bearerAuth: [] }],
						responses: { 204: { description: 'successfully processed request, no content returned to client' } },
					},
				},
				'/FourProp/{id}.{property}': {
					get: {
						description: 'used to retrieve the specified property of the specified record',
						parameters: [
							{
								name: 'id',
								in: 'path',
								schema: { format: 'ID' },
								required: true,
								description: 'primary key of record',
							},
							{
								name: 'property',
								in: 'path',
								schema: { enum: ['id', 'name', 'age', 'title', 'birthday', 'ageInMonths', 'nameTitle'] },
								required: true,
							},
						],
						security: [{ basicAuth: [], bearerAuth: [] }],
						responses: {
							200: {
								description: 'successful operation',
								content: {
									'application/json': {
										schema: { enum: ['id', 'name', 'age', 'title', 'birthday', 'ageInMonths', 'nameTitle'] },
									},
								},
							},
						},
					},
				},
				'/Related/': {
					post: {
						description: 'create a new record auto-assigning a primary key',
						requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Related' } } } },
						security: [{ basicAuth: [], bearerAuth: [] }],
						responses: {
							200: {
								description: 'successful operation',
								headers: {
									Location: { description: 'primary key of new record', schema: { type: 'string', format: 'ID' } },
								},
								content: { 'application/json': { schema: { type: 'string', format: 'ID' } } },
							},
						},
					},
					get: {
						description: 'search for records by the specified property name and value pairs',
						parameters: [
							{ name: 'id', in: 'query', schema: { format: 'ID' } },
							{ name: 'name', in: 'query', schema: { type: 'string', format: 'String' } },
							{
								name: 'otherTable',
								in: 'query',
								schema: { type: 'array', items: { $ref: '#/components/schemas/SubObject' } },
							},
						],
						security: [{ basicAuth: [], bearerAuth: [] }],
						responses: {
							200: {
								description: 'successful operation',
								content: { 'application/json': { schema: { $ref: '#/components/schemas/Related' } } },
							},
						},
					},
					delete: {
						description: 'delete all the records that match the provided query',
						parameters: [
							{ name: 'id', in: 'query', schema: { format: 'ID' } },
							{ name: 'name', in: 'query', schema: { type: 'string', format: 'String' } },
							{
								name: 'otherTable',
								in: 'query',
								schema: { type: 'array', items: { $ref: '#/components/schemas/SubObject' } },
							},
						],
						security: [{ basicAuth: [], bearerAuth: [] }],
						responses: { 204: { description: 'successfully processed request, no content returned to client' } },
					},
				},
				'/Related/{id}': {
					get: {
						description: 'retrieve a record by its primary key',
						parameters: [
							{
								name: 'id',
								in: 'path',
								schema: { format: 'ID' },
								required: true,
								description: 'primary key of record',
							},
						],
						security: [{ basicAuth: [], bearerAuth: [] }],
						responses: {
							200: {
								description: 'successful operation',
								content: { 'application/json': { schema: { $ref: '#/components/schemas/Related' } } },
							},
						},
					},
					put: {
						description: "create or update the record with the URL path that maps to the record's primary key",
						parameters: [
							{
								name: 'id',
								in: 'path',
								schema: { format: 'ID' },
								required: true,
								description: 'primary key of record',
							},
						],
						security: [{ basicAuth: [], bearerAuth: [] }],
						requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Related' } } } },
						responses: { 200: { description: 'successful operation' } },
					},
					delete: {
						description: 'delete a record with the given primary key',
						parameters: [
							{
								name: 'id',
								in: 'path',
								schema: { format: 'ID' },
								required: true,
								description: 'primary key of record',
							},
						],
						security: [{ basicAuth: [], bearerAuth: [] }],
						responses: { 204: { description: 'successfully processed request, no content returned to client' } },
					},
				},
				'/Related/{id}.{property}': {
					get: {
						description: 'used to retrieve the specified property of the specified record',
						parameters: [
							{
								name: 'id',
								in: 'path',
								schema: { format: 'ID' },
								required: true,
								description: 'primary key of record',
							},
							{ name: 'property', in: 'path', schema: { enum: ['id', 'name', 'otherTable'] }, required: true },
						],
						security: [{ basicAuth: [], bearerAuth: [] }],
						responses: {
							200: {
								description: 'successful operation',
								content: { 'application/json': { schema: { enum: ['id', 'name', 'otherTable'] } } },
							},
						},
					},
				},
				'/ManyToMany/': {
					post: {
						description: 'create a new record auto-assigning a primary key',
						requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/ManyToMany' } } } },
						security: [{ basicAuth: [], bearerAuth: [] }],
						responses: {
							200: {
								description: 'successful operation',
								headers: {
									Location: { description: 'primary key of new record', schema: { type: 'string', format: 'ID' } },
								},
								content: { 'application/json': { schema: { type: 'string', format: 'ID' } } },
							},
						},
					},
					get: {
						description: 'search for records by the specified property name and value pairs',
						parameters: [
							{ name: 'id', in: 'query', schema: { format: 'ID' } },
							{ name: 'name', in: 'query', schema: { type: 'string', format: 'String' } },
							{ name: 'subObjectIds', in: 'query', schema: { type: 'array', items: { format: 'ID' } } },
							{
								name: 'subObjects',
								in: 'query',
								schema: { type: 'array', items: { $ref: '#/components/schemas/SubObject' } },
							},
						],
						security: [{ basicAuth: [], bearerAuth: [] }],
						responses: {
							200: {
								description: 'successful operation',
								content: { 'application/json': { schema: { $ref: '#/components/schemas/ManyToMany' } } },
							},
						},
					},
					delete: {
						description: 'delete all the records that match the provided query',
						parameters: [
							{ name: 'id', in: 'query', schema: { format: 'ID' } },
							{ name: 'name', in: 'query', schema: { type: 'string', format: 'String' } },
							{ name: 'subObjectIds', in: 'query', schema: { type: 'array', items: { format: 'ID' } } },
							{
								name: 'subObjects',
								in: 'query',
								schema: { type: 'array', items: { $ref: '#/components/schemas/SubObject' } },
							},
						],
						security: [{ basicAuth: [], bearerAuth: [] }],
						responses: { 204: { description: 'successfully processed request, no content returned to client' } },
					},
				},
				'/ManyToMany/{id}': {
					get: {
						description: 'retrieve a record by its primary key',
						parameters: [
							{
								name: 'id',
								in: 'path',
								schema: { format: 'ID' },
								required: true,
								description: 'primary key of record',
							},
						],
						security: [{ basicAuth: [], bearerAuth: [] }],
						responses: {
							200: {
								description: 'successful operation',
								content: { 'application/json': { schema: { $ref: '#/components/schemas/ManyToMany' } } },
							},
						},
					},
					put: {
						description: "create or update the record with the URL path that maps to the record's primary key",
						parameters: [
							{
								name: 'id',
								in: 'path',
								schema: { format: 'ID' },
								required: true,
								description: 'primary key of record',
							},
						],
						security: [{ basicAuth: [], bearerAuth: [] }],
						requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/ManyToMany' } } } },
						responses: { 200: { description: 'successful operation' } },
					},
					delete: {
						description: 'delete a record with the given primary key',
						parameters: [
							{
								name: 'id',
								in: 'path',
								schema: { format: 'ID' },
								required: true,
								description: 'primary key of record',
							},
						],
						security: [{ basicAuth: [], bearerAuth: [] }],
						responses: { 204: { description: 'successfully processed request, no content returned to client' } },
					},
				},
				'/ManyToMany/{id}.{property}': {
					get: {
						description: 'used to retrieve the specified property of the specified record',
						parameters: [
							{
								name: 'id',
								in: 'path',
								schema: { format: 'ID' },
								required: true,
								description: 'primary key of record',
							},
							{
								name: 'property',
								in: 'path',
								schema: { enum: ['id', 'name', 'subObjectIds', 'subObjects'] },
								required: true,
							},
						],
						security: [{ basicAuth: [], bearerAuth: [] }],
						responses: {
							200: {
								description: 'successful operation',
								content: { 'application/json': { schema: { enum: ['id', 'name', 'subObjectIds', 'subObjects'] } } },
							},
						},
					},
				},
				'/HasTimeStampsNoPK/': {
					post: {
						description: 'create a new record auto-assigning a primary key',
						requestBody: {
							content: { 'application/json': { schema: { $ref: '#/components/schemas/HasTimeStampsNoPK' } } },
						},
						security: [{ basicAuth: [], bearerAuth: [] }],
						responses: {
							200: {
								description: 'successful operation',
								headers: {
									Location: { description: 'primary key of new record', schema: { type: 'string', format: 'ID' } },
								},
								content: { 'application/json': { schema: { type: 'string', format: 'ID' } } },
							},
						},
					},
					get: {
						description: 'search for records by the specified property name and value pairs',
						parameters: [
							{ name: 'created', in: 'query', schema: { type: 'number', format: 'Float' } },
							{ name: 'updated', in: 'query', schema: { type: 'number', format: 'Float' } },
						],
						security: [{ basicAuth: [], bearerAuth: [] }],
						responses: {
							200: {
								description: 'successful operation',
								content: { 'application/json': { schema: { $ref: '#/components/schemas/HasTimeStampsNoPK' } } },
							},
						},
					},
					delete: {
						description: 'delete all the records that match the provided query',
						parameters: [
							{ name: 'created', in: 'query', schema: { type: 'number', format: 'Float' } },
							{ name: 'updated', in: 'query', schema: { type: 'number', format: 'Float' } },
						],
						security: [{ basicAuth: [], bearerAuth: [] }],
						responses: { 204: { description: 'successfully processed request, no content returned to client' } },
					},
				},
				'/HasTimeStampsNoPK/{id}': {
					get: {
						description: 'retrieve a record by its primary key',
						parameters: [
							{
								name: 'id',
								in: 'path',
								schema: { format: 'ID' },
								required: true,
								description: 'primary key of record',
							},
						],
						security: [{ basicAuth: [], bearerAuth: [] }],
						responses: {
							200: {
								description: 'successful operation',
								content: { 'application/json': { schema: { $ref: '#/components/schemas/HasTimeStampsNoPK' } } },
							},
						},
					},
					put: {
						description: "create or update the record with the URL path that maps to the record's primary key",
						parameters: [
							{
								name: 'id',
								in: 'path',
								schema: { format: 'ID' },
								required: true,
								description: 'primary key of record',
							},
						],
						security: [{ basicAuth: [], bearerAuth: [] }],
						requestBody: {
							content: { 'application/json': { schema: { $ref: '#/components/schemas/HasTimeStampsNoPK' } } },
						},
						responses: { 200: { description: 'successful operation' } },
					},
					delete: {
						description: 'delete a record with the given primary key',
						parameters: [
							{
								name: 'id',
								in: 'path',
								schema: { format: 'ID' },
								required: true,
								description: 'primary key of record',
							},
						],
						security: [{ basicAuth: [], bearerAuth: [] }],
						responses: { 204: { description: 'successfully processed request, no content returned to client' } },
					},
				},
				'/HasTimeStampsNoPK/{id}.{property}': {
					get: {
						description: 'used to retrieve the specified property of the specified record',
						parameters: [
							{
								name: 'id',
								in: 'path',
								schema: { format: 'ID' },
								required: true,
								description: 'primary key of record',
							},
							{ name: 'property', in: 'path', schema: { enum: ['created', 'updated'] }, required: true },
						],
						security: [{ basicAuth: [], bearerAuth: [] }],
						responses: {
							200: {
								description: 'successful operation',
								content: { 'application/json': { schema: { enum: ['created', 'updated'] } } },
							},
						},
					},
				},
				'/HasBigInt/': {
					post: {
						description: 'create a new record auto-assigning a primary key',
						requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/HasBigInt' } } } },
						security: [{ basicAuth: [], bearerAuth: [] }],
						responses: {
							200: {
								description: 'successful operation',
								headers: {
									Location: { description: 'primary key of new record', schema: { type: 'string', format: 'ID' } },
								},
								content: { 'application/json': { schema: { type: 'string', format: 'ID' } } },
							},
						},
					},
					get: {
						description: 'search for records by the specified property name and value pairs',
						parameters: [
							{ name: 'id', in: 'query', schema: { type: 'integer', format: 'BigInt' } },
							{ name: 'name', in: 'query', schema: { type: 'string', format: 'String' } },
							{ name: 'anotherBigint', in: 'query', schema: { type: 'integer', format: 'BigInt' } },
						],
						security: [{ basicAuth: [], bearerAuth: [] }],
						responses: {
							200: {
								description: 'successful operation',
								content: { 'application/json': { schema: { $ref: '#/components/schemas/HasBigInt' } } },
							},
						},
					},
					delete: {
						description: 'delete all the records that match the provided query',
						parameters: [
							{ name: 'id', in: 'query', schema: { type: 'integer', format: 'BigInt' } },
							{ name: 'name', in: 'query', schema: { type: 'string', format: 'String' } },
							{ name: 'anotherBigint', in: 'query', schema: { type: 'integer', format: 'BigInt' } },
						],
						security: [{ basicAuth: [], bearerAuth: [] }],
						responses: { 204: { description: 'successfully processed request, no content returned to client' } },
					},
				},
				'/HasBigInt/{id}': {
					get: {
						description: 'retrieve a record by its primary key',
						parameters: [
							{
								name: 'id',
								in: 'path',
								schema: { format: 'ID' },
								required: true,
								description: 'primary key of record',
							},
						],
						security: [{ basicAuth: [], bearerAuth: [] }],
						responses: {
							200: {
								description: 'successful operation',
								content: { 'application/json': { schema: { $ref: '#/components/schemas/HasBigInt' } } },
							},
						},
					},
					put: {
						description: "create or update the record with the URL path that maps to the record's primary key",
						parameters: [
							{
								name: 'id',
								in: 'path',
								schema: { format: 'ID' },
								required: true,
								description: 'primary key of record',
							},
						],
						security: [{ basicAuth: [], bearerAuth: [] }],
						requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/HasBigInt' } } } },
						responses: { 200: { description: 'successful operation' } },
					},
					delete: {
						description: 'delete a record with the given primary key',
						parameters: [
							{
								name: 'id',
								in: 'path',
								schema: { format: 'ID' },
								required: true,
								description: 'primary key of record',
							},
						],
						security: [{ basicAuth: [], bearerAuth: [] }],
						responses: { 204: { description: 'successfully processed request, no content returned to client' } },
					},
				},
				'/HasBigInt/{id}.{property}': {
					get: {
						description: 'used to retrieve the specified property of the specified record',
						parameters: [
							{
								name: 'id',
								in: 'path',
								schema: { format: 'ID' },
								required: true,
								description: 'primary key of record',
							},
							{ name: 'property', in: 'path', schema: { enum: ['id', 'name', 'anotherBigint'] }, required: true },
						],
						security: [{ basicAuth: [], bearerAuth: [] }],
						responses: {
							200: {
								description: 'successful operation',
								content: { 'application/json': { schema: { enum: ['id', 'name', 'anotherBigint'] } } },
							},
						},
					},
				},
				'/Echo/': {
					get: {
						description: 'search for records by the specified property name and value pairs',
						parameters: [],
						security: [{ basicAuth: [], bearerAuth: [] }],
						responses: {
							200: {
								description: 'successful operation',
								content: { 'application/json': { schema: { $ref: '#/components/schemas/Echo' } } },
							},
						},
					},
				},
				'/Echo/{id}': {
					get: {
						description: 'retrieve a record by its primary key',
						parameters: [
							{
								name: 'id',
								in: 'path',
								schema: { format: 'ID' },
								required: true,
								description: 'primary key of record',
							},
						],
						security: [{ basicAuth: [], bearerAuth: [] }],
						responses: {
							200: {
								description: 'successful operation',
								content: { 'application/json': { schema: { $ref: '#/components/schemas/Echo' } } },
							},
						},
					},
				},
				'/FourPropWithHistory/': {
					post: {
						description: 'create a new record auto-assigning a primary key',
						requestBody: {
							content: { 'application/json': { schema: { $ref: '#/components/schemas/FourPropWithHistory' } } },
						},
						security: [{ basicAuth: [], bearerAuth: [] }],
						responses: {
							200: {
								description: 'successful operation',
								headers: {
									Location: { description: 'primary key of new record', schema: { type: 'string', format: 'ID' } },
								},
								content: { 'application/json': { schema: { type: 'string', format: 'ID' } } },
							},
						},
					},
					get: {
						description: 'search for records by the specified property name and value pairs',
						parameters: [
							{ name: 'id', in: 'query', schema: { format: 'ID' } },
							{ name: 'name', in: 'query', schema: { type: 'string', format: 'String' } },
							{ name: 'age', in: 'query', schema: { type: 'integer', format: 'Int' } },
							{ name: 'title', in: 'query', schema: { type: 'string', format: 'String' } },
							{ name: 'birthday', in: 'query', schema: { type: 'string', format: 'Date' } },
							{ name: 'ageInMonths', in: 'query', schema: { type: 'integer', format: 'Int' } },
							{ name: 'nameTitle', in: 'query', schema: { type: 'integer', format: 'Int' } },
						],
						security: [{ basicAuth: [], bearerAuth: [] }],
						responses: {
							200: {
								description: 'successful operation',
								content: { 'application/json': { schema: { $ref: '#/components/schemas/FourPropWithHistory' } } },
							},
						},
					},
					delete: {
						description: 'delete all the records that match the provided query',
						parameters: [
							{ name: 'id', in: 'query', schema: { format: 'ID' } },
							{ name: 'name', in: 'query', schema: { type: 'string', format: 'String' } },
							{ name: 'age', in: 'query', schema: { type: 'integer', format: 'Int' } },
							{ name: 'title', in: 'query', schema: { type: 'string', format: 'String' } },
							{ name: 'birthday', in: 'query', schema: { type: 'string', format: 'Date' } },
							{ name: 'ageInMonths', in: 'query', schema: { type: 'integer', format: 'Int' } },
							{ name: 'nameTitle', in: 'query', schema: { type: 'integer', format: 'Int' } },
						],
						security: [{ basicAuth: [], bearerAuth: [] }],
						responses: { 204: { description: 'successfully processed request, no content returned to client' } },
					},
				},
				'/FourPropWithHistory/{id}': {
					get: {
						description: 'retrieve a record by its primary key',
						parameters: [
							{
								name: 'id',
								in: 'path',
								schema: { format: 'ID' },
								required: true,
								description: 'primary key of record',
							},
						],
						security: [{ basicAuth: [], bearerAuth: [] }],
						responses: {
							200: {
								description: 'successful operation',
								content: { 'application/json': { schema: { $ref: '#/components/schemas/FourPropWithHistory' } } },
							},
						},
					},
					put: {
						description: "create or update the record with the URL path that maps to the record's primary key",
						parameters: [
							{
								name: 'id',
								in: 'path',
								schema: { format: 'ID' },
								required: true,
								description: 'primary key of record',
							},
						],
						security: [{ basicAuth: [], bearerAuth: [] }],
						requestBody: {
							content: { 'application/json': { schema: { $ref: '#/components/schemas/FourPropWithHistory' } } },
						},
						responses: { 200: { description: 'successful operation' } },
					},
					delete: {
						description: 'delete a record with the given primary key',
						parameters: [
							{
								name: 'id',
								in: 'path',
								schema: { format: 'ID' },
								required: true,
								description: 'primary key of record',
							},
						],
						security: [{ basicAuth: [], bearerAuth: [] }],
						responses: { 204: { description: 'successfully processed request, no content returned to client' } },
					},
				},
				'/FourPropWithHistory/{id}.{property}': {
					get: {
						description: 'used to retrieve the specified property of the specified record',
						parameters: [
							{
								name: 'id',
								in: 'path',
								schema: { format: 'ID' },
								required: true,
								description: 'primary key of record',
							},
							{
								name: 'property',
								in: 'path',
								schema: { enum: ['id', 'name', 'age', 'title', 'birthday', 'ageInMonths', 'nameTitle'] },
								required: true,
							},
						],
						security: [{ basicAuth: [], bearerAuth: [] }],
						responses: {
							200: {
								description: 'successful operation',
								content: {
									'application/json': {
										schema: { enum: ['id', 'name', 'age', 'title', 'birthday', 'ageInMonths', 'nameTitle'] },
									},
								},
							},
						},
					},
				},
				'/SimpleCache/': {
					post: {
						description: 'create a new record auto-assigning a primary key',
						requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/SimpleCache' } } } },
						security: [{ basicAuth: [], bearerAuth: [] }],
						responses: {
							200: {
								description: 'successful operation',
								headers: {
									Location: { description: 'primary key of new record', schema: { type: 'string', format: 'ID' } },
								},
								content: { 'application/json': { schema: { type: 'string', format: 'ID' } } },
							},
						},
					},
					get: {
						description: 'search for records by the specified property name and value pairs',
						parameters: [{ name: 'id', in: 'query', schema: { format: 'ID' } }],
						security: [{ basicAuth: [], bearerAuth: [] }],
						responses: {
							200: {
								description: 'successful operation',
								content: { 'application/json': { schema: { $ref: '#/components/schemas/SimpleCache' } } },
							},
						},
					},
					delete: {
						description: 'delete all the records that match the provided query',
						parameters: [{ name: 'id', in: 'query', schema: { format: 'ID' } }],
						security: [{ basicAuth: [], bearerAuth: [] }],
						responses: { 204: { description: 'successfully processed request, no content returned to client' } },
					},
				},
				'/SimpleCache/{id}': {
					get: {
						description: 'retrieve a record by its primary key',
						parameters: [
							{
								name: 'id',
								in: 'path',
								schema: { format: 'ID' },
								required: true,
								description: 'primary key of record',
							},
						],
						security: [{ basicAuth: [], bearerAuth: [] }],
						responses: {
							200: {
								description: 'successful operation',
								content: { 'application/json': { schema: { $ref: '#/components/schemas/SimpleCache' } } },
							},
						},
					},
					put: {
						description: "create or update the record with the URL path that maps to the record's primary key",
						parameters: [
							{
								name: 'id',
								in: 'path',
								schema: { format: 'ID' },
								required: true,
								description: 'primary key of record',
							},
						],
						security: [{ basicAuth: [], bearerAuth: [] }],
						requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/SimpleCache' } } } },
						responses: { 200: { description: 'successful operation' } },
					},
					delete: {
						description: 'delete a record with the given primary key',
						parameters: [
							{
								name: 'id',
								in: 'path',
								schema: { format: 'ID' },
								required: true,
								description: 'primary key of record',
							},
						],
						security: [{ basicAuth: [], bearerAuth: [] }],
						responses: { 204: { description: 'successfully processed request, no content returned to client' } },
					},
				},
				'/SimpleCache/{id}.{property}': {
					get: {
						description: 'used to retrieve the specified property of the specified record',
						parameters: [
							{
								name: 'id',
								in: 'path',
								schema: { format: 'ID' },
								required: true,
								description: 'primary key of record',
							},
							{ name: 'property', in: 'path', schema: { enum: ['id'] }, required: true },
						],
						security: [{ basicAuth: [], bearerAuth: [] }],
						responses: {
							200: {
								description: 'successful operation',
								content: { 'application/json': { schema: { enum: ['id'] } } },
							},
						},
					},
				},
				'/namespace/SubObject/': {
					post: {
						description: 'create a new record auto-assigning a primary key',
						requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/SubObject' } } } },
						security: [{ basicAuth: [], bearerAuth: [] }],
						responses: {
							200: {
								description: 'successful operation',
								headers: {
									Location: { description: 'primary key of new record', schema: { type: 'string', format: 'ID' } },
								},
								content: { 'application/json': { schema: { type: 'string', format: 'ID' } } },
							},
						},
					},
					get: {
						description: 'search for records by the specified property name and value pairs',
						parameters: [
							{ name: 'id', in: 'query', schema: { format: 'ID' } },
							{ name: 'subObject', in: 'query', schema: { $ref: '#/components/schemas/SomeObject' } },
							{
								name: 'subArray',
								in: 'query',
								schema: { type: 'array', items: { $ref: '#/components/schemas/SomeObject' } },
							},
							{ name: 'any', in: 'query', schema: { format: 'Any' } },
							{ name: 'relatedId', in: 'query', schema: { format: 'ID' } },
							{ name: 'related', in: 'query', schema: { $ref: '#/components/schemas/Related' } },
							{
								name: 'manyToMany',
								in: 'query',
								schema: { type: 'array', items: { $ref: '#/components/schemas/ManyToMany' } },
							},
						],
						security: [{ basicAuth: [], bearerAuth: [] }],
						responses: {
							200: {
								description: 'successful operation',
								content: { 'application/json': { schema: { $ref: '#/components/schemas/SubObject' } } },
							},
						},
					},
					delete: {
						description: 'delete all the records that match the provided query',
						parameters: [
							{ name: 'id', in: 'query', schema: { format: 'ID' } },
							{ name: 'subObject', in: 'query', schema: { $ref: '#/components/schemas/SomeObject' } },
							{
								name: 'subArray',
								in: 'query',
								schema: { type: 'array', items: { $ref: '#/components/schemas/SomeObject' } },
							},
							{ name: 'any', in: 'query', schema: { format: 'Any' } },
							{ name: 'relatedId', in: 'query', schema: { format: 'ID' } },
							{ name: 'related', in: 'query', schema: { $ref: '#/components/schemas/Related' } },
							{
								name: 'manyToMany',
								in: 'query',
								schema: { type: 'array', items: { $ref: '#/components/schemas/ManyToMany' } },
							},
						],
						security: [{ basicAuth: [], bearerAuth: [] }],
						responses: { 204: { description: 'successfully processed request, no content returned to client' } },
					},
				},
				'/namespace/SubObject/{id}': {
					get: {
						description: 'retrieve a record by its primary key',
						parameters: [
							{
								name: 'id',
								in: 'path',
								schema: { format: 'ID' },
								required: true,
								description: 'primary key of record',
							},
						],
						security: [{ basicAuth: [], bearerAuth: [] }],
						responses: {
							200: {
								description: 'successful operation',
								content: { 'application/json': { schema: { $ref: '#/components/schemas/SubObject' } } },
							},
						},
					},
					put: {
						description: "create or update the record with the URL path that maps to the record's primary key",
						parameters: [
							{
								name: 'id',
								in: 'path',
								schema: { format: 'ID' },
								required: true,
								description: 'primary key of record',
							},
						],
						security: [{ basicAuth: [], bearerAuth: [] }],
						requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/SubObject' } } } },
						responses: { 200: { description: 'successful operation' } },
					},
					delete: {
						description: 'delete a record with the given primary key',
						parameters: [
							{
								name: 'id',
								in: 'path',
								schema: { format: 'ID' },
								required: true,
								description: 'primary key of record',
							},
						],
						security: [{ basicAuth: [], bearerAuth: [] }],
						responses: { 204: { description: 'successfully processed request, no content returned to client' } },
					},
				},
				'/namespace/SubObject/{id}.{property}': {
					get: {
						description: 'used to retrieve the specified property of the specified record',
						parameters: [
							{
								name: 'id',
								in: 'path',
								schema: { format: 'ID' },
								required: true,
								description: 'primary key of record',
							},
							{
								name: 'property',
								in: 'path',
								schema: { enum: ['id', 'subObject', 'subArray', 'any', 'relatedId', 'related', 'manyToMany'] },
								required: true,
							},
						],
						security: [{ basicAuth: [], bearerAuth: [] }],
						responses: {
							200: {
								description: 'successful operation',
								content: {
									'application/json': {
										schema: { enum: ['id', 'subObject', 'subArray', 'any', 'relatedId', 'related', 'manyToMany'] },
									},
								},
							},
						},
					},
				},
			},
			components: {
				schemas: {
					VariedProps: {
						type: 'object',
						properties: { id: { format: 'ID' }, name: { type: 'string', format: 'String' } },
					},
					SimpleRecord: {
						type: 'object',
						properties: { id: { format: 'ID' }, name: { type: 'string', format: 'String' } },
					},
					FourProp: {
						type: 'object',
						properties: {
							id: { format: 'ID' },
							name: { type: 'string', format: 'String' },
							age: { type: 'integer', format: 'Int' },
							title: { type: 'string', format: 'String' },
							birthday: { type: 'string', format: 'Date' },
							ageInMonths: { type: 'integer', format: 'Int' },
							nameTitle: { type: 'integer', format: 'Int' },
						},
					},
					Related: {
						type: 'object',
						properties: {
							id: { format: 'ID' },
							name: { type: 'string', format: 'String' },
							otherTable: { type: 'array', items: { $ref: '#/components/schemas/SubObject' } },
						},
					},
					ManyToMany: {
						type: 'object',
						properties: {
							id: { format: 'ID' },
							name: { type: 'string', format: 'String' },
							subObjectIds: { type: 'array', items: { format: 'ID' } },
							subObjects: { type: 'array', items: { $ref: '#/components/schemas/SubObject' } },
						},
					},
					HasTimeStampsNoPK: {
						type: 'object',
						properties: { created: { type: 'number', format: 'Float' }, updated: { type: 'number', format: 'Float' } },
					},
					HasBigInt: {
						type: 'object',
						properties: {
							id: { type: 'integer', format: 'BigInt' },
							name: { type: 'string', format: 'String' },
							anotherBigint: { type: 'integer', format: 'BigInt' },
						},
					},
					Echo: { type: 'object', properties: {} },
					FourPropWithHistory: {
						type: 'object',
						properties: {
							id: { format: 'ID' },
							name: { type: 'string', format: 'String' },
							age: { type: 'integer', format: 'Int' },
							title: { type: 'string', format: 'String' },
							birthday: { type: 'string', format: 'Date' },
							ageInMonths: { type: 'integer', format: 'Int' },
							nameTitle: { type: 'integer', format: 'Int' },
						},
					},
					SimpleCache: { type: 'object', properties: { id: { format: 'ID' } } },
					SomeObject: { type: 'object', properties: { name: { type: 'string', format: 'String' } } },
					SubObject: {
						type: 'object',
						properties: {
							id: { format: 'ID' },
							subObject: { $ref: '#/components/schemas/SomeObject' },
							subArray: { type: 'array', items: { $ref: '#/components/schemas/SomeObject' } },
							any: { format: 'Any' },
							relatedId: { format: 'ID' },
							related: { $ref: '#/components/schemas/Related' },
							manyToMany: { type: 'array', items: { $ref: '#/components/schemas/ManyToMany' } },
						},
					},
				},
				securitySchemes: {
					basicAuth: { type: 'http', scheme: 'basic' },
					bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
				},
			},
		});
	});
});
