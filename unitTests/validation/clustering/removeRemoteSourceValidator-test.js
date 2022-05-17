'use strict';

const chai = require('chai');
const { expect } = chai;
const removeRemoteSourceValidator = require('../../../validation/clustering/removeRemoteSourceValidator');

describe('Test removeRemoteSourceValidator module', () => {
	it('Test validator returns two errors', () => {
		const result = removeRemoteSourceValidator({
			operation: 'remove_name',
		});

		expect(result.message).to.equal("'operation' must be [remove_node]. 'node_name' is required");
	});
});
