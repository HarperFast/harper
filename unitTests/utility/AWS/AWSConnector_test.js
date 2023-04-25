'use strict';

const chai = require('chai');
const sinon = require('sinon');
const sinon_chai = require('sinon-chai');
const { expect } = chai;
chai.use(sinon_chai);

const rewire = require('rewire');
let AWSConnector_rw;

const test_s3_obj = {
	s3: {
		aws_access_key_id: '12345key',
		aws_secret_access_key: '54321key',
		bucket: 'test_bucket',
		key: 'test_file.csv',
	},
};

describe('Test AWSConnector module', () => {
	let get_auth_stub;
	let sandbox;

	before(() => {
		sandbox = sinon.createSandbox();
	});

	afterEach(() => {
		sandbox.reset();
	});

	after(() => {
		rewire('../../../utility/AWS/AWSConnector');
	});

	describe('Test getS3AuthObj function', () => {
		let stub_func;
		const auth_success = 'auth success';
		const s3_fail = 'auth fail';

		beforeEach(() => {
			AWSConnector_rw = rewire('../../../utility/AWS/AWSConnector');
		});

		it('should return value from call to new S3 object returned from getS3AuthObj ', async () => {
			stub_func = () => ({
				send: () => {
					return { Body: 'A body' };
				},
			});
			get_auth_stub = sandbox.stub(AWSConnector_rw, 'getS3AuthObj').callsFake(stub_func);
			AWSConnector_rw.__set__('getS3AuthObj', get_auth_stub);

			let result = await AWSConnector_rw.getFileStreamFromS3(test_s3_obj);
			expect(result).to.equal('A body');
		});
	});
});
