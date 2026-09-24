'use strict';

const chai = require('chai');
const { expect } = chai;
const ipc_utils = require('#js/server/threads/itc');

describe('Test ipcUtils module', () => {
	describe('Test validateEvent function', () => {
		it('Test non object error returned', () => {
			const result = ipc_utils.validateEvent('message');
			expect(result).to.equal('Invalid ITC event data type, must be an object');
		});

		it('Test missing type error returned', () => {
			const result = ipc_utils.validateEvent({ message: 'add user' });
			expect(result).to.equal("ITC event missing 'type'");
		});

		it('Test missing message error returned', () => {
			const result = ipc_utils.validateEvent({ type: 'schema' });
			expect(result).to.equal("ITC event missing 'message'");
		});

		it('Test invalid event type error returned', () => {
			const result = ipc_utils.validateEvent({ type: 'table', message: { originator: 12345 } });
			expect(result).to.equal('ITC server received invalid event type: table');
		});

		it('Test missing originator error returned', () => {
			const result = ipc_utils.validateEvent({ type: 'table', message: { operation: 'create_table' } });
			expect(result).to.equal("ITC event message missing 'originator' property");
		});
	});

	describe('Test constructor functions', () => {
		it('Test SchemaEventMsg', () => {
			const expected_obj = {
				attribute: undefined,
				operation: 'create_schema',
				originator: 12345,
				schema: 'unit',
				table: 'test',
			};
			const result = new ipc_utils.SchemaEventMsg(12345, 'create_schema', 'unit', 'test');
			expect(result).to.eql(expected_obj);
		});
	});
});
