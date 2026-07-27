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

// #1942 follow-up: `required: []` is invalid under JSON Schema draft-04, which OpenAPI 3.0.3
// inherits — a resource whose attributes are all nullable produced exactly that.
describe('openApi — empty required omission', () => {
	it('omits the top-level `required` key when no attribute is non-nullable', () => {
		class AllOptional {}
		AllOptional.primaryKey = 'id';
		AllOptional.properties = { id: { type: 'string', primaryKey: true }, label: { type: 'string' } };
		AllOptional.prototype.get = function () {};
		const resources = new Map();
		resources.set('AllOptional', { path: 'AllOptional', Resource: AllOptional, hasSubPaths: false, relativeURL: '' });
		resources.allTypes = new Map();
		const schema = generateJsonApi(resources, 'https://harper.fast').components.schemas.AllOptional;
		expect(schema).to.not.have.property('required');
	});
});

// The document declares OpenAPI 3.0.3, whose Schema Object is the JSON Schema draft-04 subset.
// Keywords from later drafts (`const`, added in draft-06) and JSON Schema's `'null'` type are not
// part of that dialect, so emitting them produces a document strict validators reject. This walks
// the whole generated document rather than checking one property, so any future emit path that
// reaches for a newer keyword is caught here instead of in a consumer's tooling.
describe('openApi — declared dialect compliance (3.0.3)', () => {
	// Keywords absent from the draft-04 subset OpenAPI 3.0.x is built on.
	const POST_DRAFT4_KEYWORDS = ['const', 'contentEncoding', 'contentMediaType', 'if', 'then', 'else', '$defs'];

	// `components.securitySchemes` holds Security Scheme Objects, not Schema Objects — their `type`
	// ("http", "apiKey", …) is a different vocabulary and must not be judged against Schema Object rules.
	const NON_SCHEMA_SUBTREES = ['$.components.securitySchemes'];

	function walk(node, visit, path = '$') {
		if (NON_SCHEMA_SUBTREES.some((prefix) => path.startsWith(prefix))) return;
		if (node === null || typeof node !== 'object') return;
		if (Array.isArray(node)) {
			node.forEach((item, i) => walk(item, visit, `${path}[${i}]`));
			return;
		}
		visit(node, path);
		for (const [key, value] of Object.entries(node)) walk(value, visit, `${path}.${key}`);
	}

	function buildDocument() {
		class Widget {}
		Widget.primaryKey = 'id';
		Widget.properties = {
			id: { type: 'string', primaryKey: true },
			kind: { type: 'string', const: 'widget' },
			nothing: { type: 'null' },
			maybe: { type: ['string', 'null'] },
			mixed: { type: ['string', 'number'] },
			mixedMaybe: { type: ['string', 'integer', 'null'] },
			nested: {
				type: 'object',
				properties: {
					inner: { type: 'string', const: 'x' },
					deepNull: { type: 'null' },
					deepMixed: { type: ['string', 'number'] },
				},
			},
			list: { type: 'array', items: { type: 'string', const: 'y' } },
			nullableEnum: { type: 'string', enum: ['a', 'b'], nullable: true },
			nullableConst: { type: 'string', const: 'fixed', nullable: true },
			bogus: { type: 'Text' },
			secret: { type: 'string', hidden: true },
			when: { type: 'Date', format: 'date-time' },
			bytes: { type: 'Bytes' },
		};
		Widget.prototype.get = function () {};
		// A request-contract resource alongside the table-shaped one: its schemas are author-written
		// JSON Schema emitted through a different function (`fragmentToOpenApiSchema`), so a fixture
		// with only the table path leaves every request body, response, and contract query parameter
		// unguarded by the walks below.
		function Contract() {}
		Contract.prototype.get = function () {};
		Contract.prototype.post = function () {};
		Contract.path = '/contract';
		Contract.requestContract = { path: '/contract' };
		Contract.inputSchemas = {
			post: {
				body: {
					type: 'object',
					properties: {
						kind: { type: 'string', const: 'order' },
						note: { type: ['string', 'null'] },
						status: { type: 'string', enum: ['a', 'b'], nullable: true },
					},
					required: ['kind'],
				},
			},
		};
		Contract.outputSchemas = { post: { type: 'object', properties: { tag: { type: 'string', const: 'ok' } } } };

		const resources = new Map();
		resources.set('Widget', { path: 'Widget', Resource: Widget, hasSubPaths: false, relativeURL: '' });
		resources.set('Contract', { path: '/contract', Resource: Contract, hasSubPaths: false, relativeURL: '' });
		resources.allTypes = new Map();
		// Judge what a consumer actually receives: `JSON.stringify` drops undefined-valued keys,
		// so walking the live object would flag artifacts that never reach the wire.
		return JSON.parse(JSON.stringify(generateJsonApi(resources, 'https://harper.fast')));
	}

	it('declares 3.0.x', () => {
		expect(buildDocument().openapi).to.match(/^3\.0\./);
	});

	it('emits no post-draft-04 keywords anywhere in the document', () => {
		const offenders = [];
		walk(buildDocument(), (node, path) => {
			for (const keyword of POST_DRAFT4_KEYWORDS) {
				if (Object.hasOwn(node, keyword)) offenders.push(`${path}.${keyword}`);
			}
		});
		expect(offenders, `post-draft-04 keywords in a 3.0.3 document: ${offenders.join(', ')}`).to.deep.equal([]);
	});

	it('emits only the six type values 3.0.x defines, and never a type array', () => {
		// 3.0's `type` is a closed enum of single values: no `'null'`, no unions, and nothing from
		// Harper's own vocabulary. Checking only for `'null'` would sail past `type: 'Text'` or
		// `['string','number']`, both equally invalid here.
		const OPENAPI_30_TYPES = ['string', 'number', 'integer', 'boolean', 'object', 'array'];
		const offenders = [];
		walk(buildDocument(), (node, path) => {
			if (!Object.hasOwn(node, 'type')) return;
			const t = node.type;
			if (Array.isArray(t)) offenders.push(`${path}.type=[${t.join(',')}] (unions invalid in 3.0)`);
			else if (!OPENAPI_30_TYPES.includes(t)) offenders.push(`${path}.type=${String(t)}`);
		});
		expect(offenders, `invalid 3.0 types: ${offenders.join(', ')}`).to.deep.equal([]);
	});

	it('never leaks a Harper directive into the emitted document', () => {
		// `hidden`/`primaryKey`/the timestamp flags drive Harper behavior; they are not schema vocabulary
		// and a consumer parsing this document has no meaning for them.
		const DIRECTIVES = ['hidden', 'primaryKey', 'assignCreatedTime', 'assignUpdatedTime'];
		const offenders = [];
		walk(buildDocument(), (node, path) => {
			for (const key of DIRECTIVES) if (Object.hasOwn(node, key)) offenders.push(`${path}.${key}`);
		});
		expect(offenders, `Harper directives in the document: ${offenders.join(', ')}`).to.deep.equal([]);
	});

	it('translates `const` to a single-value `enum`, at every depth', () => {
		const props = buildDocument().components.schemas.Widget.properties;
		expect(props.kind.enum).to.deep.equal(['widget']);
		expect(props.kind).to.not.have.property('const');
		expect(props.nested.properties.inner.enum).to.deep.equal(['x']);
		expect(props.list.items.enum).to.deep.equal(['y']);
	});

	it('includes null in the value list when a nullable property carries an enum', () => {
		// 3.0's `nullable` does not widen an `enum` — without `null` in the list a validator rejects it
		// regardless of the flag, so the schema would contradict itself.
		const doc = buildDocument();
		const props = doc.components.schemas.Widget.properties;
		expect(props.nullableEnum.enum).to.deep.equal(['a', 'b', null]);
		expect(props.nullableEnum.nullable).to.equal(true);
		expect(props.nullableConst.enum).to.deep.equal(['fixed', null]);
	});

	it('lets an author-declared format outrank the Harper type name', () => {
		expect(buildDocument().components.schemas.Widget.properties.when.format).to.equal('date-time');
	});

	it('translates request-contract schemas too (bodies, responses, contract query params)', () => {
		// This path runs through `fragmentToOpenApiSchema`, not the table emitter, so it needs its own
		// assertion — a fixture with only the table resource leaves it entirely unguarded.
		const doc = buildDocument();
		const body = doc.paths['/contract'].post.requestBody.content['application/json'].schema;
		expect(body.properties.kind.enum, 'contract body const -> enum').to.deep.equal(['order']);
		expect(body.properties.kind).to.not.have.property('const');
		expect(body.properties.note.type, 'union folds to a single type').to.equal('string');
		expect(body.properties.note.nullable).to.equal(true);
		expect(body.properties.status.enum, 'nullable enum admits null').to.deep.equal(['a', 'b', null]);
	});

	it('carries nullability onto the emitted scalar schema', () => {
		// The walk assertions above only prove `type: 'null'` and unions are gone; they would pass just as
		// happily if nullability were dropped instead of translated.
		const props = buildDocument().components.schemas.Widget.properties;
		expect(props.maybe).to.deep.equal({ type: 'string', nullable: true });
		expect(props.nothing.nullable).to.equal(true);
	});

	it('widens a nullable `enum` with `null` (3.0 `nullable` does not do it)', () => {
		const props = buildDocument().components.schemas.Widget.properties;
		expect(props.nullableEnum.nullable).to.equal(true);
		expect(props.nullableEnum.enum).to.deep.equal(['a', 'b', null]);
		// `const` + `nullable`: the single-value enum still has to admit null.
		expect(props.nullableConst.enum).to.deep.equal(['fixed', null]);
	});

	it('translates a genuine multi-type union to `oneOf`', () => {
		// 3.0 has no type arrays. Keeping only the first member would narrow the contract silently —
		// a client would be told `mixed` is a string when the resource also accepts a number.
		const props = buildDocument().components.schemas.Widget.properties;
		expect(props.mixed).to.deep.equal({ oneOf: [{ type: 'string' }, { type: 'number' }] });
		expect(props.mixed).to.not.have.property('type');
	});

	it('carries nullability alongside a union', () => {
		const props = buildDocument().components.schemas.Widget.properties;
		expect(props.mixedMaybe.oneOf).to.deep.equal([{ type: 'string' }, { type: 'integer' }]);
		expect(props.mixedMaybe.nullable).to.equal(true);
	});

	it('translates a union nested inside an object, not just at the top level', () => {
		// The nested path is the one #1941/#1942 exist to keep in step with the top-level one; a union
		// declared two levels down has to reach the same `oneOf`.
		const nested = buildDocument().components.schemas.Widget.properties.nested;
		expect(nested.properties.deepMixed.oneOf).to.deep.equal([{ type: 'string' }, { type: 'number' }]);
		expect(nested.properties.deepMixed).to.not.have.property('type');
	});

	it('emits the properties under test (guards the walk assertions against an empty document)', () => {
		const props = buildDocument().components.schemas.Widget.properties;
		for (const key of [
			'kind',
			'nothing',
			'maybe',
			'mixed',
			'mixedMaybe',
			'nested',
			'list',
			'nullableEnum',
			'nullableConst',
			'when',
		]) {
			expect(props, `fixture property ${key} missing — walk assertions would pass vacuously`).to.have.property(key);
		}
	});
});
