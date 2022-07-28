'use strict';

const test_utils = require('../test_utils');
// try to move to /bin directory so our properties reader doesn't explode.
test_utils.preTestPrep();
const assert = require('assert');
const chai = require('chai');
const { expect } = chai;
const sinon = require('sinon');
const sinon_chai = require('sinon-chai');
chai.use(sinon_chai);
const rewire = require('rewire');
let bulkLoad_rewire = rewire('../../data_layer/bulkLoad');
const PermissionResponseObject = require('../../security/data_objects/PermissionResponseObject');
const hdb_terms = require('../../utility/hdbTerms');
const hdb_utils = require('../../utility/common_utils');
const nats_utils = require('../../server/nats/utility/natsUtils');
const transact_to_clustering_utils = require('../../utility/clustering/transactToClusteringUtilities');
const validator = require('../../validation/fileLoadValidator');
const insert = require('../../data_layer/insert');
const logger = require('../../utility/logging/harper_logger');
const env = require('../../utility/environment/environmentManager');
const path = require('path');
const { EventEmitter } = require('events');
const papa_parse = require('papaparse');
const fs = require('fs-extra');
const { CHECK_LOGS_WRAPPER, TEST_BULK_LOAD_ERROR_MSGS, HTTP_STATUS_CODES, isHDBError } = require('../commonTestErrors');

const VALID_CSV_DATA =
	'id,name,section,country,image\n1,ENGLISH POINTER,British and Irish Pointers and Setters,GREAT BRITAIN,http://www.fci.be/Nomenclature/Illustrations/001g07.jpg\n2,ENGLISH SETTER,British and Irish Pointers and Setters,GREAT BRITAIN,http://www.fci.be/Nomenclature/Illustrations/002g07.jpg\n3,KERRY BLUE TERRIER,Large and medium sized Terriers,IRELAND,\n';
const INVALID_CSV_ID_COLUMN_NAME =
	'id/,name,section,country,image\n1,ENGLISH POINTER,British and Irish Pointers and Setters,GREAT BRITAIN,http://www.fci.be/Nomenclature/Illustrations/001g07.jpg\n2,ENGLISH SETTER,British and Irish Pointers and Setters,GREAT BRITAIN,http://www.fci.be/Nomenclature/Illustrations/002g07.jpg\n3,KERRY BLUE TERRIER,Large and medium sized Terriers,IRELAND,\n';
const VALID_CSV_PATH = '/tmp/csv_input_valid.csv';
const INVALID_CSV_PATH = '/tmp/csv_input_invalid_id.csv';
const EMPTY_FILE_PATH = '/tmp/empty.csv';
const HOSTED_CSV_FILE_URL = 'https://s3.amazonaws.com/complimentarydata/breeds.csv';
const MIDDLEWARE_PARSE_PARAMETERS = 'SELECT * FROM CSV(?, {headers:true, separator:","})';
const CSV_URL_TEMP_DIR = `${env.get('HDB_ROOT')}/tmp`;
const TEMP_CSV_FILE = `tempCSVURLLoad.csv`;
const TEST_DATA_DIR = path.join(process.cwd(), '../', 'test/data');

const BULK_LOAD_RESPONSE = {
	message: 'successfully loaded 3 of 3 records',
	number_written: '3',
	records: '3',
};

const TEST_SUPER_USER = {
	role: {
		permission: {
			super_user: true,
		},
	},
};

const TEST_USER = {
	role: {
		permission: {
			super_user: false,
		},
	},
};

const DATA_LOAD_MESSAGE = {
	hdb_user: TEST_SUPER_USER,
	operation: '',
	schema: 'dev',
	table: 'breed',
	action: 'insert',
	data: '',
};

const CSV_URL_MESSAGE = {
	hdb_user: TEST_SUPER_USER,
	operation: 'csv_url_load',
	action: 'insert',
	schema: 'test',
	table: 'url_load_test',
	csv_url: '',
};

// Used to stub the post function used to send to cluster.
function postCSVLoadFunction_stub(orig_bulk_msg, result, orig_req) {
	return result;
}

async function stubHOC(func, args) {
	const stub_obj = { job_operation_function: func };
	return await callStubFunc(stub_obj, args);
}

async function callStubFunc(obj, args) {
	return await obj.job_operation_function(args);
}

