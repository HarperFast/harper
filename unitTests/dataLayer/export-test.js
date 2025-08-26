'use strict';

const test_util = require('../test_utils');
test_util.preTestPrep();

const Stream = require('stream');
const assert = require('assert');
const rewire = require('rewire');
const hdb_export = rewire('../../dataLayer/export');
const sinon = require('sinon');
const fs = require('fs-extra');
const { rm } = require('fs/promises');
const path = require('path');
const { promisify } = require('util');
const AWSConnector = require('../../utility/AWS/AWSConnector');
const { EOL } = require('os');
const chai = require('chai');
const { expect } = chai;
const sinon_chai = require('sinon-chai');
chai.use(sinon_chai);

// Promisified functions
const p_fs_stat = promisify(fs.stat);

const TEST_OBJECT = { text: 'blah blah' };
const SEARCH_RESPONSE = [TEST_OBJECT];
const TMP_TEST_DIR = path.join(__dirname, 'tmpExportTestDir');

describe('Test export.js', () => {
	const sandbox = sinon.createSandbox();

	before(async () => {
		await fs.ensureDir(TMP_TEST_DIR);
	});

	after(() => {
		rewire('../../dataLayer/export');
		sandbox.restore();
		try {
			fs.removeSync(TMP_TEST_DIR);
		} catch (e) {
			//empty catch for a weird issue on windows when removing a folder that does not exist
		}
	});

	describe('Test export_local', function () {
		let search_stub = undefined;
		let export_local = hdb_export.__get__('export_local');
		let file_name = undefined;

		afterEach(async function () {
			sandbox.restore();
			try {
				if (file_name) {
					await rm(file_name, { force: true });
					file_name = undefined;
				}
			} catch (e) {
				//no-op, this is ok.
			}
		});

		it('Nominal Call to export_local with csv file', async function () {
			search_stub = sandbox.stub().returns(SEARCH_RESPONSE);
			file_name = path.join(TMP_TEST_DIR, 'test_file.csv');
			hdb_export.__set__('pSql', search_stub);
			let export_object = {};
			export_object.operation = 'export_local';
			export_object.path = `${TMP_TEST_DIR}`;
			export_object.filename = 'test_file';
			export_object.format = 'csv';
			export_object.search_operation = {
				operation: 'sql',
				sql: 'SELECT * FROM dev.breed',
			};
			try {
				await export_local(export_object);
			} catch (e) {
				throw e;
			}
			let stats = p_fs_stat(file_name).catch((e) => {
				throw e;
			});
			assert.ok(stats, true, 'Expected file to be found');
			let file = fs.readFileSync(file_name, 'utf-8');
			assert.ok(file.length > 0, 'File was empty');
			assert.ok(file.indexOf('blah blah') >= 0, 'Got incorrect file text value');
		});

		it('Nominal Call to export_local with json file', async function () {
			search_stub = sandbox.stub().returns(SEARCH_RESPONSE);
			file_name = path.join(TMP_TEST_DIR, 'test_file.json');
			hdb_export.__set__('pSql', search_stub);
			let export_object = {};
			export_object.operation = 'export_local';
			export_object.path = `${TMP_TEST_DIR}`;
			export_object.filename = 'test_file';
			export_object.format = 'json';
			export_object.search_operation = {
				operation: 'sql',
				sql: 'SELECT * FROM dev.breed',
			};
			try {
				await export_local(export_object);
			} catch (e) {
				throw e;
			}
			let stats = p_fs_stat(file_name).catch((e) => {
				throw e;
			});
			assert.ok(stats, true, 'Expected file to be found');
			let file = fs.readFileSync(file_name, 'utf-8');
			let converted = JSON.parse(file);
			assert.equal(converted[0].text, 'blah blah', 'Got incorrect file text value');
		});

		it('Call to export_local with bad path', async function () {
			search_stub = sandbox.stub().returns(SEARCH_RESPONSE);
			hdb_export.__set__('pSql', search_stub);
			let export_object = {};
			export_object.operation = 'export_local';
			export_object.path = null;
			export_object.filename = 'test_file';
			export_object.format = 'json';
			export_object.search_operation = {
				operation: 'sql',
				sql: 'SELECT * FROM dev.breed',
			};
			let err = undefined;
			try {
				await export_local(export_object);
			} catch (e) {
				err = e;
			}
			assert.ok(err.message.length > 0, 'expected error');
		});

		it('Call to export_local with search exception thrown', async function () {
			search_stub = sandbox.stub().throws(new Error('bah'));
			hdb_export.__set__('pSql', search_stub);
			let export_object = {};
			export_object.operation = 'export_local';
			export_object.path = './';
			export_object.filename = 'test_file';
			export_object.format = 'json';
			export_object.search_operation = {
				operation: 'sql',
				sql: 'SELECT * FROM dev.breed',
			};
			let err = undefined;
			try {
				await export_local(export_object);
			} catch (e) {
				err = e;
			}
			assert.ok(err.message.length > 0, 'expected error');
			assert.ok(err.message === 'bah', 'expected error');
		});

		it('Test validation error is handled correctly', async () => {
			const export_object = {};
			export_object.operation = 'export_local';
			export_object.path = './';
			export_object.filename = 'test_file';
			export_object.format = 'txt';
			export_object.search_operation = {
				operation: 'sql',
				sql: 'SELECT * FROM dev.breed',
			};
			const expected_err = test_util.generateHDBError(
				'format invalid. must be one of the following values: json, csv',
				400
			);
			await test_util.assertErrorAsync(export_local, [export_object], expected_err);
		});
	});

	describe('Test confirmPath', function () {
		let confirmPath = hdb_export.__get__('confirmPath');

		afterEach(function () {
			sandbox.restore();
		});

		it(
			'Nominal case of confirmPath',
			test_util.mochaAsyncWrapper(async function () {
				let test_path = './';
				let is_path_valid = await confirmPath(test_path);
				assert.equal(is_path_valid, true, 'Expected valid path');
			})
		);

		it('call confirmPath with bad path', async function () {
			let test_path = './zaphodbeeblebrox';
			let is_path_valid = await confirmPath(test_path).catch((err) => {
				assert.ok(err.message.length > 0, 'Expected Error message');
				assert.ok(err.message.indexOf('does not exist') >= 0, 'Expected Error message');
			});
			assert.equal(is_path_valid, undefined, 'Expected undefined result');
		});

		it('call confirmPath with non directory path', async function () {
			let test_path = './harperdb.js';
			let is_path_valid = await confirmPath(test_path).catch((err) => {
				assert.ok(err.message.length > 0, 'Expected Error message');
				assert.ok(err.message.indexOf('is not a directory') >= 0, 'Expected Error message');
			});
			assert.equal(is_path_valid, undefined, 'Expected undefined result');
		});

		it('call confirmPath with undefined path', async function () {
			let test_path = undefined;
			let is_path_valid = await confirmPath(test_path).catch((err) => {
				assert.ok(err.message.length > 0, 'Expected Error message');
				assert.ok(err.message.indexOf('Invalid path') >= 0, 'Expected Error message');
			});
			assert.equal(is_path_valid, undefined, 'Expected undefined result');
		});

		it('Test access denied error is handled correctly', async () => {
			let err = new Error('Oh no an error');
			err.code = 'EACCES';
			sandbox.stub(fs, 'stat').throws(err);
			let test_path = './';
			let expected_err = test_util.generateHDBError("access to path './' is denied", 400);
			await test_util.assertErrorAsync(confirmPath, [test_path], expected_err);
		});

		it('Test access error message is handled', async () => {
			let err = new Error('Oh no an error');
			err.code = 'TROUBLE';
			sandbox.stub(fs, 'stat').throws(err);
			let test_path = './';
			let expected_err = test_util.generateHDBError('Oh no an error', 400);
			await test_util.assertErrorAsync(confirmPath, [test_path], expected_err);
		});
	});

	describe('Test saveToLocal', function () {
		let saveToLocal = hdb_export.__get__('saveToLocal');
		let file_name = undefined;
		let data_object = [
			{
				__createdtime__: 1617990184839,
				only_one: 'this record is only in one',
				object: null,
				array: null,
				id: '4469b900-8ccb-4d21-9581-c7ca535bfbba',
				__updatedtime__: 1617990184839,
				address: '1 North Street',
				object_array: null,
			},
			{
				__createdtime__: 1617990184838,
				only_one: null,
				object: {
					dog: 'tuck',
					owner: 'david',
					foods: [1, 'chicken'],
				},
				array: ['tuck', 'ball', 123],
				id: 'e2e7e30c-2ec6-445c-b73d-9a1cae61c372',
				__updatedtime__: 1617990184838,
				address: '1 North Street',
				object_array: [
					{
						dog: 'tuck',
					},
					{
						dog: 123,
						breed: 'fur ball',
					},
				],
			},
		];

		afterEach(async function () {
			sandbox.restore();
			try {
				if (file_name) {
					await rm(file_name, { force: true });
					file_name = undefined;
				}
			} catch (e) {
				//no-op, this is ok.
			}
		});

		it(
			'Nominal case of saveToLocal with json',
			test_util.mochaAsyncWrapper(async function () {
				file_name = path.join(TMP_TEST_DIR, 'test_file.json');
				let wrote_data = await saveToLocal(file_name, 'json', data_object);
				assert.deepEqual(
					wrote_data,
					{ message: 'Successfully exported JSON locally.', path: file_name },
					'Expected valid path'
				);
				let stats = await p_fs_stat(file_name);
				assert.ok(stats, true, 'Expected file to be found');
				let file = fs.readFileSync(file_name, 'utf-8');
				assert.ok(file.length > 0, 'File was empty');
				let converted = JSON.parse(file);
				assert.deepEqual(converted, data_object, 'Got incorrect file text value');
			})
		);

		it(
			'Nominal case of saveToLocal with csv',
			test_util.mochaAsyncWrapper(async function () {
				let expected_csv =
					'"__createdtime__","only_one","object","array","id","__updatedtime__","address","object_array"' +
					EOL +
					'1617990184839,"this record is only in one",,,"4469b900-8ccb-4d21-9581-c7ca535bfbba",1617990184839,"1 North Street",' +
					EOL +
					'1617990184838,,"{""dog"":""tuck"",""owner"":""david"",""foods"":[1,""chicken""]}","[""tuck"",""ball"",123]","e2e7e30c-2ec6-445c-b73d-9a1cae61c372",1617990184838,"1 North Street","[{""dog"":""tuck""},{""dog"":123,""breed"":""fur ball""}]"';
				file_name = path.join(TMP_TEST_DIR, 'test_file.csv');
				let wrote_data = await saveToLocal(file_name, 'csv', data_object);
				assert.deepEqual(
					wrote_data,
					{ message: 'Successfully exported CSV locally.', path: file_name },
					'Expected valid path'
				);
				let stats = await p_fs_stat(file_name);
				assert.ok(stats, true, 'Expected file to be found');
				let file = fs.readFileSync(file_name, 'utf-8');
				assert.ok(file.length > 0, 'File was empty');
				assert.equal(file, expected_csv, 'Got incorrect file text value');
			})
		);

		it('Test error is thrown if file_path invalid', async () => {
			const expected_err = test_util.generateHDBError('file_path is invalid.', 400);
			await test_util.assertErrorAsync(saveToLocal, [null, 'csv', data_object], expected_err);
		});

		it('Test error is thrown if source format invalid', async () => {
			const expected_err = test_util.generateHDBError('Source format is invalid.', 400);
			await test_util.assertErrorAsync(saveToLocal, [TMP_TEST_DIR, null, data_object], expected_err);
		});

		it('Test error is thrown if data not found', async () => {
			const expected_err = test_util.generateHDBError('Data not found.', 400);
			await test_util.assertErrorAsync(saveToLocal, [TMP_TEST_DIR, 'json', null], expected_err);
		});

		it('Test error is thrown if format invalid', async () => {
			file_name = path.join(TMP_TEST_DIR, 'test_file.json');
			const expected_err = test_util.generateHDBError('format is invalid.', 400);
			await test_util.assertErrorAsync(saveToLocal, [file_name, 'txt', data_object], expected_err);
		});

		it('Call saveToLocal with empty data, this is valid', async function () {
			file_name = path.join(TMP_TEST_DIR, 'test_file.json');
			let empty_data = [];
			let expected_file_size = 2;
			let wrote_data = await saveToLocal(file_name, 'json', empty_data);
			assert.deepEqual(
				wrote_data,
				{ message: 'Successfully exported JSON locally.', path: file_name },
				'Expected valid path'
			);
			let stats = p_fs_stat(file_name).catch((e) => {
				throw e;
			});
			assert.ok(stats, true, 'Expected file to be found');
			let file = fs.readFileSync(file_name, 'utf-8');
			// Should only have brackets in the file
			assert.ok(file.length === expected_file_size, 'File should be empty');
		});
	});

	describe('Test export_to_s3', function () {
		const export_obj_test = {
			operation: 'export_to_s3',
			format: 'csv',
			s3: {
				aws_access_key_id: 'AKIA',
				aws_secret_access_key: '1lV',
				bucket: 'harperdb-integration-test-data/non_public_folder',
				key: 'test_special',
				region: 'us-east-2',
			},
			search_operation: {
				operation: 'sql',
				sql: 'SELECT * FROM test.special',
			},
			hdb_auth_header: 'Basic YWRtaW46QWJjMTIzNCE=',
			parsed_sql_object: {
				ast: {
					statements: [
						{
							columns: [
								{
									columnid: '*',
								},
							],
							from: [
								{
									databaseid: 'test',
									tableid: 'special',
								},
							],
						},
					],
				},
				variant: 'select',
				permissions_checked: true,
			},
		};

		const data_test = [
			{
				lastname: 'Dog',
				object: null,
				array: null,
				firstname: 'Harper',
				__createdtime__: 1618335194929,
				object_array: null,
				__updatedtime__: 1618335194929,
				address: '1 North Street',
				id: '8d9cd1b2-3e38-40cb-a340-c5d33e66dbb7',
				one: 'only one',
			},
			{
				lastname: null,
				object: {
					name: 'object',
					number: 1,
					array: [1, 'two'],
				},
				array: [1, 2, 'three'],
				firstname: 'Harper',
				__createdtime__: 1618335194930,
				object_array: null,
				__updatedtime__: 1618335194930,
				address: null,
				id: 'bc56cf62-5ad1-4519-b1c6-26742b02e9d5',
				one: null,
			},
			{
				lastname: null,
				object: null,
				array: null,
				firstname: null,
				__createdtime__: 1618335194930,
				object_array: [
					{
						number: 1,
					},
					{
						number: 'two',
						count: 2,
					},
				],
				__updatedtime__: 1618335194930,
				address: null,
				id: 'dce07e2f-fa32-4ceb-b4a4-4270fefe51cf',
				one: null,
			},
		];
		const aws_response_test = {
			ETag: '"fa8ff79092"',
			VersionId: 'ITDc8H',
			Location: 'https://harperdb-integration-test-data.s3.amazonaws.com/non_public_folder/test_special.csv',
			key: 'non_public_folder/test_special.csv',
			Key: 'non_public_folder/test_special.csv',
			Bucket: 'harperdb-integration-test-data',
		};
		let get_records_stub = sandbox.stub().resolves(data_test);
		let get_records_rw;
		let aws_connector_stub;
		let s3_stub = sinon.stub().callsFake(() => {
			return { done: () => aws_response_test };
		});
		let s3_fake = {
			upload: s3_stub,
			foo: () => {
				return { promise: () => {} };
			},
		};
		let upload_stub = sandbox.stub().returns({
			done: () => {},
		});

		before(() => {
			aws_connector_stub = sandbox.stub(AWSConnector, 'getS3AuthObj').returns(s3_fake);
			hdb_export.__set__('Upload', upload_stub);
			get_records_rw = hdb_export.__set__('getRecords', get_records_stub);
		});

		afterEach(() => {
			s3_stub.resetHistory();
		});

		after(() => {
			get_records_rw();
			aws_connector_stub.restore();
		});

		it('Nominal call export CSV to S3', async () => {
			const expected_body =
				'"lastname","object","array","firstname","__createdtime__","object_array","__updatedtime__","address","id","one"' +
				EOL +
				'"Dog",,,"Harper",1618335194929,,1618335194929,"1 North Street","8d9cd1b2-3e38-40cb-a340-c5d33e66dbb7","only one"' +
				EOL +
				',"{""name"":""object"",""number"":1,""array"":[1,""two""]}","[1,2,""three""]","Harper",1618335194930,,1618335194930,,"bc56cf62-5ad1-4519-b1c6-26742b02e9d5",' +
				EOL +
				',,,,1618335194930,"[{""number"":1},{""number"":""two"",""count"":2}]",1618335194930,,"dce07e2f-fa32-4ceb-b4a4-4270fefe51cf",';
			const result = await hdb_export.export_to_s3(export_obj_test);

			// Get the stream passed to the S3 upload method.
			const pass_through = upload_stub.args[0][0].params.Body;
			const writable_stream_csv = new Stream.Writable();
			pass_through.pipe(writable_stream_csv);
			let all_chunks = '';
			writable_stream_csv._write = (chunk, encoding, next) => {
				all_chunks += chunk.toString();
				next();
			};

			// This waits for the stream to finish.
			await new Promise((fulfill) => pass_through.on('end', fulfill));

			expect(all_chunks).to.equal(expected_body);
			expect(upload_stub.args[0][0].params.Bucket).to.equal('harperdb-integration-test-data/non_public_folder');
			expect(upload_stub.args[0][0].params.Key).to.equal('test_special.csv');
			upload_stub.resetHistory();
		});

		it('Nominal call export JSON to S3', async () => {
			const expected_body =
				'[{"lastname":"Dog","object":null,"array":null,"firstname":"Harper","__createdtime__":1618335194929,"object_array":null,"__updatedtime__":1618335194929,"address":"1 North Street","id":"8d9cd1b2-3e38-40cb-a340-c5d33e66dbb7","one":"only one"},{"lastname":null,"object":{"name":"object","number":1,"array":[1,"two"]},"array":[1,2,"three"],"firstname":"Harper","__createdtime__":1618335194930,"object_array":null,"__updatedtime__":1618335194930,"address":null,"id":"bc56cf62-5ad1-4519-b1c6-26742b02e9d5","one":null},{"lastname":null,"object":null,"array":null,"firstname":null,"__createdtime__":1618335194930,"object_array":[{"number":1},{"number":"two","count":2}],"__updatedtime__":1618335194930,"address":null,"id":"dce07e2f-fa32-4ceb-b4a4-4270fefe51cf","one":null}]';
			let export_object_clone = test_util.deepClone(export_obj_test);
			export_object_clone.format = 'json';
			const result = await hdb_export.export_to_s3(export_object_clone);

			expect(upload_stub.args[0][0].params.Bucket).to.equal('harperdb-integration-test-data/non_public_folder');
			expect(upload_stub.args[0][0].params.Key).to.equal('test_special.json');
		});

		it('Test missing S3 object error thrown', async () => {
			const export_obj = {
				s3: {},
			};
			const expected_err = test_util.generateHDBError('S3 object is missing.', 400);
			await test_util.assertErrorAsync(hdb_export.export_to_s3, [export_obj], expected_err);
		});

		it('Test missing aws_access_key_id error thrown', async () => {
			const export_obj = {
				s3: {
					aws_secret_access_key: '1lV',
					bucket: 'harperdb-integration-test-data/non_public_folder',
					key: 'test_special',
				},
			};
			const expected_err = test_util.generateHDBError('aws_access_key_id is missing.', 400);
			await test_util.assertErrorAsync(hdb_export.export_to_s3, [export_obj], expected_err);
		});

		it('Test missing aws_secret_access_key error thrown', async () => {
			const export_obj = {
				s3: {
					aws_access_key_id: 'AKIA',
					bucket: 'harperdb-integration-test-data/non_public_folder',
					key: 'test_special',
				},
			};
			const expected_err = test_util.generateHDBError('aws_secret_access_key is missing.', 400);
			await test_util.assertErrorAsync(hdb_export.export_to_s3, [export_obj], expected_err);
		});

		it('Test missing bucket error thrown', async () => {
			const export_obj = {
				s3: {
					aws_access_key_id: 'AKIA',
					aws_secret_access_key: '1lV',
					key: 'test_special',
				},
			};
			const expected_err = test_util.generateHDBError('bucket is missing.', 400);
			await test_util.assertErrorAsync(hdb_export.export_to_s3, [export_obj], expected_err);
		});

		it('Test missing key error thrown', async () => {
			const export_obj = {
				s3: {
					aws_access_key_id: 'AKIA',
					aws_secret_access_key: '1lV',
					bucket: 'harperdb-integration-test-data/non_public_folder',
				},
			};
			const expected_err = test_util.generateHDBError('key is missing.', 400);
			await test_util.assertErrorAsync(hdb_export.export_to_s3, [export_obj], expected_err);
		});

		it('Test bad format error thrown', async () => {
			const export_obj = {
				s3: {
					aws_access_key_id: 'AKIA',
					aws_secret_access_key: '1lV',
					bucket: 'harperdb-integration-test-data/non_public_folder',
					key: '123',
					region: 'us-east-1',
				},
				format: 'txt',
			};
			const expected_err = test_util.generateHDBError(
				'format invalid. must be one of the following values: json, csv',
				400
			);
			await test_util.assertErrorAsync(hdb_export.export_to_s3, [export_obj], expected_err);
		});

		it('Test error from getRecords is handled correctly', async () => {
			get_records_stub.throws(new Error('Error getting records'));
			await test_util.assertErrorAsync(hdb_export.export_to_s3, [export_obj_test], new Error('Error getting records'));
		});
	});

	describe('Test exportCoreValidation function', () => {
		const exportCoreValidation = hdb_export.__get__('exportCoreValidation');

		it('Test format missing message is returned', () => {
			const export_obj = {
				s3: {
					aws_access_key_id: 'AKIA',
					aws_secret_access_key: '1lV',
					bucket: 'harperdb-integration-test-data/non_public_folder',
					key: '123',
				},
				operation: 'export_to_s3',
			};
			const result = exportCoreValidation(export_obj);
			expect(result).to.equal('format missing');
		});

		it('Test invalid format message is returned', () => {
			const export_obj = {
				s3: {
					aws_access_key_id: 'AKIA',
					aws_secret_access_key: '1lV',
					bucket: 'harperdb-integration-test-data/non_public_folder',
					key: '123',
				},
				format: 'txt',
				operation: 'export_to_s3',
			};
			const result = exportCoreValidation(export_obj);
			expect(result).to.equal('format invalid. must be one of the following values: json, csv');
		});

		it('Test search operation missing message is returned', () => {
			const export_obj = {
				s3: {
					aws_access_key_id: 'AKIA',
					aws_secret_access_key: '1lV',
					bucket: 'harperdb-integration-test-data/non_public_folder',
					key: '123',
				},
				format: 'csv',
				operation: 'export_to_s3',
				search_operation: {},
			};
			const result = exportCoreValidation(export_obj);
			expect(result).to.equal('search_operation.operation missing');
		});

		it('Test search operation value wrong message returned', () => {
			const export_obj = {
				s3: {
					aws_access_key_id: 'AKIA',
					aws_secret_access_key: '1lV',
					bucket: 'harperdb-integration-test-data/non_public_folder',
					key: '123',
				},
				format: 'csv',
				operation: 'export_to_s3',
				search_operation: {
					operation: '',
				},
			};
			const result = exportCoreValidation(export_obj);
			expect(result).to.equal(
				'search_operation.operation must be one of the following values: search_by_value, search_by_hash, sql'
			);
		});
	});

	describe('Test getRecords function', () => {
		let getRecords;
		let p_search_by_value_stub = sandbox.stub().resolves('searchByValue');
		let p_search_by_hash_stub = sandbox.stub().resolves('searchByHash');
		let p_search_sql_stub = sandbox.stub().resolves('sql');

		before(() => {
			getRecords = hdb_export.__get__('getRecords');
			hdb_export.__set__('pSearchByValue', p_search_by_value_stub);
			hdb_export.__set__('pSearchByHash', p_search_by_hash_stub);
			hdb_export.__set__('pSql', p_search_sql_stub);
		});

		it('Test search by value operation is selected', async () => {
			const export_obj = {
				user: 'me',
				operation: 'export_to_s3',
				search_operation: {
					operation: 'search_by_value',
				},
			};
			let result = await getRecords(export_obj);
			expect(result).to.equal('searchByValue');
		});

		it('Test search by hash operation is selected', async () => {
			const export_obj = {
				user: 'me',
				operation: 'export_to_s3',
				search_operation: {
					operation: 'search_by_hash',
				},
			};
			let result = await getRecords(export_obj);
			expect(result).to.equal('searchByHash');
		});

		it('Test search by SQL operation is selected', async () => {
			const export_obj = {
				user: 'me',
				operation: 'export_to_s3',
				search_operation: {
					operation: 'sql',
				},
			};
			let result = await getRecords(export_obj);
			expect(result).to.equal('sql');
		});

		it('Test invalid search operation error thrown', async () => {
			const export_obj = {
				user: 'me',
				operation: 'export_to_s3',
				search_operation: {
					operation: '',
				},
			};
			const expected_err = test_util.generateHDBError('Search operation is invalid.', 400);
			await test_util.assertErrorAsync(getRecords, [export_obj], expected_err);
		});

		it('Test search operation not supported error thrown', async () => {
			const export_obj = {
				user: 'me',
				operation: 'export_to_s3',
				search_operation: {
					operation: 'range_search',
				},
			};
			const expected_err = test_util.generateHDBError('Operation range_search is not support by export.', 400);
			await test_util.assertErrorAsync(getRecords, [export_obj], expected_err);
		});
	});
});
