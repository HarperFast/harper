'use strict';

const chai = require('chai');
const { expect } = chai;
const sinon = require('sinon');
const rewire = require('rewire');
const config_val = rewire('../../validation/configValidator');
const { configValidator, routesValidator } = config_val;
const path = require('path');
const test_utils = require('../test_utils');
const hdb_utils = require('../../utility/common_utils');
const fs = require('fs-extra');
const os = require('os');
const logger = require('../../utility/logging/harper_logger');

const HDB_ROOT = path.join(__dirname, 'carrot');
const FAKE_CERT = '/fake/pem/cert.pem';
const FAKE_PRIVATE_KEY = '/fake/pem/key.pem';
const TEST_CERT = path.join(__dirname, 'carrot/keys/certificate.pem');
const TEST_PRIVATE_KEY = path.join(__dirname, 'carrot/keys/privateKey.pem');
const TEST_CA = path.join(__dirname, 'carrot/keys/ca.pem');

const FAKE_CONFIG = {
	clustering: {
		enabled: true,
		hubServer: {
			cluster: {
				name: 'test_cluster_name',
				network: {
					port: 4444,
					routes: [{ host: '0.0.0.0', port: 2222 }],
				},
			},
			leafNodes: {
				network: {
					port: 5555,
				},
			},
			network: {
				port: 1111,
			},
		},
		ingestService: {
			processes: 5,
		},
		leafServer: {
			network: {
				port: 6666,
			},
		},
		nodeName: 'test_name',
		replyService: {
			processes: 3,
		},
		tls: {
			certificate: 'clustering/cert/unit_test.pem',
			certificateAuthority: null,
			privateKey: 'clustering/test/key.pem',
			insecure: true,
		},
		user: 'ItsMe',
	},
	customFunctions: {
		enabled: true,
		network: {
			cors: false,
			corsAccessList: ['test1', 'test2'],
			headersTimeout: 59999,
			https: true,
			keepAliveTimeout: 4999,
			port: 9936,
			timeout: 119999,
		},
		nodeEnv: 'development',
		root: '/test_custom_functions',
		tls: {
			certificate: null,
			certificateAuthority: 'cf/test/ca.pem',
			privateKey: null,
		},
	},
	http: {
		threads: 2,
	},
	ipc: {
		network: {
			port: 1234,
		},
	},
	localStudio: {
		enabled: true,
	},
	logging: {
		auditLog: true,
		file: false,
		level: 'notify',
		rotation: {
			compress: true,
			dateFormat: 'YYYY-MM-DD',
			maxSize: '5M',
			retain: 20,
			rotate: true,
			rotateInterval: '0 0 0 0 0',
			rotateModule: false,
			timezone: 'CST',
			workerInterval: 20,
		},
		root: null,
		stdStreams: true,
	},
	operationsApi: {
		authentication: {
			operationTokenTimeout: '2d',
			refreshTokenTimeout: '31d',
		},
		foreground: true,
		network: {
			cors: false,
			corsAccessList: ['test1', 'test2'],
			headersTimeout: 60001,
			https: true,
			keepAliveTimeout: 5001,
			port: 2599,
			timeout: 120001,
		},
		nodeEnv: 'development',
		tls: {
			certificate: 'op_api/cert.pem',
			certificateAuthority: null,
			privateKey: null,
		},
	},
	rootPath: HDB_ROOT,
	storage: {
		writeAsync: true,
	},
};

