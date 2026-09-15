'use strict';

const chai = require('chai');
const { expect } = chai;
const fs = require('fs');
const os = require('os');
const path = require('path');
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
		expect(requireAwsSdk('@aws-sdk/client-s3', fakeRequire, null)).to.equal(fakeModule);
	});

	it('throws MissingAwsSdkError with the actionable message when @aws-sdk/client-s3 is missing and no rootPath is configured', () => {
		const fakeRequire = () => {
			throw moduleNotFoundError('@aws-sdk/client-s3', ['/app/utility/AWS/AWSConnector.js']);
		};
		try {
			requireAwsSdk('@aws-sdk/client-s3', fakeRequire, null);
			expect.fail('expected requireAwsSdk to throw');
		} catch (err) {
			expect(err).to.be.instanceOf(MissingAwsSdkError);
			expect(err.message).to.equal(MISSING_SDK_MESSAGE);
			expect(err.statusCode).to.equal(501);
		}
	});

	it('throws MissingAwsSdkError with the actionable message when @aws-sdk/lib-storage is missing and no rootPath is configured', () => {
		const fakeRequire = () => {
			throw moduleNotFoundError('@aws-sdk/lib-storage', ['/app/dataLayer/export.js']);
		};
		try {
			requireAwsSdk('@aws-sdk/lib-storage', fakeRequire, null);
			expect.fail('expected requireAwsSdk to throw');
		} catch (err) {
			expect(err).to.be.instanceOf(MissingAwsSdkError);
			expect(err.message).to.equal(MISSING_SDK_MESSAGE);
			expect(err.statusCode).to.equal(501);
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
			expect.fail('expected requireAwsSdk to throw');
		} catch (err) {
			expect(err).to.equal(transitiveErr);
			expect(err).to.not.be.instanceOf(MissingAwsSdkError);
		}
	});

	it('propagates unrelated errors untouched', () => {
		const originalErr = new Error('boom');
		const fakeRequire = () => {
			throw originalErr;
		};
		try {
			requireAwsSdk('@aws-sdk/client-s3', fakeRequire, null);
			expect.fail('expected requireAwsSdk to throw');
		} catch (err) {
			expect(err).to.equal(originalErr);
		}
	});

	it('falls back to a require anchored at the Harper rootPath when the default require cannot find the package', () => {
		const fakeRequire = () => {
			throw moduleNotFoundError('@aws-sdk/client-s3', ['/app/utility/AWS/AWSConnector.js']);
		};
		const fakeModule = { S3: class {} };
		const resolveRootRequire = (rootPath) => {
			expect(rootPath).to.equal('/home/harperdb/harper');
			return (pkg) => {
				expect(pkg).to.equal('@aws-sdk/client-s3');
				return fakeModule;
			};
		};
		const result = requireAwsSdk('@aws-sdk/client-s3', fakeRequire, '/home/harperdb/harper', resolveRootRequire);
		expect(result).to.equal(fakeModule);
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
			expect.fail('expected requireAwsSdk to throw');
		} catch (err) {
			expect(err).to.be.instanceOf(MissingAwsSdkError);
			expect(err.statusCode).to.equal(501);
			expect(err.message).to.include('/home/harperdb/harper');
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
			expect.fail('expected requireAwsSdk to throw');
		} catch (err) {
			expect(err).to.equal(transitiveErr);
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
			expect(result).to.have.property('S3');
		} finally {
			fs.rmSync(rootPath, { recursive: true, force: true });
		}
	});
});
