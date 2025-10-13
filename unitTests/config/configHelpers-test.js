'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { getBackupDirPath } = require('../../config/configHelpers.ts');

describe('configHelpers', function () {
	describe('getBackupDirPath', function () {
		it('should return path to backup directory', function () {
			const hdbRoot = '/test/hdb';
			const result = getBackupDirPath(hdbRoot);

			assert.strictEqual(result, path.join(hdbRoot, 'backup'));
		});

		it('should handle paths with trailing slash', function () {
			const hdbRoot = '/test/hdb/';
			const result = getBackupDirPath(hdbRoot);

			// path.join normalizes the path
			assert.strictEqual(result, path.join('/test/hdb', 'backup'));
		});

		it('should handle relative paths', function () {
			const hdbRoot = './hdb';
			const result = getBackupDirPath(hdbRoot);

			assert.strictEqual(result, path.join('./hdb', 'backup'));
		});

		it('should use BACKUP_DIR_NAME constant from hdbTerms', function () {
			const hdbRoot = '/test/hdb';
			const result = getBackupDirPath(hdbRoot);

			// Should end with 'backup' (the value of BACKUP_DIR_NAME)
			assert.ok(result.endsWith('backup'));
		});
	});
});
