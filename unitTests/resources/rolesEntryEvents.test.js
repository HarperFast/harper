'use strict';

const assert = require('node:assert');
const { handleApplication } = require('#src/resources/roles');
const { waitFor } = require('../waitFor.js');

function testScope(warnings = []) {
	let handler;
	const listeners = new Map();
	return {
		scope: {
			handleEntry(entryHandler) {
				handler = entryHandler;
				return { ready: Promise.resolve() };
			},
			on(event, listener) {
				listeners.set(event, listener);
			},
			logger: { warn: (message) => warnings.push(message), error() {} },
		},
		get handler() {
			return handler;
		},
		fire(event) {
			listeners.get(event)?.();
		},
	};
}

describe('roles entry events', () => {
	it('ignores directory and unlink events without reading file contents', async () => {
		const harness = testScope();
		handleApplication(harness.scope, async () => {});

		await assert.doesNotReject(() => harness.handler({ entryType: 'directory', eventType: 'addDir' }));
		await assert.doesNotReject(() => harness.handler({ entryType: 'directory', eventType: 'unlinkDir' }));
		await assert.doesNotReject(() => harness.handler({ entryType: 'file', eventType: 'unlink' }));
	});

	it('warns when a declared role disappears without revoking its grants', async () => {
		const warnings = [];
		const harness = testScope(warnings);
		handleApplication(harness.scope, async () => {});

		const absolutePath = '/app/roles.yaml';
		await harness.handler({
			entryType: 'file',
			eventType: 'add',
			absolutePath,
			contents: Buffer.from('reporter:\n  access: none\n'),
		});
		await harness.handler({ entryType: 'file', eventType: 'unlink', absolutePath });

		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /reporter/);
		assert.match(warnings[0], /remain active/);
	});

	it('reconciles unchanged declared roles after deploy', async () => {
		const harness = testScope();
		const ensured = [];
		handleApplication(harness.scope, async (role) => ensured.push(role.role));

		await harness.handler({
			entryType: 'file',
			eventType: 'add',
			absolutePath: '/app/roles.yaml',
			contents: Buffer.from('reporter:\n  access: none\n'),
		});
		harness.fire('deploy:end');
		await waitFor(() => ensured.length === 2);

		assert.deepEqual(ensured, ['reporter', 'reporter']);
	});

	it('serializes a live role change behind deploy reconciliation', async () => {
		const harness = testScope();
		const applied = [];
		let releaseReconcile;
		const reconcileBlocked = new Promise((resolve) => (releaseReconcile = resolve));
		handleApplication(harness.scope, async (role) => {
			applied.push(role.access);
			if (applied.length === 2) await reconcileBlocked;
		});

		const absolutePath = '/app/roles.yaml';
		await harness.handler({
			entryType: 'file',
			eventType: 'add',
			absolutePath,
			contents: Buffer.from('reporter:\n  access: none\n'),
		});
		harness.fire('deploy:end');
		await waitFor(() => applied.length === 2);
		const change = harness.handler({
			entryType: 'file',
			eventType: 'change',
			absolutePath,
			contents: Buffer.from('reporter:\n  access: super_user\n'),
		});
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(applied, ['none', 'none']);

		releaseReconcile();
		await change;
		assert.deepEqual(applied, ['none', 'none', 'super_user']);
	});
});
