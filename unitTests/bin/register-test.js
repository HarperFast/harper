'use strict';

const chai = require('chai');
const sinon = require('sinon');
const expect = chai.expect;
const register = require('../../bin/register');
const registration_handler = require('../../utility/registration/registrationHandler');
const logger = require('../../utility/logging/harper_logger');

describe('Test register module', () => {
	const sandbox = sinon.createSandbox();
	let reg_handler_stub;
	let logger_err_stub;

	before(() => {
		reg_handler_stub = sandbox.stub(registration_handler, 'register');
		logger_err_stub = sandbox.stub(logger, 'error');
	});

	beforeEach(() => {
		sandbox.resetHistory();
	});

	after(() => {
		sandbox.restore();
	});

	it('Test reg handler is called and response is returned happy path', async () => {
		reg_handler_stub.resolves('Registration test successful');
		const result = await register.register();

		expect(result).to.equal('Registration test successful');
		expect(reg_handler_stub.calledOnce).to.be.true;
	});

	it('Test error null result from reg handler has default msg returned', async () => {
		reg_handler_stub.resolves(null);
		const result = await register.register();

		expect(result).to.equal('Registration failed.');
		expect(reg_handler_stub.calledOnce).to.be.true;
	});

	it('Test error from reg handler is caught and logged', async () => {
		reg_handler_stub.throws(new Error('Test reg error'));
		const result = await register.register();

		expect(result).to.equal('Registration failed.');
		expect(logger_err_stub.args[0][0]).to.equal('Registration error Error: Test reg error');
	});
});
