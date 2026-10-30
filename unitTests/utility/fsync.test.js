'use strict';

const assert = require('node:assert');
const { closeSync, openSync } = require('node:fs');
const { fsyncTolerantSync, isUnsupportedSyncError } = require('#src/utility/fsync');

describe('portable fsync', function () {
	it('recognizes only platform and filesystem limitations as unsupported', function () {
		for (const code of ['EPERM', 'EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EBADF', 'EISDIR']) {
			assert.strictEqual(isUnsupportedSyncError(Object.assign(new Error(code), { code })), true);
		}
		for (const code of ['EIO', 'ENOSPC']) {
			assert.strictEqual(isUnsupportedSyncError(Object.assign(new Error(code), { code })), false);
		}
	});

	it('tolerates a handle the platform cannot flush', function () {
		const fd = openSync(__filename, 'r');
		closeSync(fd);
		assert.doesNotThrow(() => fsyncTolerantSync(fd));
	});
});
