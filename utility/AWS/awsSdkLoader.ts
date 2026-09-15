'use strict';

import { createRequire } from 'node:module';
import * as path from 'node:path';
import { ServerError } from '../errors/hdbError.ts';
import { getHdbBasePath } from '../environment/environmentManager.ts';

type RequireLike = (id: string) => any;

const OPTIONAL_S3_PACKAGES = new Set(['@aws-sdk/client-s3', '@aws-sdk/lib-storage']);

export class MissingAwsSdkError extends ServerError {
	constructor(message: string) {
		super(message, 501);
		this.name = 'MissingAwsSdkError';
	}
}

function missingModuleName(err: any): string | undefined {
	if (!err || err.code !== 'MODULE_NOT_FOUND') return undefined;
	const match = /^Cannot find module '([^']+)'/.exec(String(err.message));
	return match ? match[1] : undefined;
}

function missingSdkMessage(rootPath: string | null | undefined): string {
	const where = rootPath ? `in the Harper instance root (${rootPath})` : 'in the Harper instance root';
	return `S3 export/import requires the optional AWS SDK — npm install @aws-sdk/client-s3 @aws-sdk/lib-storage ${where}, or alongside Harper globally`;
}

function defaultResolveRootRequire(rootPath: string): RequireLike {
	return createRequire(path.join(rootPath, 'package.json'));
}

export function requireAwsSdk(
	packageName: string,
	requireFn: RequireLike = require,
	rootPath: string | null | undefined = getHdbBasePath(),
	resolveRootRequire: (rootPath: string) => RequireLike = defaultResolveRootRequire
): any {
	try {
		return requireFn(packageName);
	} catch (err: any) {
		const missing = missingModuleName(err);
		if (!missing || !OPTIONAL_S3_PACKAGES.has(missing)) throw err;
		if (rootPath) {
			try {
				return resolveRootRequire(rootPath)(packageName);
			} catch (rootErr: any) {
				const rootMissing = missingModuleName(rootErr);
				if (!rootMissing || !OPTIONAL_S3_PACKAGES.has(rootMissing)) throw rootErr;
			}
		}
		throw new MissingAwsSdkError(missingSdkMessage(rootPath));
	}
}
