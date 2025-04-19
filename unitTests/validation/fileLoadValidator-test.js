'use strict';
const test_util = require('../test_utils');
test_util.preTestPrep();

const chai = require('chai');
const sinon = require('sinon');
const sinon_chai = require('sinon-chai');
const { expect } = chai;
chai.use(sinon_chai);
const fs = require('fs');
const rewire = require('rewire');
const validator = require('../../validation/validationWrapper');
let file_load_validator = rewire('../../validation/fileLoadValidator');
const common_utils = require('../../utility/common_utils');
const log = require('../../utility/logging/harper_logger');
const { getDatabases } = require('../../resources/databases');

const FAKE_FILE_PATH = '/thisfilepath/wont/exist.csv';
const LONG_STRING =
	'TheresolvedtechnologydisappearsThesynthesisperfectsanincompetenceTheprerequisiteremedypurchasesthe' +
	'reasonableantiqueThespeakerrainsdownupontheenergyoveranobtainablerainbowAdownhilltablestheauntTheintermediateoxygen' +
	'concedesthestrayThestandardsectcautionstheeaterThefootballfreezesbehindareceipt';

/**
 *  Unit tests for validation/fileLoadValidator.js
 */
describe('Test fileLoadValidator module', () => {
	let obj_no_schema = {
		operation: 'csv_data_load',
		action: 'insert',
		table: 'fordogs',
		data: 'id, type\n1, English Pointer\n',
	};

	let obj_no_table = {
		operation: '',
		action: 'insert',
		schema: 'hats',
		data: 'id, type\n1, English Pointer\n',
	};

	let obj_invalid_char_table = {
		operation: '',
		action: 'insert',
		schema: 'hats',
		table: '/fordogs',
		data: 'id, type\n1, English Pointer\n',
	};

	let obj_invalid_char_schema = {
		operation: '',
		action: 'insert',
		schema: 'h`a`ts',
		table: 'fordogs',
		data: 'id, type\n1, English Pointer\n',
	};

	let obj_over_length_table = {
		operation: 'csv_data_load',
		action: 'insert',
		schema: 'hats',
		table: LONG_STRING,
		data: 'id, type\n1, English Pointer\n',
	};

	let obj_over_length_schema = {
		operation: 'csv_data_load',
		action: 'insert',
		schema: LONG_STRING,
		table: 'fordogs',
		data: 'id, type\n1, English Pointer\n',
	};

	let obj_wrong_action = {
		operation: 'csv_data_load',
		action: 'drop',
		schema: 'hats',
		table: 'fordogs',
		data: 'id, type\n1, English Pointer\n',
	};

	let data_object = {
		operation: 'csv_data_load',
		action: 'insert',
		schema: 'hats',
		table: 'fordogs',
		data: 'id, type\n1, English Pointer\n',
	};

	let file_object = {
		operation: 'csv_file_load',
		action: 'insert',
		schema: 'hats',
		table: 'fordogs',
		file_path: FAKE_FILE_PATH,
	};

	let url_object = {
		operation: 'csv_file_load',
		action: 'insert',
		schema: 'hats',
		table: 'fordogs',
		csv_url: 'google.com',
	};

	let s3_object = {
		operation: 'import_from_s3',
		action: 'insert',
		schema: 'hats',
		table: 'fordogs',
		s3: {
			aws_access_key_id: '12345key',
			aws_secret_access_key: '54321key',
			bucket: 'test_bucket',
			key: 'test_file.csv',
			region: 'us-east-2',
		},
	};

	before(() => {
		global.hdb_schema = {
			hats: {},
		};
	});

	after(() => {
		delete global.hdb_schema['hats'];
		file_load_validator = rewire('../../validation/fileLoadValidator');
		sinon.restore();
	});

	beforeEach(() => {
		sinon.resetHistory();
	});

	/**
	 * Unit tests for validate module
	 */
	context('Test validate module', () => {
		it('should return table cant be blank error from dataObject', () => {
			let result = file_load_validator.dataObject(obj_no_table);

			expect(result).to.be.instanceof(Error);
			expect(result.message).to.equal("Table can't be blank");
		});

		it('should return must be alpha numeric error on table', () => {
			global.hdb_schema = {
				hats: {
					fordogs: {},
				},
			};
			let result = file_load_validator.dataObject(obj_invalid_char_table);

			expect(result).to.be.instanceof(Error);
			expect(result.message).to.equal('Table names cannot include backticks or forward slashes');
		});

		it('should return must be alpha numeric error on schema', () => {
			let result = file_load_validator.dataObject(obj_invalid_char_schema);

			expect(result).to.be.instanceof(Error);
			expect(result.message).to.equal('Schema names cannot include backticks or forward slashes');
		});

		it('should return cannot exceed 250 characters error on schema', () => {
			let result = file_load_validator.dataObject(obj_over_length_schema);

			expect(result).to.be.instanceof(Error);
			expect(result.message).to.equal('Schema cannot exceed 250 characters');
		});

		it('should return cannot exceed 250 characters error on table', () => {
			let result = file_load_validator.dataObject(obj_over_length_table);

			expect(result).to.be.instanceof(Error);
			expect(result.message).to.equal('Table cannot exceed 250 characters');
		});

		it('should return action is required to be be either insert, update or upsert', () => {
			let result = file_load_validator.dataObject(obj_wrong_action);

			expect(result).to.be.instanceof(Error);
			expect(result.message).to.equal('Action is required and must be either insert, update, or upsert');
		});

		it('should return s3 cant be blank error from s3FileObject', () => {
			const test_obj = test_util.deepClone(s3_object);
			delete test_obj.s3;
			let result = file_load_validator.s3FileObject(test_obj);

			expect(result).to.be.instanceof(Error);
			expect(result.message).to.equal(
				"S3 can't be blank,S3 aws access key id can't be blank,S3 aws secret access key can't be blank,S3 bucket can't be blank,S3 key can't be blank,S3 region can't be blank"
			);
		});

		it('should return s3.aws_access_key_id must be a string error from s3FileObject', () => {
			const test_obj = test_util.deepClone(s3_object);
			test_obj.s3.aws_access_key_id = 123456;
			let result = file_load_validator.s3FileObject(test_obj);

			expect(result).to.be.instanceof(Error);
			expect(result.message).to.equal("S3 aws access key id  must be a 'String' value");
		});

		it('should return s3.key cant be blank error from s3FileObject', () => {
			const test_obj = test_util.deepClone(s3_object);
			test_obj.s3.key = '';
			let result = file_load_validator.s3FileObject(test_obj);

			expect(result).to.be.instanceof(Error);
			expect(result.message).to.equal("S3 key can't be blank");
		});

		it('should return s3.key must have valid ext error from s3FileObject', () => {
			const test_obj = test_util.deepClone(s3_object);
			test_obj.s3.key = 'test_file';
			let result = file_load_validator.s3FileObject(test_obj);

			expect(result).to.be.instanceof(Error);
			expect(result.message).to.equal(
				"S3 key must include one of the following valid file extensions - '.csv', '.json'"
			);
		});

		it('should return null w/ valid s3FileObject', () => {
			getDatabases().hats = {
				fordogs: {},
			};
			const test_obj = test_util.deepClone(s3_object);
			let result = file_load_validator.s3FileObject(test_obj);

			expect(result).to.be.null;
		});

		it('should return validate `presence` error but NOT `type` error if both issues are caught', () => {
			global.hdb_schema = {
				hats: {
					fordogs: {},
				},
			};
			const test_obj = test_util.deepClone(s3_object);
			delete test_obj.s3.aws_access_key_id;
			let result = file_load_validator.s3FileObject(test_obj);

			expect(result).to.be.instanceof(Error);
			expect(result.message).to.equal("S3 aws access key id can't be blank");
		});
	});
	/**
	 * Unit tests for postValidateChecks function
	 */
	context('Test postValidateChecks function', () => {
		let post_validate_checks;
		let validate_result = '';
		let check_glob_schema_stub;
		let file_size_stub;
		let max_csv_file_size_rewire;
		let fs_access_stub;
		let logger_stub;

		before(() => {
			logger_stub = sinon.stub(log, 'error');
			file_size_stub = sinon.stub(fs, 'statSync');
			max_csv_file_size_rewire = file_load_validator.__get__('MAX_FILE_SIZE');
			check_glob_schema_stub = sinon.stub(common_utils, 'checkGlobalSchemaTable');
			post_validate_checks = file_load_validator.__get__('postValidateChecks');
		});

		it('should return an error from common_utils.checkGlobalSchemaTable', () => {
			let check_glob_schema_err = `schema ${data_object.schema} does not exist`;
			check_glob_schema_stub.returns(check_glob_schema_err);
			let result = post_validate_checks(data_object, validate_result);

			expect(result).to.be.instanceOf(Error);
			expect(result.http_resp_msg).to.be.equal(check_glob_schema_err);
			expect(check_glob_schema_stub).to.have.been.calledOnce;
		});

		it('should return an error from accessSync', () => {
			check_glob_schema_stub.returns('');
			let result = post_validate_checks(file_object, validate_result);

			expect(result.http_resp_msg).to.equal(`No such file or directory ${FAKE_FILE_PATH}`);
			expect(result).to.be.instanceOf(Error);
			expect(check_glob_schema_stub).to.have.been.calledOnce;
		});
	});

	/**
	 * Unit tests for dataObject, urlObject and fileObject functions
	 */
	context('Test dataObject, urlObject and fileObject functions', () => {
		let validator_stub;
		let validate_by_schema_stub;
		let post_validate_stub = sinon.stub();
		let post_validate_rewire;
		let validate_res_fake = 'Fake response from validate';

		before(() => {
			validator_stub = sinon.stub(validator, 'validateObject').returns(validate_res_fake);
			validate_by_schema_stub = sinon.stub(validator, 'validateBySchema').returns(validate_res_fake);
			post_validate_rewire = file_load_validator.__set__('postValidateChecks', post_validate_stub);
		});

		after(() => {
			post_validate_rewire();
			validator_stub.restore();
		});

		it('should call validateObject and postValidateChecks with dataObject', () => {
			let data_constraints = file_load_validator.__get__('dataConstraints');
			file_load_validator.dataObject(data_object);

			expect(validator_stub).to.have.been.calledWith(data_object, data_constraints);
			expect(post_validate_stub).to.have.been.calledWith(data_object, validate_res_fake);
		});

		it('should call validateObject and postValidateChecks with urlObject', () => {
			file_load_validator.urlObject(url_object);
			expect(validate_by_schema_stub.args[0][0]).to.eql(url_object);
			expect(post_validate_stub).to.have.been.calledWith(url_object, validate_res_fake);
		});

		it('should call validateObject and postValidateChecks with fileObject', () => {
			let file_constraints = file_load_validator.__get__('fileConstraints');
			file_load_validator.fileObject(file_object);

			expect(validator_stub).to.have.been.calledWith(file_object, file_constraints);
			expect(post_validate_stub).to.have.been.calledWith(file_object, validate_res_fake);
		});
	});
});
