const { expect } = require('chai');
const { generateJsonApi } = require('#src/resources/openApi');

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

	describe('metadata flow-through (#1095)', () => {
		it('exposes per-attribute description on components.schemas.X.properties.Y', () => {
			resources.get('Dog').Resource.attributes[0].description = "The dog's display name.";
			const api = generateJsonApi(resources, serverURL);
			expect(api.components.schemas.Dog.properties.name).to.have.property('description', "The dog's display name.");
		});

		it('exposes Resource.description as components.schemas.X.description', () => {
			resources.get('Dog').Resource.description = 'A canine entry in the catalog.';
			const api = generateJsonApi(resources, serverURL);
			expect(api.components.schemas.Dog).to.have.property('description', 'A canine entry in the catalog.');
		});

		it('prepends Resource.description to each path-level operation description', () => {
			resources.get('Dog').Resource.description = 'A canine entry in the catalog.';
			const api = generateJsonApi(resources, serverURL);
			expect(api.paths['/Dog/'].post.description).to.contain('A canine entry in the catalog.');
			expect(api.paths['/Dog/'].post.description).to.contain('create a new record');
			expect(api.paths['/Dog/{id}'].get.description).to.contain('A canine entry in the catalog.');
			expect(api.paths['/Dog/{id}'].get.description).to.contain('retrieve a record by its primary key');
		});

		it('falls back to default path descriptions when Resource.description is absent', () => {
			const api = generateJsonApi(resources, serverURL);
			expect(api.paths['/Dog/'].post.description).to.equal('create a new record auto-assigning a primary key');
		});

		it('skips a Resource entirely when static hidden === true', () => {
			resources.get('Dog').Resource.hidden = true;
			const api = generateJsonApi(resources, serverURL);
			expect(api.paths).not.to.have.property('/Dog/');
			expect(api.paths).not.to.have.property('/Dog/{id}');
		});

		it('skips an individual attribute when hidden === true (no property, no query param)', () => {
			resources.get('Dog').Resource.attributes.push({
				type: 'String',
				name: 'internalNote',
				hidden: true,
			});
			const api = generateJsonApi(resources, serverURL);
			expect(api.components.schemas.Dog.properties).to.have.property('name');
			expect(api.components.schemas.Dog.properties).not.to.have.property('internalNote');
		});

		it('iterates nested type definitions via .attributes (the Array form), not .properties (the Record)', () => {
			// Regression: post-Phase-2 alignment, top-level typeDefs in allTypes have
			// .properties as a Record<string, JsonSchemaFragment>. The OpenAPI definition
			// walker must iterate the Array form to avoid throwing "not iterable" on
			// schemas with relationships / nested type definitions.
			const ownerType = {
				type: 'Owner',
				attributes: [
					{ type: 'String', name: 'firstName', nullable: false },
					{ type: 'String', name: 'lastName' },
				],
				properties: {
					firstName: { type: 'string' },
					lastName: { type: 'string' },
				},
			};
			resources.allTypes.set('Owner', ownerType);
			// Wire Dog → Owner via a relationship-like definition so the walker reaches Owner.
			resources.get('Dog').Resource.attributes.push({
				type: 'Owner',
				name: 'owner',
				definition: ownerType,
			});
			const api = generateJsonApi(resources, serverURL);
			expect(api.components.schemas).to.have.property('Owner');
			expect(api.components.schemas.Owner).to.have.property('properties');
			expect(api.components.schemas.Owner.properties).to.have.property('firstName');
			expect(api.components.schemas.Owner.properties).to.have.property('lastName');
		});
	});
});
