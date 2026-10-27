'use strict';

require('../testUtils.js').preTestPrep();
const assert = require('node:assert');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { parse } = require('yaml');
const { configValidator } = require('#src/validation/configValidator');

function validate(limit, allowHeaders, legacyAllowHeaders) {
	const config = parse(readFileSync(resolve(__dirname, '../../static/defaultConfig.yaml'), 'utf8'));
	config.rootPath = resolve(__dirname, '../envDir');
	config.http.readRequestQueueLimit = limit;
	config.http.corsAccessControlAllowHeaders = allowHeaders;
	if (legacyAllowHeaders !== undefined)
		config.customFunctions = { network: { corsAccessControlAllowHeaders: legacyAllowHeaders } };
	return configValidator(config, true);
}

describe('http.readRequestQueueLimit validation', () => {
	for (const limit of [undefined, null, false, 0, 60_000]) {
		it(`accepts ${limit}`, () => {
			assert.ifError(validate(limit).error);
		});
	}
	for (const limit of [true, -1, 0.5, 'false', '60000', '60s', Infinity]) {
		it(`rejects ${limit}`, () => {
			const { error } = validate(limit);
			assert(error?.details.some((detail) => detail.path.join('.') === 'http.readRequestQueueLimit'));
		});
	}
});

describe('read queue CORS header configuration', () => {
	for (const value of ['Accept, Content-Type, Authorization', ['Accept', 'Content-Type'], [], '', null, false, 123]) {
		it(`accepts legacy header value ${JSON.stringify(value)}`, () => {
			assert.ifError(validate(undefined, value).error);
		});
	}
	for (const value of [
		'Accept,\nContent-Type',
		'Accept\r\nInjected: value',
		'Accept\0',
		['Accept', 'Injected\nvalue'],
	]) {
		it(`rejects ${JSON.stringify(value)} before serving requests`, () => {
			const { error } = validate(undefined, value);
			assert(error?.details.some((detail) => detail.path.join('.') === 'http.corsAccessControlAllowHeaders'));
		});
	}
	it('rejects an invalid customFunctions.network override, which listeners serve over http', () => {
		const { error } = validate(undefined, 'Accept', 'Accept\nInjected: value');
		assert(
			error?.details.some((detail) => detail.path.join('.') === 'customFunctions.network.corsAccessControlAllowHeaders')
		);
	});
	it('accepts a valid customFunctions.network override', () => {
		assert.ifError(validate(undefined, 'Accept', ['Accept', 'Content-Type']).error);
	});
});
