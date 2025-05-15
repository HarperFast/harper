require('../test_utils');
const assert = require('node:assert/strict');
const resourcesComponent = require('../../resources/Resources');
const { resources } = require('../../resources/Resources');

// might want to enable an iteration with NATS being assigned as a source
describe('Global resources map', () => {
	before(() => {
		if (!resourcesComponent.resources) {
			resourcesComponent.resetResources();
		}
	});
	it('Verify that resources is available through external variables', async function () {
		const { resources } = resourcesComponent;
		assert.strictEqual(server.resources, resources);
		assert.ok(resources instanceof Map);
		assert.strictEqual(typeof resources.getMatch, 'function');
		assert.strictEqual(typeof resources.set, 'function');
	});
	it('Verify that we can add and match resources through external variables', async function () {
		let testResource = {
			name: 'testResource',
		};
		server.resources.set(testResource.name, testResource);
		assert.strictEqual(server.resources.getMatch(testResource.name).Resource, testResource);
		assert.strictEqual(server.resources.getMatch('nonExistentResource'), undefined);

		server.resources.set('testLimitedExport', testResource, { 'limited': true, 'not-this': false });
		assert.strictEqual(server.resources.getMatch('testLimitedExport/3', 'limited').Resource, testResource);
		assert.strictEqual(server.resources.getMatch('testLimitedExport/3', 'not-this'), undefined);
	});
});
