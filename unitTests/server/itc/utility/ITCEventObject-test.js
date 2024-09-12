'use strict';

const chai = require('chai');
const { expect } = chai;
const ITCEventObject = require('../../../../server/itc/utility/ITCEventObject');

describe('Test ITCEventObject class', () => {
	it('Test new ITCEventObject is correct shape', () => {
		const message = {
			operation: 'create_schema',
			schema: 'unit_test',
		};
		const expected_event = {
			type: 'schema',
			message: {
				operation: 'create_schema',
				schema: 'unit_test',
			},
		};
		const itc_event = new ITCEventObject('schema', message);
		expect(itc_event).to.eql(expected_event);
	});
});
