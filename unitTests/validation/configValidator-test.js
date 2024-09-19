'use strict';

const chai = require('chai');
const { expect } = chai;
const sinon = require('sinon');
const rewire = require('rewire');
const config_val = rewire('../../validation/configValidator');
const { configValidator, routesValidator, doesPathExist } = config_val;
const path = require('path');
const test_utils = require('../test_utils');
const hdb_utils = require('../../utility/common_utils');
const fs = require('fs-extra');
const os = require('os');
const logger = require('../../utility/logging/harper_logger');

const HDB_ROOT = path.join(__dirname, 'carrot');

const FAKE_CONFIG = {
	authentication: {
		authorizeLocal: true,
		cacheTTL: 30000,
		enableSessions: true,
		operationTokenTimeout: '1d',
		refreshTokenTimeout: '30d',
	},
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
			streams: {
				maxAge: 3600,
				maxBytes: 10000,
				maxMsgs: 100,
				path: '/users/me/streams',
			},
		},
		nodeName: 'test_name',
		republishMessages: true,
		databaseLevel: false,
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
	http: {},
	threads: 2,
	itc: {
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
			enabled: true,
			frequency: '1d',
			path: '/put/logs/here',
			size: '100M',
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
		let does_path_rw;
		let does_path_stub;

		beforeEach(() => {
			validate_pem_file_stub = sandbox.stub();
			validate_pem_file_rw = config_val.__set__('validatePemFile', validate_pem_file_stub);
			does_path_stub = sandbox.stub();
			does_path_rw = config_val.__set__('doesPathExist', does_path_stub);
			does_path_stub.returns(null);
		});

		afterEach(() => {
			validate_pem_file_rw();
			sandbox.restore();
		});

		it('Test happy path clustering and CF enabled', () => {
			const schema = configValidator(FAKE_CONFIG);
			const expected_val_config_obj = {
				value: {
					authentication: {
						authorizeLocal: true,
						cacheTTL: 30000,
						enableSessions: true,
						operationTokenTimeout: '1d',
						refreshTokenTimeout: '30d',
					},
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
							streams: {
								maxAge: 3600,
								maxBytes: 10000,
								maxMsgs: 100,
								path: '/users/me/streams',
							},
						},
						nodeName: 'test_name',
						republishMessages: true,
						databaseLevel: false,
						replyService: {
							processes: 3,
						},
						tls: {
							certificate: 'clustering/cert/unit_test.pem',
							insecure: true,
							privateKey: 'clustering/test/key.pem',
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
					itc: {
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
							enabled: true,
							frequency: '1d',
							size: '100M',
							path: '/put/logs/here',
						},
						root: path.join(HDB_ROOT, 'log'),
						stdStreams: true,
					},
					componentsRoot: path.join(__dirname, '/carrot/components'),
					operationsApi: {
						authentication: {
							operationTokenTimeout: '2d',
							refreshTokenTimeout: '31d',
						},
						foreground: true,
						network: {
							cors: false,
							corsAccessList: ['test1', 'test2'],
							domainSocket: path.join(__dirname, '/carrot/operations-server'),
							headersTimeout: 60001,
							https: true,
							keepAliveTimeout: 5001,
							port: 2599,
							timeout: 120001,
						},
						nodeEnv: 'development',
						tls: {
							certificate: 'op_api/cert.pem',
						},
					},
					http: {},
					threads: 2,
					rootPath: path.join(__dirname, '/carrot'),
					storage: {
						writeAsync: true,
						path: path.join(__dirname, '/carrot/database'),
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
				"'clustering.hubServer.cluster.name' is required. 'clustering.hubServer.cluster.network.routes' does not match any of the allowed types. 'clustering.hubServer.leafNodes.network.port' must be one of [number, string]. 'clustering.hubServer.network.port' must be greater than or equal to 0";

			expect(schema.error.message).to.eql(expected_schema_message);
		});

		it('Test clustering.ingestService/leafServer/nodeName, with bad values', () => {
			let bad_config_obj = test_utils.deepClone(FAKE_CONFIG);
			bad_config_obj.clustering.leafServer.network.port = undefined;
			bad_config_obj.clustering.nodeName = 'wowee*nodename';
			bad_config_obj.clustering.leafServer.streams.maxAge = 10;

			const schema = configValidator(bad_config_obj);
			const expected_schema_message =
				"'clustering.leafServer.streams.maxAge' must be greater than or equal to 120. 'clustering.nodeName' invalid, must not contain ., * or >";

			expect(schema.error.message).to.eql(expected_schema_message);
		});

		it('Test clustering.replyService/tls/user, with bad values', () => {
			let bad_config_obj = test_utils.deepClone(FAKE_CONFIG);
			bad_config_obj.clustering.tls.certificateAuthority = true;
			bad_config_obj.clustering.user = 9999;

			const schema = configValidator(bad_config_obj);
			expect(schema.error.message).to.eql(
				"'clustering.tls.certificateAuthority' must be a string. 'clustering.user' must be a string"
			);
		});

		it('Test null/undefined values for required keys in clustering.hubServer', () => {
			let bad_config_obj = test_utils.deepClone(FAKE_CONFIG);
			bad_config_obj.clustering.hubServer.cluster.name = null;
			bad_config_obj.clustering.hubServer.cluster.network.port = undefined;
			bad_config_obj.clustering.hubServer.leafNodes.network.port = undefined;
			bad_config_obj.clustering.hubServer.network.port = undefined;

			const schema = configValidator(bad_config_obj);
			const expected_schema_message = "'clustering.hubServer.cluster.name' is required";

			expect(schema.error.message).to.eql(expected_schema_message);
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

		it('Test itc and localStudio in config_schema with bad values', () => {
			let bad_config_obj = test_utils.deepClone(FAKE_CONFIG);
			bad_config_obj.itc.network.port = 'bad_port';
			bad_config_obj.localStudio.enabled = 'spinach';

			const schema = configValidator(bad_config_obj);
			const expected_schema_message = "'localStudio.enabled' must be a boolean";

			expect(schema.error.message).to.eql(expected_schema_message);
		});

		it('Test logging in config_schema with bad values', () => {
			let bad_config_obj = test_utils.deepClone(FAKE_CONFIG);
			bad_config_obj.logging.file = 'sassafrass';
			bad_config_obj.logging.level = 'holla';
			bad_config_obj.logging.rotation.enabled = 'please';
			bad_config_obj.logging.rotation.interval = 1;
			bad_config_obj.logging.rotation.compress = 'nah';
			bad_config_obj.logging.rotation.maxSize = '100z';
			bad_config_obj.logging.rotation.path = true;
			bad_config_obj.logging.root = '/???';
			bad_config_obj.logging.stdStreams = ['not_a_boolean'];
			bad_config_obj.logging.auditLog = ['not_a_boolean'];

			const schema = configValidator(bad_config_obj);
			const expected_schema_message =
				"'logging.file' must be a boolean. 'logging.level' must be one of [notify, fatal, error, warn, info, debug, trace]. 'logging.rotation.enabled' must be a boolean. 'logging.rotation.compress' must be a boolean. 'logging.rotation.interval' must be a string. Invalid logging.rotation.maxSize unit. Available units are G, M or K. 'logging.rotation.path' must be a string. 'logging.root' with value '/???' fails to match the directory path pattern. 'logging.stdStreams' must be a boolean. 'logging.auditLog' must be a boolean";
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
				"'operationsApi.network.cors' must be a boolean. 'operationsApi.network.headersTimeout' must be greater than or equal to 1. 'operationsApi.network.keepAliveTimeout' must be a number. 'operationsApi.network.timeout' must be a number. 'rootPath' with value '/@@@' fails to match the directory path pattern. 'storage.writeAsync' is required";

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
			expect(logger_info_stub.firstCall.args[0]).to.include(`defaulting customFunctions.processes to ${result}`);
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
			const helpers = { state: { path: ['componentsRoot'] } };
			const result = set_default_root(parent, helpers);

			expect(result).to.equal(path.join(HDB_ROOT, '/components'));
		});

		it('Test that if logging.root is undefined, one is created', () => {
			hdb_root_rw = config_val.__set__('hdb_root', HDB_ROOT);
			const helpers = { state: { path: ['logging', 'root'] } };
			const result = set_default_root(parent, helpers);

			expect(result).to.equal(path.join(HDB_ROOT, '/log'));
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
		expect(result.message).to.equal("'routes' does not match any of the allowed types");
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
		expect(result.message).to.equal("'routes' does not match any of the allowed types");
	});

	it('Test validateRotationInterval invalid unit', () => {
		const validate_interval = config_val.__get__('validateRotationInterval');
		const message_stub = sinon.stub();
		const helpers = { message: message_stub };
		const result = validate_interval('10B', helpers);
		expect(helpers.message.args[0][0]).to.equal(
			'Invalid logging.rotation.interval unit. Available units are D, H or M (minutes)'
		);
	});

	it('Test validateRotationInterval invalid value', () => {
		const validate_interval = config_val.__get__('validateRotationInterval');
		const message_stub = sinon.stub();
		const helpers = { message: message_stub };
		const result = validate_interval('ONED', helpers);
		expect(helpers.message.args[0][0]).to.equal(
			"Invalid logging.rotation.interval value. Value should be a number followed by unit e.g. '10D'"
		);
	});
});
