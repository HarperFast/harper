'use strict';

const chai = require('chai');
const sinon = require('sinon');
const sinon_chai = require('sinon-chai').default;
const rewire = require('rewire');
chai.use(sinon_chai);
const { expect } = chai;
const hdb_logger = require('#src/utility/logging/harper_logger');
const itc_utils = require('#js/server/threads/itc');

describe('Test itcUtils module', () => {
	const sandbox = sinon.createSandbox();

	before(() => {
		sandbox.stub(hdb_logger, 'warn');
	});

	after(() => {
		sandbox.restore();
	});

	describe('Test validateEvent function', () => {
		it('Test non object error returned', () => {
			const result = itc_utils.validateEvent('message');
			expect(result).to.equal('Invalid ITC event data type, must be an object');
		});

		it('Test missing type error returned', () => {
			const result = itc_utils.validateEvent({ message: 'add user' });
			expect(result).to.equal("ITC event missing 'type'");
		});

		it('Test missing message error returned', () => {
			const result = itc_utils.validateEvent({ type: 'schema' });
			expect(result).to.equal("ITC event missing 'message'");
		});

		it('Test invalid event type error returned', () => {
			const result = itc_utils.validateEvent({ type: 'table', message: { originator: 12345 } });
			expect(result).to.equal('ITC server received invalid event type: table');
		});

		it('Test missing originator error returned', () => {
			const result = itc_utils.validateEvent({ type: 'table', message: { operation: 'create_table' } });
			expect(result).to.equal("ITC event message missing 'originator' property");
		});
	});

	describe('Test sendItcEvent function', () => {
		let itc_rewired;
		let broadcast_stub;

		before(() => {
			itc_rewired = rewire('#js/server/threads/itc');
			broadcast_stub = sinon.stub().resolves();
			itc_rewired.__set__('broadcastWithAcknowledgement', broadcast_stub);
		});

		afterEach(() => {
			broadcast_stub.resetHistory();
		});

		it('sets originator on message when called from main thread', () => {
			const event = { type: 'schema', message: { operation: 'create_schema' } };
			itc_rewired.sendItcEvent(event);
			expect(event.message.originator).to.not.equal(undefined);
			expect(broadcast_stub).to.have.been.calledOnce;
		});

		it('sets originator to threadId regardless of isMainThread value', () => {
			const event = { type: 'schema', message: { operation: 'create_schema' } };
			const { threadId } = require('node:worker_threads');
			itc_rewired.sendItcEvent(event);
			expect(event.message.originator).to.equal(threadId);
		});

		it('does not set originator when message is absent', () => {
			const event = { type: 'schema' };
			itc_rewired.sendItcEvent(event);
			expect(event.originator).to.equal(undefined);
			expect(broadcast_stub).to.have.been.calledOnce;
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
			const result = new itc_utils.SchemaEventMsg(12345, 'create_schema', 'unit', 'test');
			expect(result).to.eql(expected_obj);
		});

		it('Test UserEventMsg', () => {
			const expected_obj = {
				originator: 12345,
			};
			const result = new itc_utils.UserEventMsg(12345);
			expect(result).to.eql(expected_obj);
		});
	});
});
