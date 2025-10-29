import { describe, it, beforeEach } from 'mocha';
import { expect } from 'chai';
import { generateJsonApi } from '@/resources/openApi';

describe('test openApi module', () => {
	let resources;
	let allTypes;
	const serverURL = 'https://harper.fast';

	beforeEach(() => {
		resources = new Map();

		resources.set('Dog', {
			path: 'Dog',
			Resource: {
				prototype: {
					put: () => [],
					get: () => [],
					delete: () => [],
					patch: () => [],
					post: () => [],
					update: () => [],
				},
				attributes: [
					{
						type: 'String',
						name: 'name',
						nullable: false,
					},
				],
			},
		});

		allTypes = new Map();
		allTypes.set('Dog', {
			type: 'Dog',
			properties: [
				{
					type: 'String',
					name: 'name',
					nullable: false,
				},
			],
		});
		resources.allTypes = allTypes;
	});

	it('Includes basic information', function () {
		const api = generateJsonApi(resources, serverURL);
		expect(api).to.have.property('openapi');
		expect(api).to.have.property('info');
		expect(api).to.have.property('servers');
		expect(api).to.have.property('paths');
		expect(api).to.have.property('components');
		expect(api.servers).to.have.length(1);
		expect(api.servers[0]).to.have.property('url', serverURL);
	});

	it('Skips resources without a path', function () {
		resources.get('Dog').path = null;
		const api = generateJsonApi(resources, serverURL);
		expect(api).to.have.property('paths');
		expect(api.paths).not.to.have.property('/Dog/');
	});

	it('Skips resources in error', function () {
		resources.get('Dog').Resource.isError = true;
		const api = generateJsonApi(resources, serverURL);
		expect(api).to.have.property('paths');
		expect(api.paths).not.to.have.property('/Dog/');
	});

	it('Builds basic route', function () {
		const api = generateJsonApi(resources, serverURL);
		expect(api).to.have.property('paths');
		expect(api.paths).to.have.property('/Dog/');
		expect(api.paths['/Dog/']).to.have.property('get');
		expect(api.paths['/Dog/']).to.have.property('delete');
		expect(api.paths['/Dog/']).to.have.property('options');

		expect(api.paths).to.have.property('/Dog/{id}');
		expect(api.paths['/Dog/{id}']).to.have.property('get');
		expect(api.paths['/Dog/{id}']).to.have.property('options');
		expect(api.paths['/Dog/{id}']).to.have.property('put');
		expect(api.paths['/Dog/{id}']).to.have.property('patch');
		expect(api.paths['/Dog/{id}']).to.have.property('delete');
	});

	it('Ignores routes without an implementation in the resource', function () {
		resources.get('Dog').Resource.prototype.delete = null;
		const api = generateJsonApi(resources, serverURL);
		expect(api).to.have.property('paths');
		expect(api.paths).to.have.property('/Dog/');
		expect(api.paths['/Dog/']).to.have.property('get');
		expect(api.paths['/Dog/']).not.to.have.property('delete');

		expect(api.paths).to.have.property('/Dog/{id}');
		expect(api.paths['/Dog/{id}']).to.have.property('get');
		expect(api.paths['/Dog/{id}']).not.to.have.property('delete');
	});

	it('Describes components', function () {
		const api = generateJsonApi(resources, serverURL);
		expect(api).to.have.property('components');
		expect(api.components).to.have.property('schemas');
		expect(api.components.schemas).to.have.property('Dog');
		expect(api.components.schemas.Dog).to.have.property('type', 'object');
		expect(api.components.schemas.Dog).to.have.property('properties');
		expect(api.components.schemas.Dog.properties).to.have.property('name');
		expect(api.components.schemas.Dog.properties.name).to.have.property('type', 'string');
	});

	it('Can seal components', function () {
		resources.allTypes.get('Dog').sealed = true;
		const api = generateJsonApi(resources, serverURL);
		expect(api).to.have.property('components');
		expect(api.components).to.have.property('schemas');
		expect(api.components.schemas).to.have.property('Dog');
		expect(api.components.schemas.Dog).to.have.property('additionalProperties', false);
	});
});
