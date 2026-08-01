'use strict';

const assert = require('node:assert');
const rewire = require('rewire');

const roles = rewire('#src/resources/roles');
roles.__set__('ensureRole', async () => {});
const { handleApplication } = roles;

describe('roles entry events', () => {
	it('ignores directory and unlink events without reading file contents', async () => {
		let handler;
		handleApplication({
			handleEntry(entryHandler) {
				handler = entryHandler;
			},
		});

		await assert.doesNotReject(() => handler({ entryType: 'directory', eventType: 'addDir' }));
		await assert.doesNotReject(() => handler({ entryType: 'directory', eventType: 'unlinkDir' }));
		await assert.doesNotReject(() => handler({ entryType: 'file', eventType: 'unlink' }));
	});

	it('warns when a declared role disappears without revoking its grants', async () => {
		let handler;
		const warnings = [];
		handleApplication({
			handleEntry(entryHandler) {
				handler = entryHandler;
			},
			logger: { warn: (message) => warnings.push(message) },
		});

		const absolutePath = '/app/roles.yaml';
		await handler({
			entryType: 'file',
			eventType: 'add',
			absolutePath,
			contents: Buffer.from('reporter:\n  access: none\n'),
		});
		await handler({ entryType: 'file', eventType: 'unlink', absolutePath });

		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /reporter/);
		assert.match(warnings[0], /remain active/);
	});
});
