// a parameterised custom resource carrying a request contract emits its declared
// query params, request body, and response in the OpenAPI document — instead of the path-params-only +
// generic `{ type: 'object' }` body/response a custom param route got before.

const { expect } = require('chai');
const { generateJsonApi } = require('#src/resources/openApi');

const serverURL = 'https://harper.fast';

// Compiled route segments for `/widget/:id` (shape produced by Resources.compileRouteSegments).
const segments = [
	{ type: 'static', value: 'widget' },
	{ type: 'param', value: 'id' },
];

function makeContractResource() {
	function Widget() {}
	Widget.prototype.get = function () {};
	Widget.prototype.post = function () {};
	Widget.path = '/widget/:id';
	Widget.requestContract = { path: '/widget/:id' };
	Widget.inputSchemas = {
		get: {
			query: {
				type: 'object',
				properties: { expand: { type: 'array', items: { type: 'string', enum: ['parts', 'owner'] } } },
				required: [],
			},
		},
		post: {
			body: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
		},
	};
	Widget.outputSchemas = {
		get: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } },
		post: { type: 'object', properties: { id: { type: 'string' } } },
	};
	return Widget;
}

function makeResources() {
	const resources = new Map();
	resources.allTypes = new Map();
	resources.paramRoutes = [
		{ pattern: 'widget/:id', segments, entry: { path: 'widget/:id', Resource: makeContractResource() } },
	];
	return resources;
}

describe('openApi — request-contract emission', () => {
	let api;
	beforeEach(() => {
		api = generateJsonApi(makeResources(), serverURL);
	});

	it('emits the path param AND the declared query params on GET', () => {
		const get = api.paths['/widget/{id}'].get;
		expect(get).to.exist;
		const names = get.parameters.map((p) => `${p.in}:${p.name}`);
		expect(names).to.include('path:id');
		expect(names).to.include('query:expand');
		const expand = get.parameters.find((p) => p.name === 'expand');
		expect(expand.schema.type).to.equal('array');
		expect(expand.schema.items.enum).to.deep.equal(['parts', 'owner']);
	});

	it('emits the declared request body on POST instead of a generic object', () => {
		const post = api.paths['/widget/{id}'].post;
		const schema = post.requestBody.content['application/json'].schema;
		expect(schema.type).to.equal('object');
		expect(schema.properties).to.have.property('name');
		expect(schema.required).to.deep.equal(['name']);
	});

	it('emits the declared response schema', () => {
		const getResponse = api.paths['/widget/{id}'].get.responses['200'].content['application/json'].schema;
		expect(getResponse.properties).to.have.property('name');
		const postResponse = api.paths['/widget/{id}'].post.responses['200'].content['application/json'].schema;
		expect(Object.keys(postResponse.properties)).to.deep.equal(['id']);
	});
});

// a request-contract resource declared at a static (non-parameterised) path lives in the `resources`
// Map itself (not `resources.paramRoutes`, which only holds parameterised routes) — skipped by the
// table-CRUD loop above and emitted by the same `emitContractRoutes` helper, off the declared contract.
function makeStaticContractResource() {
	function OrderIntake() {}
	OrderIntake.prototype.post = function () {};
	OrderIntake.path = 'order-intake';
	OrderIntake.requestContract = { path: '/order-intake' };
	OrderIntake.inputSchemas = {
		post: {
			body: { type: 'object', properties: { sku: { type: 'string' } }, required: ['sku'] },
		},
	};
	OrderIntake.outputSchemas = {
		post: { type: 'object', properties: { id: { type: 'string' } } },
	};
	return OrderIntake;
}

function makeResourcesWithStaticContract() {
	const resources = new Map();
	resources.allTypes = new Map();
	resources.set('order-intake', { path: 'order-intake', Resource: makeStaticContractResource() });
	return resources;
}

describe('openApi — request-contract emission at a static path (resources Map, not paramRoutes)', () => {
	let api;
	beforeEach(() => {
		api = generateJsonApi(makeResourcesWithStaticContract(), serverURL);
	});

	it('emits the path off the declared contract instead of falling through to table-CRUD', () => {
		expect(api.paths['/order-intake']).to.exist;
		expect(api.paths['/order-intake'].get).to.be.undefined;
	});

	it('emits the declared request body and response schema on POST', () => {
		const post = api.paths['/order-intake'].post;
		expect(post).to.exist;
		const schema = post.requestBody.content['application/json'].schema;
		expect(schema.properties).to.have.property('sku');
		expect(schema.required).to.deep.equal(['sku']);
		const response = post.responses['200'].content['application/json'].schema;
		expect(Object.keys(response.properties)).to.deep.equal(['id']);
	});
});
