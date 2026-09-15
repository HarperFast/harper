'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { requireAwsSdk, MissingAwsSdkError } = require('#js/utility/AWS/awsSdkLoader');

const MISSING_SDK_MESSAGE =
	'S3 export/import requires the optional AWS SDK — npm install @aws-sdk/client-s3 @aws-sdk/lib-storage in the Harper instance root, or alongside Harper globally';

function moduleNotFoundError(moduleName, requireStack) {
	const err = new Error(`Cannot find module '${moduleName}'\nRequire stack:\n${requireStack.join('\n')}`);
	err.code = 'MODULE_NOT_FOUND';
	return err;
}

describe('Test awsSdkLoader module', () => {
	it('returns the module on success', () => {
		const fakeModule = { S3: class {} };
		const fakeRequire = () => fakeModule;
		assert.strictEqual(requireAwsSdk('@aws-sdk/client-s3', fakeRequire, null), fakeModule);
	});

	it('throws MissingAwsSdkError with the actionable message when @aws-sdk/client-s3 is missing and no rootPath is configured', () => {
		const fakeRequire = () => {
			throw moduleNotFoundError('@aws-sdk/client-s3', ['/app/utility/AWS/AWSConnector.js']);
		};
		try {
			requireAwsSdk('@aws-sdk/client-s3', fakeRequire, null);
			assert.fail('expected requireAwsSdk to throw');
		} catch (err) {
			assert(err instanceof MissingAwsSdkError);
			assert.strictEqual(err.message, MISSING_SDK_MESSAGE);
			assert.strictEqual(err.statusCode, 501);
		}
	});

	it('throws MissingAwsSdkError with the actionable message when @aws-sdk/lib-storage is missing and no rootPath is configured', () => {
		const fakeRequire = () => {
			throw moduleNotFoundError('@aws-sdk/lib-storage', ['/app/dataLayer/export.js']);
		};
		try {
			requireAwsSdk('@aws-sdk/lib-storage', fakeRequire, null);
			assert.fail('expected requireAwsSdk to throw');
		} catch (err) {
			assert(err instanceof MissingAwsSdkError);
			assert.strictEqual(err.message, MISSING_SDK_MESSAGE);
			assert.strictEqual(err.statusCode, 501);
		}
	});

	it('propagates a missing transitive dependency untouched, not masquerading as the top-level package', () => {
		const transitiveErr = moduleNotFoundError('@smithy/core', [
			'/app/node_modules/@aws-sdk/client-s3/dist-cjs/index.js',
			'/app/utility/AWS/AWSConnector.js',
		]);
		const fakeRequire = () => {
			throw transitiveErr;
		};
		try {
			requireAwsSdk('@aws-sdk/client-s3', fakeRequire, null);
			assert.fail('expected requireAwsSdk to throw');
		} catch (err) {
			assert.strictEqual(err, transitiveErr);
			assert(!(err instanceof MissingAwsSdkError));
		}
	});

	it('propagates unrelated errors untouched', () => {
		const originalErr = new Error('boom');
		const fakeRequire = () => {
			throw originalErr;
		};
		try {
			requireAwsSdk('@aws-sdk/client-s3', fakeRequire, null);
			assert.fail('expected requireAwsSdk to throw');
		} catch (err) {
			assert.strictEqual(err, originalErr);
		}
	});

	it('falls back to a require anchored at the Harper rootPath when the default require cannot find the package', () => {
		const fakeRequire = () => {
			throw moduleNotFoundError('@aws-sdk/client-s3', ['/app/utility/AWS/AWSConnector.js']);
		};
		const fakeModule = { S3: class {} };
		const resolveRootRequire = (rootPath) => {
			assert.strictEqual(rootPath, '/home/harperdb/harper');
			return (pkg) => {
				assert.strictEqual(pkg, '@aws-sdk/client-s3');
				return fakeModule;
			};
		};
		const result = requireAwsSdk('@aws-sdk/client-s3', fakeRequire, '/home/harperdb/harper', resolveRootRequire);
		assert.strictEqual(result, fakeModule);
	});

	it('throws MissingAwsSdkError naming the rootPath when both the default and rootPath-anchored require fail', () => {
		const fakeRequire = () => {
			throw moduleNotFoundError('@aws-sdk/client-s3', ['/app/utility/AWS/AWSConnector.js']);
		};
		const resolveRootRequire = () => () => {
			throw moduleNotFoundError('@aws-sdk/client-s3', ['/home/harperdb/harper/node_modules/@aws-sdk/client-s3']);
		};
		try {
			requireAwsSdk('@aws-sdk/client-s3', fakeRequire, '/home/harperdb/harper', resolveRootRequire);
			assert.fail('expected requireAwsSdk to throw');
		} catch (err) {
			assert(err instanceof MissingAwsSdkError);
			assert.strictEqual(err.statusCode, 501);
			assert(err.message.includes('/home/harperdb/harper'));
		}
	});

	it('propagates a transitive failure from the rootPath-anchored require untouched', () => {
		const fakeRequire = () => {
			throw moduleNotFoundError('@aws-sdk/client-s3', ['/app/utility/AWS/AWSConnector.js']);
		};
		const transitiveErr = moduleNotFoundError('@smithy/core', [
			'/home/harperdb/harper/node_modules/@aws-sdk/client-s3/dist-cjs/index.js',
		]);
		const resolveRootRequire = () => () => {
			throw transitiveErr;
		};
		try {
			requireAwsSdk('@aws-sdk/client-s3', fakeRequire, '/home/harperdb/harper', resolveRootRequire);
			assert.fail('expected requireAwsSdk to throw');
		} catch (err) {
			assert.strictEqual(err, transitiveErr);
		}
	});

	it('resolves a package actually installed at a real Harper rootPath via the default createRequire fallback', () => {
		const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'harper-root-'));
		try {
			const pkgDir = path.join(rootPath, 'node_modules', '@aws-sdk', 'client-s3');
			fs.mkdirSync(pkgDir, { recursive: true });
			fs.writeFileSync(
				path.join(pkgDir, 'package.json'),
				JSON.stringify({ name: '@aws-sdk/client-s3', version: '0.0.0-fixture', main: 'index.js' })
			);
			fs.writeFileSync(path.join(pkgDir, 'index.js'), 'module.exports = { S3: function FakeS3() {} };');

			const fakeRequire = () => {
				throw moduleNotFoundError('@aws-sdk/client-s3', ['/app/utility/AWS/AWSConnector.js']);
			};
			const result = requireAwsSdk('@aws-sdk/client-s3', fakeRequire, rootPath);
			assert.strictEqual(typeof result.S3, 'function');
		} finally {
			fs.rmSync(rootPath, { recursive: true, force: true });
		}
	});
});
