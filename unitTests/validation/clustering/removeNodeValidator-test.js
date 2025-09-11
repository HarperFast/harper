'use strict';

const chai = require('chai');
const { expect } = chai;
const removeNodeValidator = require('../../../validation/clustering/removeNodeValidator');

describe.skip('Test removeNodeValidator module', () => {
	it('Test validator returns three errors', () => {
		const result = removeNodeValidator({
			operation: true,
			node_name: 123,
		});

		expect(result.message).to.equal(
			"'operation' must be [remove_node]. 'operation' must be a string. 'node_name' must be a string"
		);
	});
});