describe('Test configValidator module', () => {
	const sandbox = sinon.createSandbox();

	describe('Test clustering schema in configValidator function', () => {
		let validate_pem_file_stub;
		let validate_pem_file_rw;

		beforeEach(() => {
			validate_pem_file_stub = sandbox.stub();
			validate_pem_file_rw = config_val.__set__('validatePemFile', validate_pem_file_stub);
		});

		afterEach(() => {
			validate_pem_file_rw();
			sandbox.restore();
		});

		it('Test happy path clustering and CF enabled', () => {
			const schema = configValidator(FAKE_CONFIG);
			const expected_val_config_obj = {
				value: {
					clustering: {
						enabled: true,
						hubServer: {
							cluster: {
								name: 'test_cluster_name',
								network: {
									port: 4444,
									routes: [
										{
											host: '0.0.0.0',
											port: 2222,
										},
									],
								},
							},
							leafNodes: {
								network: {
									port: 5555,
								},
							},
							network: {
								port: 1111,
							},
						},
						ingestService: {
							processes: 5,
						},
						leafServer: {
							network: {
								port: 6666,
							},
						},
						nodeName: 'test_name',
						replyService: {
							processes: 3,
						},
						tls: {
							certificate: 'clustering/cert/unit_test.pem',
							certificateAuthority: TEST_CA,
							privateKey: 'clustering/test/key.pem',
							insecure: true,
						},
						user: 'ItsMe',
					},
					customFunctions: {
						enabled: true,
						network: {
							cors: false,
							corsAccessList: ['test1', 'test2'],
							headersTimeout: 59999,
							https: true,
							keepAliveTimeout: 4999,
							port: 9936,
							timeout: 119999,
						},
						nodeEnv: 'development',
						root: '/test_custom_functions',
						tls: {
							certificate: TEST_CERT,
							certificateAuthority: 'cf/test/ca.pem',
							privateKey: TEST_PRIVATE_KEY,
						},
					},
					ipc: {
						network: {
							port: 1234,
						},
					},
					localStudio: {
						enabled: true,
					},
					logging: {
						auditLog: true,
						file: false,
						level: 'notify',
						rotation: {
							compress: true,
							dateFormat: 'YYYY-MM-DD',
							retain: 20,
							rotate: true,
							rotateInterval: '0 0 0 0 0',
							rotateModule: false,
							timezone: 'CST',
							workerInterval: 20,
						},
						root: path.join(HDB_ROOT, 'log'),
						stdStreams: true,
					},
					operationsApi: {
						authentication: {
							operationTokenTimeout: '2d',
							refreshTokenTimeout: '31d',
						},
						foreground: true,
						network: {
							cors: false,
							corsAccessList: ['test1', 'test2'],
							headersTimeout: 60001,
							https: true,
							keepAliveTimeout: 5001,
							port: 2599,
							timeout: 120001,
						},
						nodeEnv: 'development',
						tls: {
							certificate: 'op_api/cert.pem',
							certificateAuthority: TEST_CA,
							privateKey: TEST_PRIVATE_KEY,
						},
					},
					http: {
						threads: 2,
					},
					rootPath: path.join(__dirname, '/carrot'),
					storage: {
						writeAsync: true,
					},
				},
			};

			expect(schema).to.eql(expected_val_config_obj);
		});

		it('Test clustering.hubServer with bad values', () => {
			let bad_config_obj = test_utils.deepClone(FAKE_CONFIG);
			bad_config_obj.clustering.hubServer.cluster.name = null;
			bad_config_obj.clustering.hubServer.cluster.network.port = 'bad_port';
			bad_config_obj.clustering.hubServer.cluster.network.routes[0].host = 75;
			bad_config_obj.clustering.hubServer.leafNodes.network.port = { testing: 'another_bad_port' };
			bad_config_obj.clustering.hubServer.network.port = -14;

			const schema = configValidator(bad_config_obj);
			const expected_schema_message =
				"'clustering.hubServer.cluster.name' is required. 'clustering.hubServer.cluster.network.port' must be a number. 'clustering.hubServer.cluster.network.routes[0].host' must be a string. 'clustering.hubServer.leafNodes.network.port' must be a number. 'clustering.hubServer.network.port' must be greater than or equal to 0";

			expect(schema.error.message).to.eql(expected_schema_message);
		});

		it('Test clustering.ingestService/leafServer/nodeName, with bad values', () => {
			let bad_config_obj = test_utils.deepClone(FAKE_CONFIG);
			bad_config_obj.clustering.leafServer.network.port = undefined;
			bad_config_obj.clustering.nodeName = 'wowee*nodename';

			const schema = configValidator(bad_config_obj);
			const expected_schema_message =
				"'clustering.leafServer.network.port' is required. 'clustering.nodeName' invalid, must not contain ., * or >";

			expect(schema.error.message).to.eql(expected_schema_message);
		});

		it('Test clustering.replyService/tls/user, with bad values', () => {
			let bad_config_obj = test_utils.deepClone(FAKE_CONFIG);
			bad_config_obj.clustering.tls.certificateAuthority = true;
			bad_config_obj.clustering.user = 9999;

			const schema = configValidator(bad_config_obj);
			const expected_schema_message = "'clustering.user' must be a string";
			expect(schema.error.message).to.eql(expected_schema_message);
		});

		it('Test null/undefined values for required keys in clustering.hubServer', () => {
			let bad_config_obj = test_utils.deepClone(FAKE_CONFIG);
			bad_config_obj.clustering.hubServer.cluster.name = null;
			bad_config_obj.clustering.hubServer.cluster.network.port = undefined;
			bad_config_obj.clustering.hubServer.leafNodes.network.port = undefined;
			bad_config_obj.clustering.hubServer.network.port = undefined;

			const schema = configValidator(bad_config_obj);
			const expected_schema_message =
				"'clustering.hubServer.cluster.name' is required. 'clustering.hubServer.cluster.network.port' is required. 'clustering.hubServer.leafNodes.network.port' is required. 'clustering.hubServer.network.port' is required";

			expect(schema.error.message).to.eql(expected_schema_message);
		});

		it('Test null/undefined values for required keys in clustering.leafServer', () => {
			let bad_config_obj = test_utils.deepClone(FAKE_CONFIG);
			bad_config_obj.clustering.leafServer.network.port = undefined;

			const schema = configValidator(bad_config_obj);
			const expected_schema_message = "'clustering.leafServer.network.port' is required";

			expect(schema.error.message).to.eql(expected_schema_message);
		});

		it('Test error thrown if clustering is undefined', () => {
			const is_empty_stub = sandbox.stub(hdb_utils, 'isEmpty');
			is_empty_stub.withArgs(HDB_ROOT).returns(false);
			is_empty_stub.withArgs(null).returns(true);
			let config_obj = test_utils.deepClone(FAKE_CONFIG);
			config_obj.clustering.enabled = null;

			let error;
			try {
				configValidator(config_obj);
			} catch (err) {
				error = err;
			}

			expect(error).to.eql('clustering.enabled config parameter is undefined');
		});

		it('Test error thrown if hdb root is undefined', () => {
			let bad_config_obj = test_utils.deepClone(FAKE_CONFIG);
			bad_config_obj.rootPath = null;

			let error;
			try {
				configValidator(bad_config_obj);
			} catch (err) {
				error = err;
			}

			expect(error).to.eql('rootPath config parameter is undefined');
		});
	});

	describe('Test config schema in configValidator function', () => {
		let validate_pem_file_stub;
		let validate_pem_file_rw;

		beforeEach(() => {
			validate_pem_file_stub = sandbox.stub();
			validate_pem_file_rw = config_val.__set__('validatePemFile', validate_pem_file_stub);
		});

		afterEach(() => {
			validate_pem_file_rw();
		});

		it('Test customFunctions, customFunctions.network in config_schema with bad values', () => {
			let bad_config_obj = test_utils.deepClone(FAKE_CONFIG);
			bad_config_obj.customFunctions.enabled = 'tree';
			bad_config_obj.customFunctions.network.cors = 5;
			bad_config_obj.customFunctions.network.corsAccessList = 'not_array';
			bad_config_obj.customFunctions.network.headersTimeout = 0;
			bad_config_obj.customFunctions.network.https = { isBoolean: 'not_boolean' };
			bad_config_obj.customFunctions.network.keepAliveTimeout = [13];
			bad_config_obj.customFunctions.network.port = 'not_a_number';
			bad_config_obj.customFunctions.network.timeout = false;

			const schema = configValidator(bad_config_obj);
			const expected_schema_message =
				"'customFunctions.enabled' must be a boolean. 'customFunctions.network.cors' must be a boolean. 'customFunctions.network.corsAccessList' must be an array. 'customFunctions.network.headersTimeout' must be greater than or equal to 1. 'customFunctions.network.https' must be a boolean. 'customFunctions.network.keepAliveTimeout' must be a number. 'customFunctions.network.port' must be a number. 'customFunctions.network.timeout' must be a number";

			expect(schema.error.message).to.eql(expected_schema_message);
		});

		it('Test customFunctions.nodeEnv/processes/root in config_schema with bad values', () => {
			let bad_config_obj = test_utils.deepClone(FAKE_CONFIG);
			bad_config_obj.customFunctions.nodeEnv = 'testing';
			bad_config_obj.http.threads = [2];
			bad_config_obj.customFunctions.root = '/!';

			const schema = configValidator(bad_config_obj);
			const expected_error_message =
				"'customFunctions.nodeEnv' must be one of [production, development]." +
				" 'customFunctions.root' with value '/!' fails to match the directory path pattern. 'http.threads' must be a number";

			expect(schema.error.message).to.eql(expected_error_message);
		});

		it('Test ipc and localStudio in config_schema with bad values', () => {
			let bad_config_obj = test_utils.deepClone(FAKE_CONFIG);
			bad_config_obj.ipc.network.port = 'bad_port';
			bad_config_obj.localStudio.enabled = 'spinach';

			const schema = configValidator(bad_config_obj);
			const expected_schema_message = "'ipc.network.port' must be a number. 'localStudio.enabled' must be a boolean";

			expect(schema.error.message).to.eql(expected_schema_message);
		});

		it('Test logging in config_schema with bad values', () => {
			let bad_config_obj = test_utils.deepClone(FAKE_CONFIG);
			bad_config_obj.logging.file = 'sassafrass';
			bad_config_obj.logging.level = 'holla';
			bad_config_obj.logging.rotation.compress = 26;
			bad_config_obj.logging.rotation.dateFormat = { date: 'MM / DD / YY' };
			bad_config_obj.logging.rotation.maxSize = '12P';
			bad_config_obj.logging.rotation.retain = false;
			bad_config_obj.logging.rotation.rotate = [true];
			bad_config_obj.logging.rotation.rotateInterval = false;
			bad_config_obj.logging.rotation.rotateModule = 'nerp';
			bad_config_obj.logging.rotation.timezone = false;
			bad_config_obj.logging.rotation.workerInterval = 0;
			bad_config_obj.logging.root = '/???';
			bad_config_obj.logging.stdStreams = ['not_a_boolean'];
			bad_config_obj.logging.auditLog = ['not_a_boolean'];

			const schema = configValidator(bad_config_obj);
			const expected_schema_message =
				"'logging.file' must be a boolean. 'logging.level' must be one of [notify, fatal, error, warn, info, debug, trace]. 'logging.rotation.compress' must be a boolean. 'logging.rotation.dateFormat' must be a string. Invalid logging.rotation.maxSize unit. Available units are G, M or K. 'logging.rotation.retain' must be a number. 'logging.rotation.rotate' must be a boolean. 'logging.rotation.rotateInterval' must be a string. 'logging.rotation.rotateModule' must be a boolean. 'logging.rotation.timezone' must be a string. 'logging.rotation.workerInterval' must be greater than or equal to 1. 'logging.root' with value '/???' fails to match the directory path pattern. 'logging.stdStreams' must be a boolean. 'logging.auditLog' must be a boolean";

			expect(schema.error.message).to.eql(expected_schema_message);
		});

		it('Test operationsApi in config_schema with bad values', () => {
			let bad_config_obj = test_utils.deepClone(FAKE_CONFIG);
			bad_config_obj.operationsApi.authentication.operationTokenTimeout = undefined;
			bad_config_obj.operationsApi.authentication.refreshTokenTimeout = undefined;
			bad_config_obj.operationsApi.foreground = 222;
			bad_config_obj.operationsApi.network.cors = [false];
			bad_config_obj.operationsApi.network.corsAccessList = [true];
			bad_config_obj.operationsApi.network.headersTimeout = 0;
			bad_config_obj.operationsApi.network.https = 74;
			bad_config_obj.operationsApi.network.keepAliveTimeout = false;
			bad_config_obj.operationsApi.network.port = 'possum';
			bad_config_obj.operationsApi.network.timeout = false;
			bad_config_obj.operationsApi.nodeEnv = true;
			bad_config_obj.http.threads = true;
			bad_config_obj.rootPath = '/@@@';
			bad_config_obj.storage.writeAsync = undefined;

			const schema = configValidator(bad_config_obj);
			const expected_schema_message =
				"'operationsApi.authentication.operationTokenTimeout' is required." +
				" 'operationsApi.authentication.refreshTokenTimeout' is required. 'operationsApi.foreground' must be a" +
				" boolean. 'operationsApi.network.cors' must be a boolean. 'operationsApi.network.headersTimeout' must" +
				" be greater than or equal to 1. 'operationsApi.network.https' must be a boolean." +
				" 'operationsApi.network.keepAliveTimeout' must be a number. 'operationsApi.network.port' must be a" +
				" number. 'operationsApi.network.timeout' must be a number. 'operationsApi.nodeEnv' must be one of" +
				" [production, development]. 'rootPath' with value '/@@@' fails to match" +
				" the directory path pattern. 'http.threads' must be a number. 'storage.writeAsync' is required";

			expect(schema.error.message).to.eql(expected_schema_message);
		});
	});

	describe('Test doesPathExist function', () => {
		let exists_sync_stub;
		let does_path_exist_rw = config_val.__get__('doesPathExist');

		beforeEach(() => {
			exists_sync_stub = sandbox.stub(fs, 'existsSync');
		});

		afterEach(() => {
			exists_sync_stub.restore();
		});

		it('Test happy path, returns null', () => {
			exists_sync_stub.returns(true);
			const result = does_path_exist_rw('/this/does/exist');

			expect(result).to.be.null;
		});

		it('Test path doesnt exist, returns corresponding message', () => {
			exists_sync_stub.returns(false);
			const result = does_path_exist_rw('/this/does/not/exist');

			expect(result).to.equal('Specified path /this/does/not/exist does not exist.');
		});
	});

	describe('Test validatePemFile function', () => {
		let does_path_exist_stub = sandbox.stub();
		let does_path_exist_rw;
		let validate_pem_file = config_val.__get__('validatePemFile');

		beforeEach(() => {
			does_path_exist_rw = config_val.__set__('doesPathExist', does_path_exist_stub);
		});

		afterEach(() => {
			does_path_exist_rw();
		});

		it('Test happy path with correct pattern and data type', () => {
			does_path_exist_stub.returns(null);
			const does_path_exist_rw = config_val.__set__('doesPathExist', does_path_exist_stub);
			validate_pem_file('/totally/real.pem');

			expect(does_path_exist_stub.firstCall.args[0]).to.equal('/totally/real.pem');

			does_path_exist_rw();
		});

		it('Test with incorrect pattern, returns error', () => {
			let error;
			try {
				validate_pem_file('!.pem');
			} catch (err) {
				error = err;
			}
			const expected_error_message = 'must be a valid directory path and specify a .pem file';

			expect(error.message).to.equal(expected_error_message);
		});

		it('Test it returns a helpers message if it doesnt exist', () => {
			does_path_exist_stub.returns(true);
			const message_stub = sinon.stub().callsFake(() => "Specified path '/totally/fake.pem' does not exist.");
			const helpers = { message: message_stub };

			const result = validate_pem_file('/totally/fake.pem', helpers);

			expect(result).to.equal("Specified path '/totally/fake.pem' does not exist.");
		});
	});

	describe('Test validateRotationMaxSize function', () => {
		it('Test it returns a helper message if value isnt a number', () => {
			const validate_rotation_max_size = config_val.__get__('validateRotationMaxSize');
			const message_stub = sinon
				.stub()
				.callsFake(
					() => "Invalid logging.rotation.maxSize value. Value should be a number followed by unit e.g. '10M'"
				);
			const helpers = { message: message_stub };

			const result = validate_rotation_max_size('!M', helpers);

			expect(result).to.equal(
				"Invalid logging.rotation.maxSize value. Value should be a number followed by unit e.g. '10M'"
			);
		});
	});

	describe('Test setDefaultThreads function', () => {
		const set_default_processes = config_val.__get__('setDefaultThreads');
		const parent = {
			enabled: true,
			network: {
				cors: false,
				corsAccessList: ['test1', 'test2'],
				headersTimeout: 59999,
				https: true,
				keepAliveTimeout: 4999,
				port: 9936,
				timeout: 119999,
			},
			nodeEnv: 'development',
			root: path.join(__dirname, '/test_custom_functions'),
			tls: {
				certificate: '/fake/pem/cert.pem',
				certificateAuthority: null,
				privateKey: '/fake/pem/key.pem',
			},
		};
		const helpers = { state: { path: ['customFunctions', 'processes'] } };
		let os_cpus_stub;
		let logger_info_stub;

		beforeEach(() => {
			os_cpus_stub = sandbox.stub(os, 'cpus');
			logger_info_stub = sandbox.stub(logger, 'info');
		});

		afterEach(() => {
			os_cpus_stub.restore();
			logger_info_stub.restore();
		});

		it('Test happy path, correct info message is logged and correct number of processes returned', () => {
			os_cpus_stub.returns([1, 2, 3, 4, 5, 6]);
			const result = set_default_processes(parent, helpers);

			expect(result).to.equal(5);
			expect(logger_info_stub.firstCall.args[0]).to.equal(
				`Detected 6 cores on this machine, defaulting customFunctions.processes to ${result}`
			);
		});
	});

	describe('Test setDefaultRoot function', () => {
		let hdb_root_rw;
		const parent = {};
		const set_default_root = config_val.__get__('setDefaultRoot');

		it('Test throws error if hdb_root is undefined', () => {
			hdb_root_rw = config_val.__set__('hdb_root', undefined);
			const helpers = { state: { path: ['customFunctions', 'root'] } };

			let error;
			try {
				error = set_default_root(parent, helpers);
			} catch (err) {
				error = err;
			}

			expect(error.message).to.equal('Error setting default root for: customFunctions.root. HDB root is not defined');
		});

		it('Test error throws if config param isnt real', () => {
			hdb_root_rw = config_val.__set__('hdb_root', HDB_ROOT);
			const helpers = { state: { path: ['customFunctiones', 'root'] } };

			let error;
			try {
				error = set_default_root(parent, helpers);
			} catch (err) {
				error = err;
			}

			expect(error.message).to.equal(
				'Error setting default root for config parameter: customFunctiones.root. Unrecognized config parameter'
			);
		});

		it('Test that if customFunctions.root is undefined, one is created', () => {
			hdb_root_rw = config_val.__set__('hdb_root', HDB_ROOT);
			const helpers = { state: { path: ['customFunctions', 'root'] } };
			const result = set_default_root(parent, helpers);

			expect(result).to.equal(path.join(HDB_ROOT, '/custom_functions'));
		});

		it('Test that if logging.root is undefined, one is created', () => {
			hdb_root_rw = config_val.__set__('hdb_root', HDB_ROOT);
			const helpers = { state: { path: ['logging', 'root'] } };
			const result = set_default_root(parent, helpers);

			expect(result).to.equal(path.join(HDB_ROOT, '/log'));
		});

		it('Test that if operationsApi.tls.certificate is undefined, one is created', () => {
			hdb_root_rw = config_val.__set__('hdb_root', HDB_ROOT);
			const helpers = { state: { path: ['operationsApi', 'tls', 'certificate'] } };
			const result = set_default_root(parent, helpers);

			expect(result).to.equal(path.join(HDB_ROOT, '/keys/certificate.pem'));
		});

		it('Test that if operationsApi.tls.privateKey is undefined, one is created', () => {
			hdb_root_rw = config_val.__set__('hdb_root', HDB_ROOT);
			const helpers = { state: { path: ['operationsApi', 'tls', 'privateKey'] } };
			const result = set_default_root(parent, helpers);

			expect(result).to.equal(path.join(HDB_ROOT, '/keys/privateKey.pem'));
		});

		it('Test that if customFunctions.tls.certificate is undefined, one is created', () => {
			hdb_root_rw = config_val.__set__('hdb_root', HDB_ROOT);
			const helpers = { state: { path: ['customFunctions', 'tls', 'certificate'] } };
			const result = set_default_root(parent, helpers);

			expect(result).to.equal(path.join(HDB_ROOT, '/keys/certificate.pem'));
		});

		it('Test that if customFunctions.tls.privateKey is undefined, one is created', () => {
			hdb_root_rw = config_val.__set__('hdb_root', HDB_ROOT);
			const helpers = { state: { path: ['customFunctions', 'tls', 'privateKey'] } };
			const result = set_default_root(parent, helpers);

			expect(result).to.equal(path.join(HDB_ROOT, '/keys/privateKey.pem'));
		});

		it('Test that if clustering.tls.certificate is undefined, one is created', () => {
			hdb_root_rw = config_val.__set__('hdb_root', HDB_ROOT);
			const helpers = { state: { path: ['clustering', 'tls', 'certificate'] } };
			const result = set_default_root(parent, helpers);

			expect(result).to.equal(path.join(HDB_ROOT, '/keys/certificate.pem'));
		});

		it('Test that if clustering.tls.privateKey is undefined, one is created', () => {
			hdb_root_rw = config_val.__set__('hdb_root', HDB_ROOT);
			const helpers = { state: { path: ['clustering', 'tls', 'privateKey'] } };
			const result = set_default_root(parent, helpers);

			expect(result).to.equal(path.join(HDB_ROOT, '/keys/privateKey.pem'));
		});

		it('Test that if clustering.tls.certificateAuthority is undefined, one is created', () => {
			hdb_root_rw = config_val.__set__('hdb_root', HDB_ROOT);
			const helpers = { state: { path: ['clustering', 'tls', 'certificateAuthority'] } };
			const result = set_default_root(parent, helpers);

			expect(result).to.equal(path.join(HDB_ROOT, '/keys/ca.pem'));
		});
	});

	it('Test routesValidator validation bad values', () => {
		const test_array = [
			{
				host: 123,
				port: 7916,
			},
			{
				host: '4.4.4.6',
				port: '711a',
			},
		];
		const result = routesValidator(test_array);
		expect(result.message).to.equal("'routes[0].host' must be a string. 'routes[1].port' must be a number");
	});

	it('Test routesValidator validation more bad values', () => {
		const test_array = [
			{
				port: 7916,
			},
			{
				host: '4.4.4.6',
			},
		];
		const result = routesValidator(test_array);
		expect(result.message).to.equal("'routes[0].host' is required. 'routes[1].port' is required");
	});
});
