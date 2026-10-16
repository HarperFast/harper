'use strict';

require('../testUtils.js').preTestPrep();
const assert = require('node:assert');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { parse } = require('yaml');
const { configValidator } = require('#src/validation/configValidator');

function validate(limit) {
	const config = parse(readFileSync(resolve(__dirname, '../../static/defaultConfig.yaml'), 'utf8'));
	config.rootPath = resolve(__dirname, '../envDir');
	config.http.readRequestQueueLimit = limit;
	return configValidator(config, true);
}

describe('http.readRequestQueueLimit validation', () => {
	for (const limit of [undefined, null, 0, 60_000]) {
		it(`accepts ${limit}`, () => {
			assert.ifError(validate(limit).error);
		});
	}
	for (const limit of [-1, 0.5, '60s', Infinity]) {
		it(`rejects ${limit}`, () => {
			const { error } = validate(limit);
			assert(error?.details.some((detail) => detail.path.join('.') === 'http.readRequestQueueLimit'));
		});
	}
});
