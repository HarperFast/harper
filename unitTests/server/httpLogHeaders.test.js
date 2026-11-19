'use strict';

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const assert = require('assert');

const { headersToString } = require('#src/server/http');

describe('headersToString', () => {
	it('logs credential header values as [REDACTED], whatever their case, and other headers as sent', () => {
		const logged = headersToString({
			'Authorization': 'Basic YWRtaW46c2VjcmV0',
			'proxy-authorization': 'Bearer proxy-secret',
			'COOKIE': 'session=cookie-secret',
			'content-type': 'application/json',
		});
		assert.strictEqual(
			logged,
			'Authorization: [REDACTED], proxy-authorization: [REDACTED], COOKIE: [REDACTED], content-type: application/json'
		);
	});
});
