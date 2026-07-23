const { expect } = require('chai');
const { generateJsonApi } = require('#src/resources/openApi');
const { Resources } = require('#src/resources/Resources');

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

	describe('parameterised routes', () => {
		it('emits a parameterised route as a templated path with path parameters', () => {
			const paramResources = new Resources();
			paramResources.set('widget/:id/action/:action', { prototype: { get: () => [] } });

			const api = generateJsonApi(paramResources, serverURL);
			expect(api.paths).to.have.property('/widget/{id}/action/{action}');
			const path = api.paths['/widget/{id}/action/{action}'];
			expect(path).to.have.property('get');

			const params = path.get.parameters;
			const names = params.map((p) => p.name);
			expect(names).to.include('id');
			expect(names).to.include('action');
			params.forEach((p) => {
				expect(p.in).to.equal('path');
				expect(p.required).to.equal(true);
			});
		});

		it('emits a wildcard route with a single catch-all path parameter', () => {
			const paramResources = new Resources();
			paramResources.set('files/*rest', { prototype: { get: () => [] } });

			const api = generateJsonApi(paramResources, serverURL);
			expect(api.paths).to.have.property('/files/{rest}');
			const params = api.paths['/files/{rest}'].get.parameters;
			expect(params.map((p) => p.name)).to.deep.equal(['rest']);
			expect(params[0].description).to.match(/remaining path/);
		});

		it('names a bare wildcard {wildcard} so the path template is a valid OpenAPI variable', () => {
			const paramResources = new Resources();
			paramResources.set('proxy/*', { prototype: { get: () => [] } });

			const api = generateJsonApi(paramResources, serverURL);
			expect(api.paths).to.have.property('/proxy/{wildcard}');
			expect(api.paths['/proxy/{wildcard}'].get.parameters.map((p) => p.name)).to.deep.equal(['wildcard']);
		});

		it('only emits the verbs the resource implements', () => {
			const paramResources = new Resources();
			paramResources.set('widget/:id', { prototype: { get: () => [], put: () => [] } });

			const path = generateJsonApi(paramResources, serverURL).paths['/widget/{id}'];
			expect(path).to.have.property('get');
			expect(path).to.have.property('put');
			expect(path).not.to.have.property('delete');
			expect(path).not.to.have.property('patch');
		});

		it('omits @hidden parameterised resources', () => {
			const paramResources = new Resources();
			paramResources.set('secret/:id', { hidden: true, prototype: { get: () => [] } });

			const api = generateJsonApi(paramResources, serverURL);
			expect(api.paths).not.to.have.property('/secret/{id}');
		});
	});

	describe('#1920 programmatic `static properties`', () => {
		function programmaticResources() {
			const r = new Map();
			r.set('Widget', {
				path: 'Widget',
				Resource: {
					prototype: { get: () => [], put: () => [], patch: () => [], delete: () => [], post: () => [] },
					description: 'A widget in the catalog.',
					// Record form only — no `attributes` Array.
					properties: {
						id: { type: 'string', primaryKey: true },
						label: { type: 'string', description: 'Human-readable label' },
						size: { type: 'integer', description: 'Width in pixels' },
					},
				},
			});
			r.allTypes = new Map();
			return r;
		}

		it('emits per-property schemas (type + description) from a bare static-properties declaration', () => {
			const api = generateJsonApi(programmaticResources(), serverURL);
			const schema = api.components.schemas.Widget;
			expect(schema).to.have.property('description', 'A widget in the catalog.');
			expect(schema.properties.label).to.include({ type: 'string', description: 'Human-readable label' });
			expect(schema.properties.size).to.include({ type: 'integer', description: 'Width in pixels' });
		});

		it('emits array items, enum, and nested-object shapes (not undefined/skeletal)', () => {
			const r = new Map();
			r.set('Gadget', {
				path: 'Gadget',
				Resource: {
					prototype: { get: () => [], put: () => [] },
					properties: {
						id: { type: 'string', primaryKey: true },
						tags: { type: 'array', items: { type: 'string' } },
						status: { type: 'string', enum: ['active', 'archived'] },
						dims: {
							type: 'object',
							required: ['w'],
							properties: { w: { type: 'integer' }, h: { type: 'integer' } },
						},
						rows: { type: 'array', items: { type: 'object', properties: { x: { type: 'integer' } } } },
						anything: { type: 'array' }, // no items — valid JSON Schema, must not crash generation
					},
				},
			});
			r.allTypes = new Map();
			const schema = generateJsonApi(r, serverURL).components.schemas.Gadget;
			// array-of-scalar: items carry the JSON type, not `undefined`
			expect(schema.properties.tags).to.deep.include({ type: 'array', items: { type: 'string' } });
			// enum surfaces the allowed values
			expect(schema.properties.status.enum).to.deep.equal(['active', 'archived']);
			// nested object is recursed, with its object-level constraints preserved
			expect(schema.properties.dims.type).to.equal('object');
			expect(schema.properties.dims.properties.w).to.include({ type: 'integer' });
			expect(schema.properties.dims.required).to.deep.equal(['w']);
			// array-of-object: items are the recursed object shape, not an undefined-typed blob
			expect(schema.properties.rows.type).to.equal('array');
			expect(schema.properties.rows.items.type).to.equal('object');
			expect(schema.properties.rows.items.properties.x).to.include({ type: 'integer' });
			// array with no items: emitted as a bare array (no crash on undefined elements)
			expect(schema.properties.anything).to.deep.equal({ type: 'array' });
		});
	});
});
