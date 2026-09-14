'use strict';

const { ServerError } = require('../errors/hdbError.ts');

const MISSING_SDK_MESSAGE =
	'S3 export/import requires the optional AWS SDK — npm install @aws-sdk/client-s3 @aws-sdk/lib-storage';
const OPTIONAL_S3_PACKAGES = new Set(['@aws-sdk/client-s3', '@aws-sdk/lib-storage']);

class MissingAwsSdkError extends ServerError {
	constructor() {
		super(MISSING_SDK_MESSAGE, 501);
		this.name = 'MissingAwsSdkError';
	}
}

function missingModuleName(err) {
	if (!err || err.code !== 'MODULE_NOT_FOUND') return null;
	const match = /^Cannot find module '([^']+)'/.exec(String(err.message));
	return match ? match[1] : null;
}

function requireAwsSdk(packageName, requireFn = require) {
	try {
		return requireFn(packageName);
	} catch (err) {
		if (OPTIONAL_S3_PACKAGES.has(missingModuleName(err))) {
			throw new MissingAwsSdkError();
		}
		throw err;
	}
}

module.exports = { requireAwsSdk, MissingAwsSdkError };
