'use strict';

const chai = require('chai');
const { expect } = chai;
const {
	readTransactionLogValidator,
	deleteTransactionLogsBeforeValidator,
} = require('../../validation/transactionLogValidator');

describe('Test transactionLogValidator', () => {
	it('Test readTransactionLogValidator', () => {
		const bad_req = {
			schema: 1,
			from: '2022/03/1',
			to: new Date().toString(),
		};
		const result = readTransactionLogValidator(bad_req);
		expect(result.message).to.equal(
			"'schema' must be a string. 'table' is required. 'from' must be in timestamp or number of milliseconds format. 'to' must be in timestamp or number of milliseconds format"
		);
	});

	it('Test deleteTransactionLogsBeforeValidator', () => {
		const bad_req = {
			table: true,
			timestamp: 1598290200117000000,
		};
		const result = deleteTransactionLogsBeforeValidator(bad_req);
		expect(result.message).to.equal("'table' must be a string. 'timestamp' must be a valid date");
	});
});
