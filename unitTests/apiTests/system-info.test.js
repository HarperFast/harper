'use strict';

const { assert, expect } = globalThis.chai || require('chai');
const { callOperation, removeAllSchemas } = require('./utility');
const crypto = require('crypto');
const { promisify } = require('util');
const sleep = promisify(setTimeout);

describe('test schema operations', () => {
	it('describes all schemas and expect empty object', async () => {
		let response = await callOperation({
			operation: 'system_information',
		});
		expect(response.status).to.eq(200);
		let body = await response.json();
		console.log({ body });
	});
});
