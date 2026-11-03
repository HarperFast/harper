'use strict';

require('../testUtils.js').preTestPrep();
const assert = require('node:assert');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { parse } = require('yaml');
const { configValidator, effectiveHttpConfigValidator } = require('#src/validation/configValidator');
const { flattenConfig } = require('#src/config/configUtils');

function validate(limit, allowHeaders) {
	const config = parse(readFileSync(resolve(__dirname, '../../static/defaultConfig.yaml'), 'utf8'));
	config.rootPath = resolve(__dirname, '../envDir');
	config.http.readRequestQueueLimit = limit;
	config.http.corsAccessControlAllowHeaders = allowHeaders;
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
});

describe('effective HTTP admission configuration', () => {
	const effectiveError = (config) => effectiveHttpConfigValidator(flattenConfig(config)).error;
	for (const [label, config] of [
		[
			'a customFunctions.network allow-headers override',
			{ http: {}, customFunctions: { network: { corsAccessControlAllowHeaders: 'Accept\nInjected: value' } } },
		],
		['a lowercase allow-headers spelling', { http: { corsaccesscontrolallowheaders: 'Accept\nInjected: value' } }],
		[
			'a customFunctions.network read limit override',
			{ http: { readRequestQueueLimit: 1 }, customFunctions: { network: { readRequestQueueLimit: '60s' } } },
		],
		['a lowercase read limit spelling', { http: { readrequestqueuelimit: '60s' } }],
	]) {
		it(`rejects ${label}, which listeners read as http`, () => {
			assert(effectiveError(config));
		});
	}
	it('accepts valid legacy overrides and an unrelated legacy access-list string', () => {
		assert.ifError(
			effectiveError({
				http: { readRequestQueueLimit: 1 },
				customFunctions: {
					network: {
						corsAccessControlAllowHeaders: ['Accept'],
						readRequestQueueLimit: false,
						corsAccessList: 'https://a.example',
					},
				},
			})
		);
	});
});
