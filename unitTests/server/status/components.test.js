const assert = require('node:assert');
const status = require('#src/server/status/index');
const { statusForComponent, reset } = require('#src/components/status/index');
const { createLogger } = require('#src/utility/logging/harper_logger');
const { runInNewContext } = require('node:vm');
const fs = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { RecordEncoder } = require('#src/resources/RecordEncoder');
const { pinLogConfig } = require('../../logConfigFixture');
const { waitFor } = require('../../waitFor');

describe('get_status components opt-in', function () {
	afterEach(() => reset());

	it('clears the previous cause when the next same-level report has no error', async function () {
		statusForComponent('opt-in.updated').error('First report', new Error('Old cause'));
		statusForComponent('opt-in.updated').error('Next report');
		const result = await status.get({ components: true });
		const flat = result.componentStatus.find((entry) => entry.name === 'opt-in.updated');
		assert.strictEqual(flat.latestMessage, 'Next report');
		assert.strictEqual(flat.error, undefined);
		assert.strictEqual(result.components['opt-in'].children.updated.error, undefined);
	});

	it('keeps VM error codes and long-URL redaction through the logger bridge and operation', async function () {
		const logger = createLogger({ level: 'error', writeToLog: () => {} });
		const error = runInNewContext('new TypeError("VM failure")');
		logger
			.status({ problem: 'opt-in.bridge' })
			.debug('https://qa-user:synthetic-password-' + 'x'.repeat(600) + '@example.invalid/status', error);
		const result = await status.get({ components: true });
		const flat = result.componentStatus.find((entry) => entry.name === 'opt-in.bridge');
		assert.strictEqual(flat.error, 'TypeError: VM failure');
		assert.strictEqual(result.components['opt-in'].children.bridge.error, flat.error);
		assert.ok(flat.latestMessage.length <= 500);
		assert.ok(!JSON.stringify(result).includes('synthetic-password'));
	});

	it('keeps corrupt record data in the ordinary log and out of status responses', async function () {
		const logRoot = fs.mkdtempSync(join(tmpdir(), 'record-status-'));
		const marker = 'SYNTHETIC_PRIVATE_RECORD';
		const encoder = new RecordEncoder({ structures: [], randomAccessStructure: false });
		const corrupt = Buffer.concat([Buffer.from(encoder.encode(marker)), Buffer.from([0])]);
		const hex = corrupt.subarray(0, 40).toString('hex');
		try {
			const restore = pinLogConfig({ level: 'error', logRoot });
			try {
				assert.strictEqual(encoder.decode(corrupt, { noMetadata: true }), null);
				await waitFor(
					() =>
						fs.existsSync(join(logRoot, 'hdb.log')) && fs.readFileSync(join(logRoot, 'hdb.log'), 'utf8').includes(hex)
				);
			} finally {
				restore();
			}
			const result = await status.get({ components: true });
			const flat = result.componentStatus.find((entry) => entry.name === 'database.record-decode');
			assert.strictEqual(flat.status, 'error');
			assert.strictEqual(flat.error, undefined);
			assert.strictEqual(flat.latestMessage, undefined);
			const wire = JSON.stringify(result);
			assert.ok(!wire.includes(marker));
			assert.ok(!wire.includes(hex));
		} finally {
			try {
				fs.rmSync(logRoot, { recursive: true, force: true });
			} catch {}
		}
	});

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

	it('uses the same wire-safe error in the tree and flat list', async function () {
		const error = new TypeError('Failed https://user:secret@example.com/status');
		error.privateValue = 'must not be serialized';
		statusForComponent('opt-in.wire').error('Unavailable', error);
		const result = await status.get({ components: true });
		const flat = result.componentStatus.find((entry) => entry.name === 'opt-in.wire');
		const tree = result.components['opt-in'].children.wire;
		assert.equal(flat.error, 'TypeError: Failed https://[REDACTED]@example.com/status');
		assert.strictEqual(tree.error, flat.error);
		assert.ok(!JSON.stringify(result.components).includes('user:secret'));
		assert.ok(!JSON.stringify(result.components).includes('privateValue'));
		assert.ok(!JSON.stringify(result).includes('must not be serialized'));
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
