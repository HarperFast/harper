'use strict';

const assert = require('node:assert');
const { handleApplication } = require('#src/resources/roles');

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
});
