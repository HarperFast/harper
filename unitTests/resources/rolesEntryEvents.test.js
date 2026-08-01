'use strict';

const assert = require('node:assert');
const { handleApplication } = require('#src/resources/roles');

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
		await new Promise((resolve) => setImmediate(resolve));

		assert.deepEqual(ensured, ['reporter', 'reporter']);
	});
});
