'use strict';

const { createRequire } = require('node:module');
const path = require('node:path');
const { ServerError } = require('../errors/hdbError.ts');
const { getHdbBasePath } = require('../environment/environmentManager.ts');

const OPTIONAL_S3_PACKAGES = new Set(['@aws-sdk/client-s3', '@aws-sdk/lib-storage']);

class MissingAwsSdkError extends ServerError {
	constructor(message) {
		super(message, 501);
		this.name = 'MissingAwsSdkError';
	}
}

function missingModuleName(err) {
	if (!err || err.code !== 'MODULE_NOT_FOUND') return null;
	const match = /^Cannot find module '([^']+)'/.exec(String(err.message));
	return match ? match[1] : null;
}

function missingSdkMessage(rootPath) {
	const where = rootPath ? `in the Harper instance root (${rootPath})` : 'in the Harper instance root';
	return `S3 export/import requires the optional AWS SDK — npm install @aws-sdk/client-s3 @aws-sdk/lib-storage ${where}, or alongside Harper globally`;
}

function defaultResolveRootRequire(rootPath) {
	return createRequire(path.join(rootPath, 'package.json'));
}

function requireAwsSdk(
	packageName,
	requireFn = require,
	rootPath = getHdbBasePath(),
	resolveRootRequire = defaultResolveRootRequire
) {
	try {
		return requireFn(packageName);
	} catch (err) {
		if (!OPTIONAL_S3_PACKAGES.has(missingModuleName(err))) throw err;
		if (rootPath) {
			try {
				return resolveRootRequire(rootPath)(packageName);
			} catch (rootErr) {
				if (!OPTIONAL_S3_PACKAGES.has(missingModuleName(rootErr))) throw rootErr;
			}
		}
		throw new MissingAwsSdkError(missingSdkMessage(rootPath));
	}
}

module.exports = { requireAwsSdk, MissingAwsSdkError };
