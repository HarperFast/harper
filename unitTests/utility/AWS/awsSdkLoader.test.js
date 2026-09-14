'use strict';

const chai = require('chai');
const { expect } = chai;
const { requireAwsSdk, MissingAwsSdkError } = require('#js/utility/AWS/awsSdkLoader');

const MISSING_SDK_MESSAGE =
	'S3 export/import requires the optional AWS SDK — npm install @aws-sdk/client-s3 @aws-sdk/lib-storage';

function moduleNotFoundError(moduleName, requireStack) {
	const err = new Error(`Cannot find module '${moduleName}'\nRequire stack:\n${requireStack.join('\n')}`);
	err.code = 'MODULE_NOT_FOUND';
	return err;
}

describe('Test awsSdkLoader module', () => {
	it('returns the module on success', () => {
		const fakeModule = { S3: class {} };
		const fakeRequire = () => fakeModule;
		expect(requireAwsSdk('@aws-sdk/client-s3', fakeRequire)).to.equal(fakeModule);
	});

	it('throws MissingAwsSdkError with the actionable message when @aws-sdk/client-s3 is missing', () => {
		const fakeRequire = () => {
			throw moduleNotFoundError('@aws-sdk/client-s3', ['/app/utility/AWS/AWSConnector.js']);
		};
		try {
			requireAwsSdk('@aws-sdk/client-s3', fakeRequire);
			expect.fail('expected requireAwsSdk to throw');
		} catch (err) {
			expect(err).to.be.instanceOf(MissingAwsSdkError);
			expect(err.message).to.equal(MISSING_SDK_MESSAGE);
			expect(err.statusCode).to.equal(501);
		}
	});

	it('throws MissingAwsSdkError with the actionable message when @aws-sdk/lib-storage is missing', () => {
		const fakeRequire = () => {
			throw moduleNotFoundError('@aws-sdk/lib-storage', ['/app/dataLayer/export.js']);
		};
		try {
			requireAwsSdk('@aws-sdk/lib-storage', fakeRequire);
			expect.fail('expected requireAwsSdk to throw');
		} catch (err) {
			expect(err).to.be.instanceOf(MissingAwsSdkError);
			expect(err.message).to.equal(MISSING_SDK_MESSAGE);
			expect(err.statusCode).to.equal(501);
		}
	});

	it('propagates a missing transitive dependency untouched, not masquerading as the top-level package', () => {
		// A missing @smithy/core (a client-s3 dependency) surfaces a require stack that mentions
		// client-s3, but the "Cannot find module" name itself is @smithy/core -- this must not be
		// mistaken for client-s3 itself being absent.
		const transitiveErr = moduleNotFoundError('@smithy/core', [
			'/app/node_modules/@aws-sdk/client-s3/dist-cjs/index.js',
			'/app/utility/AWS/AWSConnector.js',
		]);
		const fakeRequire = () => {
			throw transitiveErr;
		};
		try {
			requireAwsSdk('@aws-sdk/client-s3', fakeRequire);
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
			requireAwsSdk('@aws-sdk/client-s3', fakeRequire);
			expect.fail('expected requireAwsSdk to throw');
		} catch (err) {
			expect(err).to.equal(originalErr);
		}
	});
});