describe('Test bulkLoad.js', () => {
	let call_papaparse_stub;
	let call_papaparse_rewire;
	let test_bulk_load_file_obj = {
		role_perms: TEST_USER.role.permission,
		op: 'file_load',
		action: 'insert',
		schema: 'golden',
		table: 'retriever',
		file_path: 'fake/file/path.csv',
		data: '[{"blah":"blah"}]',
	};

	let json_message_fake = {
		hdb_user: TEST_SUPER_USER,
		operation: 'file_load',
		action: 'insert',
		schema: 'golden',
		table: 'retriever',
		file_path: 'fake/file/path.csv',
		data: '[{"blah":"blah"}]',
	};

	let s3_message_fake = {
		hdb_user: TEST_SUPER_USER,
		operation: 'import_from_s3',
		action: 'insert',
		schema: 'golden',
		table: 'retriever',
		s3: {
			aws_access_key_id: '12345key',
			aws_secret_access_key: '54321key',
			bucket: 'test_bucket',
			key: 'test_file.csv',
		},
	};

	let json_file_msg_fake = {
		hdb_user: TEST_SUPER_USER,
		operation: 'import_from_s3',
		action: 'update',
		schema: 'golden',
		table: 'retriever',
		s3: {
			aws_access_key_id: '12345key',
			aws_secret_access_key: '54321key',
			bucket: 'test_bucket',
			key: 'test_file.csv',
		},
		file_path: 'fake/file/path.json',
		file_type: '.json',
	};

	let results_fake = {
		data: [],
	};

	let data_array_fake = [
		{
			'Column 1': 'foo',
			'Column 2': 'bar',
		},
		{
			'Column 1': 'abc',
			'Column 2': 'def',
		},
	];

	let parser_fake = {
		pause: () => {
			console.info('parser pause');
		},
		resume: () => {
			console.info('parser resume');
		},
	};

	let insert_results_fake = {
		records: 10,
		number_written: 10,
	};

	let expected_insert_results_resp = 'successfully loaded 10 of 10 records';

	let reject_fake = (err) => {
		throw err;
	};

	before(() => {
		env.setProperty(hdb_terms.CONFIG_PARAMS.CLUSTERING_ENABLED, false);
	});

	describe('Test csvDataLoad', function () {
		let sandbox = sinon.createSandbox();

		let test_msg;
		let bulk_file_load_stub;
		let bulk_file_load_rewire;
		let bulk_file_load_stub_orig;
		let verify_attr_perms_stub = sandbox.stub().returns();
		let verify_attr_perms_rw;

		let PermissionResponseObject_rw = bulkLoad_rewire.__get__('PermissionResponseObject');
		const getPerms_orig = PermissionResponseObject_rw.prototype.getPermsResponse;
		const perms_err_msg = 'Perms error msg';
		let get_perms_resp_stub = sandbox.stub().returns(perms_err_msg);

		before(() => {
			bulk_file_load_stub_orig = bulkLoad_rewire.__get__('bulkFileLoad');
			bulk_file_load_stub = sandbox.stub().returns(BULK_LOAD_RESPONSE);
			bulk_file_load_rewire = bulkLoad_rewire.__set__('bulkFileLoad', bulk_file_load_stub);
		});

		beforeEach(function () {
			test_msg = test_utils.deepClone(DATA_LOAD_MESSAGE);
			test_msg.operation = hdb_terms.OPERATIONS_ENUM.csv_data_load;
			test_msg.data = VALID_CSV_DATA;
			sandbox.stub(validator, 'dataObject');
		});

		afterEach(function () {
			sandbox.restore();
			bulk_file_load_rewire = bulkLoad_rewire.__set__('bulkFileLoad', bulk_file_load_stub_orig);
		});

		after(() => {
			bulk_file_load_rewire();
		});

		it('Test csvDataLoad nominal case with valid file and valid column names/data', async function () {
			try {
				let result = await bulkLoad_rewire.csvDataLoad(test_msg);
				assert.equal(result, BULK_LOAD_RESPONSE.message, 'Got incorrect response');
			} catch (e) {
				throw e;
			}
		});

		it('Test csvDataLoad with non-SU role evaluates attr-level perms', async function () {
			verify_attr_perms_rw = bulkLoad_rewire.__set__('verifyBulkLoadAttributePerms', verify_attr_perms_stub);
			bulk_file_load_rewire = bulkLoad_rewire.__set__('bulkFileLoad', bulk_file_load_stub);

			test_msg.hdb_user = TEST_USER;
			await stubHOC(bulkLoad_rewire.csvDataLoad, test_msg);
			assert.equal(verify_attr_perms_stub.calledOnce, true, 'Attr perms were not checked');
			verify_attr_perms_rw();
		});

		it('Test csvDataLoad with attr-level perms issues - returns errors', async function () {
			PermissionResponseObject_rw.prototype.getPermsResponse = () => get_perms_resp_stub();
			const getPermsError_rw = bulkLoad_rewire.__set__('PermissionResponseObject', PermissionResponseObject_rw);
			let result;

			try {
				await bulkLoad_rewire.csvDataLoad(test_msg);
			} catch (err) {
				result = err;
			}

			assert.equal(isHDBError(result), true, 'HDB perms error was not thrown');
			assert.equal(result.message, 'Perms error msg', 'Perms error message was not thrown');
			getPermsError_rw();
			PermissionResponseObject_rw.prototype.getPermsResponse = getPerms_orig;
		});

		it('Test csvDataLoad invalid column names, expect exception', async function () {
			test_msg.data = INVALID_CSV_ID_COLUMN_NAME;
			let response = undefined;
			await bulkLoad_rewire.csvDataLoad(test_msg).catch((e) => {
				response = e;
			});
			assert.ok(response instanceof Error === true, 'Did not get expected exception');
		});

		it('Test csvDataLoad missing data, expect exception', async function () {
			test_msg.data = null;
			let response = undefined;
			await bulkLoad_rewire.csvDataLoad(test_msg).catch((e) => {
				response = e;
			});
			assert.ok(response instanceof Error === true, 'Did not get expected exception');
		});

		it('Test csvDataLoad bad csv data, expect nothing loaded message', async function () {
			test_msg.data = 'a, a a a';
			let response = undefined;
			response = await bulkLoad_rewire.csvDataLoad(test_msg).catch((e) => {
				response = e;
			});
			assert.equal(response, 'No records parsed from csv file.', 'Did not get expected response message');
		});

		it('Test csvDataLoad incomplete csv data, expect nothing loaded message', async function () {
			test_msg.data = 'a, b, c, d\n1,';
			bulk_file_load_stub = sandbox.stub().returns({
				message: 'successfully loaded 1 of 1 records',
				number_written: '1',
				records: '1',
			});
			bulkLoad_rewire.__set__('bulkFileLoad', bulk_file_load_stub);
			let response = undefined;
			response = await bulkLoad_rewire.csvDataLoad(test_msg).catch((e) => {
				response = e;
			});
			assert.equal(response, 'successfully loaded 1 of 1 records', 'Did not get expected response message');
			bulkLoad_rewire.__set__('bulkFileLoad', bulk_file_load_stub_orig);
		});
	});

	describe('Test csvURLLoad function', () => {
		let sandbox = sinon.createSandbox();
		let download_csv_stub = sandbox.stub();
		let remove_dir_stub;
		let success_msg = 'Successfully loaded 77 of 77 records';
		let file_load_stub = sandbox.stub().resolves(success_msg);
		let file_load_orig = bulkLoad_rewire.__get__('fileLoad');

		before(() => {
			bulkLoad_rewire.__set__('downloadCSVFile', download_csv_stub);
			bulkLoad_rewire.__set__('fileLoad', file_load_stub);
			remove_dir_stub = sandbox.stub(hdb_utils, 'removeDir');
		});

		after(() => {
			bulkLoad_rewire.__set__('fileLoad', file_load_orig);
			sandbox.restore();
		});

		it('Test bad URL throws validation error', async () => {
			CSV_URL_MESSAGE.csv_url = 'breeds.csv';
			await test_utils.testHDBError(
				bulkLoad_rewire.csvURLLoad(CSV_URL_MESSAGE),
				test_utils.generateHDBError('Csv url is not a valid url', 400)
			);
		});

		it('Test for nominal behaviour and success message is returned', async () => {
			CSV_URL_MESSAGE.csv_url = 'http://data.neo4j.com/northwind/products.csv';
			sandbox.stub(validator, 'urlObject').returns(null);
			let result = await stubHOC(bulkLoad_rewire.csvURLLoad, CSV_URL_MESSAGE);

			expect(result).to.equal(success_msg);
		});
	});

	describe('Test downloadCSVFile function', () => {
		let response_fake = {
			raw: 'id, name \n 1, harper\n',
			statusCode: 200,
			headers: {
				'content-type': 'text/csv',
			},
		};
		let downloadCSVFile_rw = bulkLoad_rewire.__get__('downloadCSVFile');
		let sandbox = sinon.createSandbox();
		let request_response_stub = sandbox.stub().resolves(response_fake);
		let mk_dir_stub;
		let write_file_stub;

		before(() => {
			mk_dir_stub = sandbox.stub(fs, 'mkdirp');
			write_file_stub = sandbox.stub(fs, 'writeFile');
		});

		after(() => {
			sandbox.restore();
		});

		it('Test error is handled from request promise module', async () => {
			let error;
			try {
				await downloadCSVFile_rw('http://the-internet.herokuapp.com/status_codes/404');
			} catch (err) {
				error = err;
			}
			expect(error).to.not.equal(undefined);
			expect(error.http_resp_msg).to.be.equal(
				'CSV Load failed from URL: http://the-internet.herokuapp.com/status_codes/404, status code: 404, message: Not Found'
			);
		}).timeout(20000);

		it('Test for nominal behaviour, stubs are called as expected', async () => {
			bulkLoad_rewire.__set__('needle', request_response_stub);
			let csv_file_name = `${Date.now()}.csv`;
			await downloadCSVFile_rw('www.csv.com', csv_file_name);

			expect(mk_dir_stub).to.have.been.calledWith(CSV_URL_TEMP_DIR);
			expect(write_file_stub).to.have.been.calledWith(`${CSV_URL_TEMP_DIR}/${csv_file_name}`, response_fake.raw);
		});

		it('Test that error from mkdirSync is handled correctly', async () => {
			bulkLoad_rewire.__set__('needle', request_response_stub);
			let error_msg = 'Error creating directory';
			mk_dir_stub.throws(new Error(error_msg));
			let test_err_result = await test_utils.testError(downloadCSVFile_rw('www.csv.com'), error_msg);

			expect(test_err_result).to.be.true;
		});
	});

	describe('Test validateURLResponse function', () => {
		let validateURLResponse_rw = bulkLoad_rewire.__get__('validateURLResponse');
		let url_fake = 'www.csv.com';

		it('Test that bad error code is handled', () => {
			let response = {
				statusCode: 400,
				statusMessage: 'Bad request',
			};
			let error;

			try {
				validateURLResponse_rw(response, url_fake);
			} catch (err) {
				error = err;
			}

			expect(error.message).to.equal(
				`CSV Load failed from URL: ${url_fake}, status code: ${response.statusCode}, message: ${response.statusMessage}`
			);
		});

		it('Test non-supported content type is handled', () => {
			let response = {
				statusCode: 200,
				headers: {
					'content-type': 'text/html',
				},
			};
			let error;

			try {
				validateURLResponse_rw(response, url_fake);
			} catch (err) {
				error = err;
			}

			expect(error.message).to.equal(
				`CSV Load failed from URL: ${url_fake}, unsupported content type: ${response.headers['content-type']}`
			);
		});

		it('Test empty response body is handled', () => {
			let response = {
				statusCode: 200,
				headers: {
					'content-type': 'text/csv',
				},
			};
			let error;

			try {
				validateURLResponse_rw(response, url_fake);
			} catch (err) {
				error = err;
			}

			expect(error.message).to.equal(`CSV Load failed from URL: ${url_fake}, no csv found at url`);
		});
	});

	describe('Test csvFileLoad function', () => {
		let validation_msg_stub;
		let fs_access_stub;
		let logger_error_spy;
		let file_load_rw;
		let sandbox = sinon.createSandbox();
		let bulk_file_load_result_fake = {
			records: 10,
			number_written: 10,
		};

		before(() => {
			call_papaparse_stub = sandbox.stub().resolves(bulk_file_load_result_fake);
			call_papaparse_rewire = bulkLoad_rewire.__set__('callPapaParse', call_papaparse_stub);
		});

		beforeEach(() => {
			validation_msg_stub = sandbox.stub(validator, 'fileObject').returns('');
			fs_access_stub = sandbox.stub(fs, 'access');
			logger_error_spy = sandbox.spy(logger, 'error');
			file_load_rw = bulkLoad_rewire.__get__('fileLoad');
		});

		afterEach(() => {
			sandbox.restore();
		});

		after(() => {
			call_papaparse_rewire();
		});

		it('Test validation throws error', async () => {
			validation_msg_stub.returns({ message: 'Validation error' });
			let error;

			try {
				await bulkLoad_rewire.csvFileLoad(json_message_fake);
			} catch (err) {
				error = err;
			}

			expect(error).to.be.instanceof(Error);
			expect(error.message).to.equal('Validation error');
			expect(validation_msg_stub).to.have.been.calledOnce;
		});

		it('Test success message is returned', async () => {
			let result = await stubHOC(bulkLoad_rewire.csvFileLoad, json_message_fake);

			expect(result).to.equal(
				`successfully loaded ${bulk_file_load_result_fake.number_written} of ${bulk_file_load_result_fake.records} records`
			);
			expect(call_papaparse_stub).to.have.been.calledOnce;
		});

		it('Test exception from papaparse is caught and logged', async () => {
			call_papaparse_stub.throws(new Error('Papa parse error'));
			let error;

			try {
				await stubHOC(bulkLoad_rewire.csvFileLoad, json_message_fake);
			} catch (err) {
				error = err;
			}

			expect(error).to.be.instanceof(Error);
			expect(error.message).to.equal('Papa parse error');
			expect(logger_error_spy).to.have.been.calledOnce;
		});
	});

	describe('Test importFromS3 function', () => {
		let sandbox = sinon.createSandbox();
		let validator_stub;
		let handleValidationErr_spy;
		let downloadFileFromS3_stub;
		let fileLoad_stub;
		let fs_stub;
		let buildTopLevelErrMsg_spy;
		let logger_error_spy;

		let importFromS3_rw;

		let test_S3_message_json;

		before(() => {
			validator_stub = sandbox.stub(validator, 's3FileObject').callThrough();
			bulkLoad_rewire.__set__('validator', { s3FileObject: validator_stub });

			const handleValidationErr_orig = bulkLoad_rewire.__get__('handleHDBError');
			handleValidationErr_spy = sandbox.spy(handleValidationErr_orig);
			bulkLoad_rewire.__set__('handleHDBError', handleValidationErr_spy);

			downloadFileFromS3_stub = sandbox.stub().resolves();
			bulkLoad_rewire.__set__('downloadFileFromS3', downloadFileFromS3_stub);

			fileLoad_stub = sandbox.stub().resolves(expected_insert_results_resp);
			bulkLoad_rewire.__set__('fileLoad', fileLoad_stub);

			const resolve_stub = sandbox.stub().resolves();
			fs_stub = { access: resolve_stub, unlink: resolve_stub };
			bulkLoad_rewire.__set__('fs', fs_stub);

			const buildErrMsg_orig = bulkLoad_rewire.__get__('buildTopLevelErrMsg');
			buildTopLevelErrMsg_spy = sandbox.spy(buildErrMsg_orig);
			bulkLoad_rewire.__set__('buildTopLevelErrMsg', buildTopLevelErrMsg_spy);

			logger_error_spy = sandbox.spy(logger, 'error');
			importFromS3_rw = bulkLoad_rewire.__get__('importFromS3');

			global.hdb_schema = {
				golden: {
					retriever: {},
				},
			};
		});

		beforeEach(() => {
			test_S3_message_json = test_utils.deepClone(s3_message_fake);
		});

		afterEach(() => {
			sandbox.resetHistory();
		});

		after(() => {
			sandbox.restore();
			bulkLoad_rewire = rewire('../../data_layer/bulkLoad');
			global.hdb_schema = undefined;
		});

		it('NOMINAL - Should call through and return results', async () => {
			const results = await stubHOC(importFromS3_rw, test_S3_message_json);

			expect(results).to.equal(expected_insert_results_resp);
			expect(logger_error_spy).to.have.not.been.called;
			expect(buildTopLevelErrMsg_spy).to.have.not.been.called;
		});

		it('NOMINAL - Should add `file_type` and `file_path` variables to the json message - csv', async () => {
			await stubHOC(importFromS3_rw, test_S3_message_json);

			expect(fileLoad_stub.args[0][0].file_type).to.equal('.csv');
			expect(typeof fileLoad_stub.args[0][0].file_path === 'string').to.be.true;
			expect(fileLoad_stub.args[0][0].file_path.endsWith('.csv')).to.be.true;
		});

		it('NOMINAL - Should add `file_type` and `file_path` variables to the json message - json', async () => {
			test_S3_message_json.s3.key = 'test_file.json';
			await stubHOC(importFromS3_rw, test_S3_message_json);

			expect(fileLoad_stub.args[0][0].file_type).to.equal('.json');
			expect(typeof fileLoad_stub.args[0][0].file_path === 'string').to.be.true;
			expect(fileLoad_stub.args[0][0].file_path.endsWith('.json')).to.be.true;
		});

		it('Should use handleHDBError to handle any validation issues', async () => {
			delete test_S3_message_json.schema;
			let result;
			try {
				await importFromS3_rw(test_S3_message_json);
			} catch (err) {
				result = err;
			}

			expect(result).to.be.instanceof(Error);
			expect(result.http_resp_msg).to.equal("Schema can't be blank");
			expect(result.http_resp_code).to.equal(HTTP_STATUS_CODES.BAD_REQUEST);
			expect(handleValidationErr_spy).to.have.been.calledOnce;
			expect(downloadFileFromS3_stub).to.have.not.been.called;
		});

		it('Should use buildTopLevelErrMsg to handle any error thrown', async () => {
			const test_err_msg = 'Download error';
			downloadFileFromS3_stub.throws(new Error(test_err_msg));

			let result;
			try {
				await stubHOC(importFromS3_rw, test_S3_message_json);
			} catch (err) {
				result = err;
			}

			expect(result).to.be.instanceof(Error);
			expect(result.http_resp_msg).to.equal(CHECK_LOGS_WRAPPER(TEST_BULK_LOAD_ERROR_MSGS.DEFAULT_BULK_LOAD_ERR));
			expect(result.http_resp_code).to.equal(HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR);
			expect(buildTopLevelErrMsg_spy.args[0][0].message).to.equal(test_err_msg);
			expect(logger_error_spy).to.have.been.calledOnce;
			expect(fileLoad_stub).to.not.have.been.called;
		});
	});

	describe('Test fileLoad function', () => {
		let sandbox = sinon.createSandbox();
		let callPapaParse_stub;
		let insertJson_stub;
		let logger_error_spy;
		let buildResponseMsg_spy;
		let buildTopLevelErrMsg_spy;

		let fileLoad_rw;

		let csv_msg_fake = {
			file_type: '.csv',
		};

		let json_msg_fake = {
			file_type: '.json',
		};

		let invalid_msg_fake = {
			file_type: '.xlsx',
		};

		before(() => {
			callPapaParse_stub = sandbox.stub().resolves(insert_results_fake);
			insertJson_stub = sandbox.stub().resolves(insert_results_fake);
			bulkLoad_rewire.__set__('callPapaParse', callPapaParse_stub);
			bulkLoad_rewire.__set__('insertJson', insertJson_stub);

			const buildRespMsg_orig = bulkLoad_rewire.__get__('buildResponseMsg');
			buildResponseMsg_spy = sandbox.spy(buildRespMsg_orig);
			bulkLoad_rewire.__set__('buildResponseMsg', buildResponseMsg_spy);

			const buildErrMsg_orig = bulkLoad_rewire.__get__('buildTopLevelErrMsg');
			buildTopLevelErrMsg_spy = sandbox.spy(buildErrMsg_orig);
			bulkLoad_rewire.__set__('buildTopLevelErrMsg', buildTopLevelErrMsg_spy);

			logger_error_spy = sandbox.spy(logger, 'error');
			fileLoad_rw = bulkLoad_rewire.__get__('fileLoad');
		});

		afterEach(() => {
			sandbox.resetHistory();
		});

		after(() => {
			sandbox.restore();
			bulkLoad_rewire = rewire('../../data_layer/bulkLoad');
		});

		it('Should call papaParse if file is CSV', async () => {
			const results = await fileLoad_rw(csv_msg_fake);

			expect(results).to.equal(expected_insert_results_resp);
			expect(logger_error_spy).to.have.not.been.called;
			expect(callPapaParse_stub).to.have.been.calledOnce;
			expect(buildResponseMsg_spy).to.have.been.calledOnce;
		});

		it('Should call insertJson if file is JSON', async () => {
			const results = await fileLoad_rw(json_msg_fake);

			expect(results).to.equal(expected_insert_results_resp);
			expect(logger_error_spy).to.have.not.been.called;
			expect(insertJson_stub).to.have.been.calledOnce;
			expect(buildResponseMsg_spy).to.have.been.calledOnce;
		});

		it('Should throw an error if file_type is not supported', async () => {
			let results;
			try {
				await fileLoad_rw(invalid_msg_fake);
			} catch (err) {
				results = err;
			}

			expect(results).to.be.instanceof(Error);
			expect(results.http_resp_msg).to.equal(TEST_BULK_LOAD_ERROR_MSGS.DEFAULT_BULK_LOAD_ERR);
			expect(results.http_resp_code).to.equal(HTTP_STATUS_CODES.BAD_REQUEST);
			expect(logger_error_spy).to.have.been.calledOnce;
			expect(logger_error_spy).to.have.been.calledWith(
				TEST_BULK_LOAD_ERROR_MSGS.INVALID_FILE_EXT_ERR(invalid_msg_fake)
			);
			expect(insertJson_stub).to.not.have.been.called;
			expect(callPapaParse_stub).to.not.have.been.called;
			expect(buildResponseMsg_spy).to.not.have.been.called;
			expect(buildTopLevelErrMsg_spy).to.have.been.calledOnce;
		});
	});

	describe('Test validateChunk function', () => {
		let sandbox = sinon.createSandbox();
		let insert_validation_stub;
		let logger_error_spy;
		let console_info_spy;
		let validate_chunk_rewire;
		let verify_attr_perms_stub = sandbox.stub().returns();
		let verify_attr_perms_rw;

		let write_object_fake = {
			operation: json_message_fake.action,
			schema: json_message_fake.schema,
			table: json_message_fake.table,
			records: data_array_fake,
		};
		let permsResponse;

		before(() => {
			sandbox.restore();
			validate_chunk_rewire = bulkLoad_rewire.__get__('validateChunk');
			insert_validation_stub = sandbox.stub(insert, 'validation').resolves({ attributes: ['Column 1', 'Column 2'] });
			console_info_spy = sandbox.spy(console, 'info');
			logger_error_spy = sandbox.spy(logger, 'error');
		});

		beforeEach(() => {
			permsResponse = new PermissionResponseObject();
		});

		after(() => {
			sandbox.restore();
			results_fake.data = [];
		});

		it('Test validation function returns if no data', async () => {
			await validate_chunk_rewire(json_message_fake, permsResponse, reject_fake, results_fake, parser_fake);

			expect(console_info_spy).to.have.not.been.calledWith('parser pause');
			expect(insert_validation_stub).to.not.have.been.calledWith(write_object_fake);
		});

		it('Test verifyBulkLoadAttributePerms method is called when user is non-SU', async () => {
			verify_attr_perms_rw = bulkLoad_rewire.__set__('verifyBulkLoadAttributePerms', verify_attr_perms_stub);
			results_fake.data = data_array_fake;

			await validate_chunk_rewire(test_bulk_load_file_obj, permsResponse, reject_fake, results_fake, parser_fake);

			assert.equal(verify_attr_perms_stub.callCount, 1, 'Attr perms were not checked');
			verify_attr_perms_rw();
		});

		it('Test parser is paused/resumed and validation called', async () => {
			results_fake.data = data_array_fake;

			await validate_chunk_rewire(json_message_fake, permsResponse, reject_fake, results_fake, parser_fake);

			expect(console_info_spy).to.have.been.calledWith('parser pause');
			expect(console_info_spy).to.have.been.calledWith('parser resume');
			expect(insert_validation_stub).to.have.been.calledWith(write_object_fake);
		});

		it('Test error is logged and reject promise returned', async () => {
			insert_validation_stub.throws(new Error('Insert error'));
			let error;

			try {
				await validate_chunk_rewire(json_message_fake, permsResponse, reject_fake, results_fake, parser_fake);
			} catch (err) {
				error = err;
			}

			expect(error).to.be.instanceof(Error);
			expect(error.message).to.equal('Insert error');
			expect(logger_error_spy).to.have.not.been.called;
		});
	});

	describe('Test insertChunk function', () => {
		let sandbox = sinon.createSandbox();
		let insert_chunk_rewire;
		let call_bulk_file_load_rewire;
		let call_bulk_file_load_stub;
		let call_bulk_file_load_orig_stub = undefined;
		let console_info_spy;
		let logger_error_spy;
		let bulk_file_load_result_fake = {
			records: 7,
			number_written: 6,
		};

		beforeEach(() => {
			call_bulk_file_load_stub = sandbox.stub().resolves(bulk_file_load_result_fake);
			call_bulk_file_load_orig_stub = bulkLoad_rewire.__get__('callBulkFileLoad');
			insert_chunk_rewire = bulkLoad_rewire.__get__('insertChunk');
			call_bulk_file_load_rewire = bulkLoad_rewire.__set__('callBulkFileLoad', call_bulk_file_load_stub);
			console_info_spy = sandbox.spy(console, 'info');
			logger_error_spy = sandbox.spy(logger, 'error');
		});

		afterEach(() => {
			sandbox.restore();
			call_bulk_file_load_rewire();
			bulkLoad_rewire.__set__('callBulkFileLoad', call_bulk_file_load_orig_stub);
		});

		it('Test validation function returns if no data', async () => {
			await insert_chunk_rewire(json_message_fake, insert_results_fake, reject_fake, results_fake, parser_fake);

			expect(console_info_spy).to.have.not.been.calledWith('parser pause');
			expect(call_bulk_file_load_stub).to.have.not.been.calledWith('parser pause');
		});

		it('Test parser is paused/resumed and callBulkLoad is called', async () => {
			results_fake.data = data_array_fake;
			results_fake.meta = {};
			results_fake.meta.fields = ['Column 1', 'Column 2'];
			await insert_chunk_rewire(json_message_fake, insert_results_fake, reject_fake, results_fake, parser_fake);

			expect(console_info_spy).to.have.been.calledWith('parser pause');
			expect(console_info_spy).to.have.been.calledWith('parser resume');
			expect(call_bulk_file_load_stub).to.have.been.calledOnce;
			expect(insert_results_fake.records).to.equal(17);
			expect(insert_results_fake.number_written).to.equal(16);
		});

		it('Test error is logged and reject promise returned', async () => {
			call_bulk_file_load_stub.throws(new Error('Bulk load error'));
			let error;
			let results_fake_clone = test_utils.deepClone(results_fake);
			results_fake_clone.data.push({ blah: 'blah' });
			try {
				await insert_chunk_rewire(json_message_fake, insert_results_fake, reject_fake, results_fake_clone, parser_fake);
			} catch (err) {
				error = err;
			}

			expect(error).to.be.instanceof(Error);
			expect(error.message).to.equal('Bulk load error');
		});
	});

	describe('Test callPapaParse function', () => {
		let sandbox = sinon.createSandbox();
		let fs_create_read_stream_stub;
		let papaparse_parse_stub;
		let logger_error_stub;
		let parse_results_fake = {
			records: 0,
			number_written: 0,
		};
		let stream_fake = {
			setEncoding: () => {},
			destroy: () => {},
		};

		before(() => {
			fs_create_read_stream_stub = sandbox.stub(fs, 'createReadStream').returns(stream_fake);
			papaparse_parse_stub = sandbox.stub(papa_parse, 'parsePromise');
			logger_error_stub = sandbox.stub(logger, 'error');
			call_papaparse_rewire = bulkLoad_rewire.__get__('callPapaParse');
		});

		after(() => {
			sandbox.restore();
		});

		it('Test readstream and papaparse are called and insert results are returned', async () => {
			let results = await call_papaparse_rewire(json_message_fake);

			expect(fs_create_read_stream_stub).to.have.been.calledTwice;
			expect(papaparse_parse_stub).to.have.been.calledTwice;
			expect(results).to.eql(parse_results_fake);
		});

		it('Test that error is logged and thrown', async () => {
			fs_create_read_stream_stub.throws(new Error('Argh im broken'));
			let error;

			try {
				await call_papaparse_rewire(json_message_fake);
			} catch (err) {
				error = err;
			}

			expect(error.message).to.equal('Argh im broken');
			expect(error.http_resp_msg).to.equal(
				'There was an error parsing the downloaded CSV data. Check logs and try again.'
			);
			expect(error.http_resp_code).to.equal(500);
			expect(error.__proto__.constructor.name).to.equal('HdbError');
			expect(logger_error_stub).to.have.been.calledOnce;
		});
	});

	describe('Test insertJson function', () => {
		let sandbox = sinon.createSandbox();
		let fs_create_read_stream_stub;
		let validateChunk_stub;
		let insertChunk_stub;
		let logger_error_spy;
		let insert_json_results_fake = {
			records: 0,
			number_written: 0,
		};

		let test_stream_file_location = `${TEST_DATA_DIR}/owners.json`;

		let insertJson_rw;
		let test_json_file_msg;

		before(() => {
			validateChunk_stub = sandbox.stub().resolves();
			bulkLoad_rewire.__set__('validateChunk', validateChunk_stub);
			insertChunk_stub = sandbox.stub().resolves();
			bulkLoad_rewire.__set__('insertChunk', insertChunk_stub);
			logger_error_spy = sandbox.spy(logger, 'error');
			insertJson_rw = bulkLoad_rewire.__get__('insertJson');
		});

		beforeEach(() => {
			test_json_file_msg = test_utils.deepClone(json_file_msg_fake);
		});

		afterEach(() => {
			sandbox.resetHistory();
		});

		after(() => {
			sandbox.restore();
			bulkLoad_rewire = rewire('../../data_layer/bulkLoad');
		});

		it('NOMINAL - Should call through and return results', async () => {
			test_json_file_msg.file_path = test_stream_file_location;
			const results = await insertJson_rw(test_json_file_msg);

			expect(results).to.deep.equal(insert_json_results_fake);
			expect(validateChunk_stub).to.have.been.called;
			expect(insertChunk_stub).to.have.been.called;
			expect(logger_error_spy).to.have.not.been.called;
		});

		it('ERROR - Should return a HDB error if the readStream emits an error', async () => {
			const streamEventEmitter = new EventEmitter();
			streamEventEmitter.resume = () => {};
			fs_create_read_stream_stub = sandbox.stub(fs, 'createReadStream').returns(streamEventEmitter);
			let results;

			try {
				await insertJson_rw(test_json_file_msg);
				streamEventEmitter.emit('error', 'blaaah');
			} catch (err) {
				results = err;
			}

			expect(results.http_resp_msg).to.equal(CHECK_LOGS_WRAPPER(TEST_BULK_LOAD_ERROR_MSGS.INSERT_JSON_ERR));
			expect(results.http_resp_code).to.equal(HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR);
			expect(validateChunk_stub).to.not.have.been.called;
			expect(logger_error_spy).to.have.been.called;
		});
	});

	describe('Test bulkFileLoad function', async () => {
		let sandbox = sinon.createSandbox();
		let insert_insert_stub;
		let insert_update_stub;
		let bulk_file_load_rewire;
		let schema_fake = 'golden';
		let table_fake = 'retriever';
		let insert_response_fake = {
			inserted_hashes: [1, 2, 3, 4, 5],
		};
		let update_response_fake = {
			update_hashes: [23, 34, 45],
		};

		before(() => {
			insert_insert_stub = sandbox.stub(insert, 'insert').resolves(insert_response_fake);
			insert_update_stub = sandbox.stub(insert, 'update').resolves(update_response_fake);
			bulk_file_load_rewire = bulkLoad_rewire.__get__('bulkFileLoad');
		});

		after(() => {
			sandbox.restore();
		});

		it('Test action defaults to insert and correct results are returned', async () => {
			let expected_result = {
				records: 2,
				number_written: 5,
				new_attributes: undefined,
			};

			let result = await bulk_file_load_rewire(data_array_fake, schema_fake, table_fake, '');
			expect(result).to.eql(expected_result);
			expect(insert_insert_stub).to.have.been.calledOnce;
		});

		it('Test update is called and returned result is correct', async () => {
			let expected_result = {
				records: 2,
				number_written: 3,
				new_attributes: undefined,
			};

			let result = await bulk_file_load_rewire(data_array_fake, schema_fake, table_fake, 'update');

			expect(result).to.eql(expected_result);
			expect(insert_update_stub).to.have.been.calledOnce;
		});

		it('Test error is thrown if invalid action is passed', async () => {
			const invalid_action = 'blaaaah';
			const expected_error = test_utils.generateHDBError(
				TEST_BULK_LOAD_ERROR_MSGS.INVALID_ACTION_PARAM_ERR(invalid_action),
				400
			);

			let result;
			try {
				await bulk_file_load_rewire(data_array_fake, schema_fake, table_fake, invalid_action);
			} catch (e) {
				result = e;
			}

			expect(result.message).to.eql(expected_error.message);
			expect(isHDBError(result)).to.be.true;
		});

		it('Test insert error caught and thrown', async () => {
			insert_insert_stub.throws(new Error('Somethings wrong'));
			let error;

			try {
				await bulk_file_load_rewire(data_array_fake, schema_fake, table_fake, 'insert');
			} catch (err) {
				error = err;
			}

			expect(error.message).to.equal('Somethings wrong');
			expect(error).to.be.instanceof(Error);
		});
	});

	describe('test postCSVLoadFunction', async () => {
		let sandbox = sinon.createSandbox();
		let post_to_cluster_stub = undefined;
		let publish_to_stream_stub;
		let send_attribute_transaction_stub;
		let expected_result = {
			records: 2,
			number_written: 3,
		};

		let postCSVLoadFunction = bulkLoad_rewire.__get__('postCSVLoadFunction');
		beforeEach(() => {
			publish_to_stream_stub = sandbox.stub(nats_utils, 'publishToStream').resolves();
			send_attribute_transaction_stub = sandbox
				.stub(transact_to_clustering_utils, 'sendAttributeTransaction')
				.resolves();
			post_to_cluster_stub = sandbox.stub(hdb_utils, `sendTransactionToSocketCluster`).returns();
		});
		afterEach(() => {
			sandbox.restore();
		});
		it('nominal case, see sent to cluster', async () => {
			env.setProperty(hdb_terms.CONFIG_PARAMS.CLUSTERING_ENABLED, true);
			let msg = test_utils.deepClone(json_message_fake);
			msg.transact_to_cluster = true;
			let msg_with_originator = test_utils.deepClone(json_message_fake);
			msg_with_originator.__originator = { ORIGINATOR_NAME: 111 };
			let result = await postCSVLoadFunction(['blah'], msg, expected_result, msg_with_originator);
			assert.strictEqual(publish_to_stream_stub.calledOnce, true, 'expected publishToStream to be called');
			assert.strictEqual(
				send_attribute_transaction_stub.calledOnce,
				true,
				'expected sendAttributeTransaction to be called'
			);
		});
		it('nominal case, see not sent to cluster', async () => {
			env.setProperty(hdb_terms.CONFIG_PARAMS.CLUSTERING_ENABLED, false);
			let msg_with_originator = test_utils.deepClone(json_message_fake);
			msg_with_originator.__originator = { ORIGINATOR_NAME: 111 };
			let result = await postCSVLoadFunction(['blah'], json_message_fake, expected_result, msg_with_originator);
			assert.strictEqual(publish_to_stream_stub.notCalled, true, 'expected publishToStream to NOT be called');
		});
	});
});
