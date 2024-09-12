'use strict';

const chai = require('chai');
const sinon = require('sinon');
const sinon_chai = require('sinon-chai');
const { expect } = chai;
chai.use(sinon_chai);

const rewire = require('rewire');
let validationWrapper_rw = rewire('../../validation/validationWrapper');

/**
 *  Unit tests for validation/validationWrapper.js
 */
describe('Test validateWrapper module', () => {
	let validate_stub;
	let validate_async_stub;
	let sandbox;

	before(() => {
		sandbox = sinon.createSandbox();
	});

	afterEach(() => {
		sandbox.reset();
	});

	after(() => {
		rewire('../../validation/validationWrapper');
	});

	describe('Test validateObject function', () => {
		before(() => {
			validate_stub = sandbox.stub().returns();
			validationWrapper_rw.__set__('validate', validate_stub);
		});
		it('should return error when validate object is undefined', () => {
			let result = validationWrapper_rw.validateObject(null, {});

			expect(result).to.be.instanceof(Error);
			expect(result.message).to.equal('validateObject parameters were null');
		});

		it('should return error when constraints object is undefined', () => {
			let result = validationWrapper_rw.validateObject({}, null);

			expect(result).to.be.instanceof(Error);
			expect(result.message).to.equal('validateObject parameters were null');
		});

		it('should return null if nothing returned from validate method', () => {
			let result = validationWrapper_rw.validateObject({}, {});

			expect(result).to.be.null;
		});

		it('should return validation message as error from validate method', () => {
			const test_err_msg = 'This is an error msg!';
			validate_stub.returns(test_err_msg);
			let result = validationWrapper_rw.validateObject({}, {});

			expect(result).to.be.instanceof(Error);
			expect(result.message).to.equal(test_err_msg);
		});
	});

	describe('Test validateObjectAsync function', () => {
		before(() => {
			validationWrapper_rw = rewire('../../validation/validationWrapper');
			validate_async_stub = sandbox.stub().resolves();
			validationWrapper_rw.__set__('validate', { async: () => validate_async_stub() });
		});

		it('should return error when validate object is undefined', async () => {
			const result = await validationWrapper_rw.validateObjectAsync(null, {});

			expect(result).to.be.instanceof(Error);
			expect(result.message).to.equal('validateObject parameters were null');
		});

		it('should return error when constraints object is undefined', async () => {
			const result = await validationWrapper_rw.validateObjectAsync({}, null);

			expect(result).to.be.instanceof(Error);
			expect(result.message).to.equal('validateObject parameters were null');
		});

		it('should return null if nothing returned from validate method', async () => {
			const result = await validationWrapper_rw.validateObjectAsync({}, {});
			expect(result).to.be.null;
		});

		it('should return validation message as error from validate method', async () => {
			const test_err_msg = ['This is an error msg!'];
			validate_async_stub.throws(test_err_msg);

			const result = await validationWrapper_rw.validateObjectAsync({}, {});

			expect(result).to.be.instanceof(Error);
			expect(result.message).to.equal(test_err_msg[0]);
		});
	});
});
