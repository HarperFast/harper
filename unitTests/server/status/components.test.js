const assert = require('node:assert');
const status = require('#src/server/status/index');
const { statusForComponent, reset } = require('#src/components/status/index');

describe('get_status components opt-in', function () {
	afterEach(() => reset());

	it('omits both tree fields unless components is exactly true', async function () {
		statusForComponent('opt-in.service').warning('Service degraded');
		for (const request of [{}, { components: false }, { components: 'true' }, { components: 1 }]) {
			const result = await status.get(request);
			assert.ok(!('components' in result));
			assert.ok(!('hierarchy' in result));
			assert.ok(result.componentStatus.some((entry) => entry.name === 'opt-in.service'));
		}
	});

	it('includes a tree with parent rollups while keeping the flat component list', async function () {
		statusForComponent('opt-in.healthy').healthy('Ready');
		statusForComponent('opt-in.failed').error('Unavailable');
		const result = await status.get({ components: true });
		assert.ok(!('hierarchy' in result));
		assert.equal(result.components['opt-in'].status, 'error');
		assert.equal(result.components['opt-in'].children.healthy.status, 'healthy');
		assert.equal(result.components['opt-in'].children.failed.message, 'Unavailable');
		const flat = result.componentStatus.find((entry) => entry.name === 'opt-in.failed');
		assert.equal(flat.status, result.components['opt-in'].children.failed.status);
		assert.deepEqual(flat.lastChecked, result.components['opt-in'].children.failed.lastChecked);
	});

	it('allows components and middleware to be requested independently or together', async function () {
		const components = await status.get({ components: true });
		assert.ok(!('middlewareChains' in components));
		const middleware = await status.get({ middleware: true });
		assert.ok(!('components' in middleware));
		const both = await status.get({ components: true, middleware: true });
		assert.ok('components' in both);
		assert.ok('middlewareChains' in both);
	});

	it('keeps id lookups as stored records even with opt-in flags', async function () {
		try {
			await status.set({ id: 'maintenance', status: 'Testing' });
			const result = await status.get({ id: 'maintenance', components: true, middleware: true });
			assert.equal(result.id, 'maintenance');
			assert.equal(result.status, 'Testing');
			assert.ok(!('components' in result));
			assert.ok(!('hierarchy' in result));
			assert.ok(!('componentStatus' in result));
			assert.ok(!('middlewareChains' in result));
		} finally {
			await status.clear({ id: 'maintenance' });
		}
	});
});
