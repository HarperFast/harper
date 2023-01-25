'use strict';

const sinon = require('sinon');
const chai = require('chai');
const expect = chai.expect;
const rewire = require('rewire');
const path = require('path');
const fs = require('fs-extra');
const config_utils_rw = rewire('../../config/configUtils');
const YAML = require('yaml');
const hdbTerms = require('../../utility/hdbTerms');
const logger = require('../../utility/logging/harper_logger');
const common_utils = require('../../utility/common_utils');
const test_utils = require('../test_utils');
const hdb_terms = require('../../utility/hdbTerms');

const DIRNAME = __dirname;
const HDB_ROOT = path.join(DIRNAME, 'yaml');
const TEST_CERT = path.join(DIRNAME, '../../../hdb/keys/certificate.pem');
const TEST_CERT_AUTH = path.join(DIRNAME, '../../../hdb/keys/privatekey.pem');
const TEST_PRIVATE_KEY = path.join(DIRNAME, '../../../hdb/keys/ca.pem');
const TEST_ARGS = {
	CLUSTERING_USER: 'test_user',
	CLUSTERING_ENABLED: true,
	CLUSTERING_HUBSERVER_CLUSTER_NAME: 'testHarperDB',
	CLUSTERING_HUBSERVER_CLUSTER_NETWORK_PORT: '9933',
	CLUSTERING_HUBSERVER_CLUSTER_NETWORK_ROUTES: '[]',
	CLUSTERING_HUBSERVER_LEAFNODES_NETWORK_PORT: '9911',
	CLUSTERING_HUBSERVER_NETWORK_PORT: '9900',
	CLUSTERING_LEAFSERVER_NETWORK_PORT: '9944',
	CLUSTERING_LEAFSERVER_NETWORK_ROUTES: '[]',
	CLUSTERING_INGEST_SERVICE_PROCESSES: '1',
	CLUSTERING_REPLY_SERVICE_PROCESSES: '1',
	CLUSTERING_TLS_CERTIFICATE: TEST_CERT,
	CLUSTERING_TLS_PRIVATEKEY: TEST_PRIVATE_KEY,
	CLUSTERING_TLS_CERT_AUTH: TEST_CERT_AUTH,
	CLUSTERING_NETWORK_PORT: '54321',
	CLUSTERING_NETWORK_SELFSIGNEDSSLCERTS: true,
	CLUSTERING_NODENAME: 'test_node_name',
	CUSTOMFUNCTIONS_ENABLED: true,
	CUSTOMFUNCTIONS_NETWORK_PORT: '9936',
	CUSTOMFUNCTIONS_NETWORK_CORS: false,
	CUSTOMFUNCTIONS_NETWORK_CORSACCESSLIST: '["test1", "test2"]',
	CUSTOMFUNCTIONS_NETWORK_HEADERSTIMEOUT: '59999',
	CUSTOMFUNCTIONS_NETWORK_HTTPS: true,
	CUSTOMFUNCTIONS_NETWORK_KEEPALIVETIMEOUT: '4999',
	CUSTOMFUNCTIONS_TLS_CERTIFICATE: TEST_CERT,
	CUSTOMFUNCTIONS_TLS_CERT_AUTH: null,
	CUSTOMFUNCTIONS_TLS_PRIVATEKEY: TEST_PRIVATE_KEY,
	CUSTOMFUNCTIONS_NETWORK_TIMEOUT: '119999',
	CUSTOMFUNCTIONS_NODEENV: 'development',
	CUSTOMFUNCTIONS_ROOT: path.join(DIRNAME, 'test_custom_functions'),
	HTTP_THREADS: '4',
	HTTP_REMOTE_ADDRESS_AFFINITY: false,
	LOCALSTUDIO_ENABLED: true,
	LOGGING_FILE: false,
	LOGGING_LEVEL: 'notify',
	LOGGING_ROOT: path.join(DIRNAME, 'testlogging'),
	LOGGING_ROTATION_COMPRESS: true,
	LOGGING_ROTATION_DATEFORMAT: 'YYYY-MM-DD',
	LOGGING_ROTATION_MAXSIZE: '5M',
	LOGGING_ROTATION_RETAIN: '20',
	LOGGING_ROTATION_ROTATE: true,
	LOGGING_ROTATION_ROTATEINTERVAL: '0 0 0 0 0',
	LOGGING_ROTATION_ROTATEMODULE: false,
	LOGGING_ROTATION_TIMEZONE: 'CST',
	LOGGING_ROTATION_WORKERINTERVAL: '20',
	LOGGING_STDSTREAMS: true,
	LOGGING_AUDITLOG: true,
	OPERATIONSAPI_AUTHENTICATION_OPERATIONTOKENTIMEOUT: '2d',
	OPERATIONSAPI_AUTHENTICATION_REFRESHTOKENTIMEOUT: '31d',
	OPERATIONSAPI_FOREGROUND: true,
	OPERATIONSAPI_NETWORK_CORS: false,
	OPERATIONSAPI_NETWORK_CORSACCESSLIST: '["test1", "test2"]',
	OPERATIONSAPI_NETWORK_HEADERSTIMEOUT: '60001',
	OPERATIONSAPI_NETWORK_HTTPS: true,
	OPERATIONSAPI_NETWORK_KEEPALIVETIMEOUT: '5001',
	OPERATIONSAPI_NETWORK_PORT: '2599',
	OPERATIONSAPI_NETWORK_TIMEOUT: '120001',
	OPERATIONSAPI_NODEENV: 'development',
	ROOTPATH: HDB_ROOT,
	STORAGE_WRITEASYNC: true,
	STORAGE_OVERLAPPINGSYNC: false,
	STORAGE_CACHING: false,
	STORAGE_COMPRESSION: false,
	STORAGE_NOREADAHEAD: false,
	STORAGE_PREFETCHWRITES: false,
	OPERATIONSAPI_TLS_CERTIFICATE: TEST_CERT,
	OPERATIONSAPI_TLS_PRIVATEKEY: TEST_PRIVATE_KEY,
	OPERATIONSAPI_TLS_CERT_AUTH: null,
};
const TEST_ARGS_2 = {
	CLUSTERING_ENABLED: true,
	CUSTOMFUNCTIONS_ENABLED: true,
	ROOTPATH: HDB_ROOT,
};
let TEST_ARGS_3 = {
	ROOTPATH: HDB_ROOT,
};
const FLAT_CONFIG_OBJ = {
	clustering_enabled: false,
	clustering_hubserver_cluster_name: 'harperdb',
	clustering_hubserver_cluster_network_port: 9932,
	clustering_hubserver_cluster_network_routes: [
		{
			ip: null,
			port: null,
		},
	],
	clustering_hubserver_leafnodes_network_port: 9931,
	clustering_hubserver_network_port: 9930,
	clustering_ingestservice_processes: 1,
	clustering_leafserver_network_port: 9940,
	clustering_nodename: null,
	clustering_replyservice_processes: 1,
	clustering_tls_certificate: null,
	clustering_tls_certificateauthority: null,
	clustering_tls_privatekey: null,
	clustering_user: null,
	customfunctions_enabled: false,
	customfunctions_network_cors: true,
	customfunctions_network_corsaccesslist: [null],
	customfunctions_network_headerstimeout: 60000,
	customfunctions_network_https: false,
	customfunctions_network_keepalivetimeout: 5000,
	customfunctions_network_port: 9926,
	customfunctions_network_timeout: 120000,
	customfunctions_nodeenv: 'production',
	customfunctions_processes: null,
	customfunctions_root: null,
	customfunctions_tls_certificate: null,
	customfunctions_tls_certificateauthority: null,
	customfunctions_tls_privatekey: null,
	localstudio_enabled: false,
	logging_auditlog: false,
	logging_file: true,
	logging_level: 'error',
	logging_root: null,
	logging_rotation_compress: false,
	logging_rotation_dateformat: 'YYYY-MM-DD_HH-mm-ss',
	logging_rotation_maxsize: '10M',
	logging_rotation_retain: 30,
	logging_rotation_rotate: false,
	logging_rotation_rotateinterval: '0 0 * * *',
	logging_rotation_rotatemodule: true,
	logging_rotation_timezone: 'GMT',
	logging_rotation_workerinterval: 30,
	logging_stdstreams: false,
	operationsapi_authentication_operationtokentimeout: '1d',
	operationsapi_authentication_refreshtokentimeout: '30d',
	operationsapi_foreground: false,
	operationsapi_network_cors: true,
	operationsapi_network_corsaccesslist: [null],
	operationsapi_network_headerstimeout: 60000,
	operationsapi_network_https: false,
	operationsapi_network_keepalivetimeout: 5000,
	operationsapi_network_port: 9925,
	operationsapi_network_timeout: 120000,
	operationsapi_nodeenv: 'production',
	operationsapi_processes: null,
	rootpath: null,
	storage_writeasync: true,
	storage_overlappingsync: false,
	operationsapi_tls_certificate: null,
	operationsapi_tls_certificateauthority: null,
	operationsapi_tls_privatekey: null,
};
const CONFIG_DOC_VALUE = {
	clustering: {
		enabled: false,
		tls: {
			certificate: 'test_cert',
			certificateAuthority: 'test_ca',
			privateKey: 'test_key',
		},
	},
	customFunctions: {
		enabled: false,
		processes: null,
		root: null,
		tls: {
			certificate: null,
			certificateAuthority: null,
			privateKey: null,
		},
	},
	logging: {
		root: null,
	},
	operationsApi: {
		processes: null,
		tls: {
			certificate: null,
			certificateAuthority: null,
			privateKey: null,
		},
	},
};
const FAKE_JSON_1 = {
	clustering: {
		enabled: false,
		tls: {
			certificate: 'test_cert',
			certificateAuthority: 'test_ca',
			privateKey: 'test_key',
		},
	},
	customFunctions: {
		enabled: false,
		processes: null,
		root: null,
		tls: {
			certificate: null,
			certificateAuthority: null,
			privateKey: null,
		},
	},
	logging: {
		root: {
			'null compress': false,
		},
	},
	operationsApi: {
		processes: null,
		tls: {
			certificate: null,
			certificateAuthority: null,
			privateKey: null,
		},
	},
};

const CA_PEM = '/yaml/keys/ca.pem';
const CERT_PEM = '/yaml/keys/certificate.pem';
const KEY_PEM = '/yaml/keys/privateKey.pem';
const CF_ROOT = '/yaml/custom_functions';
const LOG_ROOT = '/yaml/log';

const TEST_DIR = HDB_ROOT;
const CONFIG_FILE_PATH = path.join(DIRNAME, 'yaml', 'harperdb-config.yaml');
const OLD_CONFIG_PATH = 'test-config/settings.js';
const BAD_CONFIG_FILE_PATH = path.join(DIRNAME, 'yaml', 'harperdb.doesntexist');
const BACKUP_FILE_PATH = path.join(DIRNAME, 'yaml/backup', 'harperdb-config.yaml.bak');
const BACKUP_FOLDER_PATH = path.join(DIRNAME, 'yaml/backup');
const EMPTY_GET_VALUE = 'Empty parameter sent to getConfigValue';
const UNINIT_GET_CONFIG_ERR = 'Unable to get config value because config is uninitialized';
const CONFIG_INIT_MSG = 'Config successfully initialized';
const UNDFND_CONFIG_FILE_PATH_MSG = `HarperDB config file not found at ${BAD_CONFIG_FILE_PATH}. 
				This can occur during early stages of install where the config file has not yet been created`;
const UNDEFINED_OPS_API = 'operationsApi.root config parameter is undefined';
const CONFIGURE_SUCCESS_RESPONSE =
	'Configuration successfully set. You must restart HarperDB for new config settings to take effect.';
const STRING_ERROR = 'HarperDB config file validation error: "logging.rotation.maxSize" must be a string';

describe('Test configUtils module', () => {
	const sandbox = sinon.createSandbox();

	before(() => {
		fs.mkdirsSync(TEST_DIR);
	});

	after(() => {
		sandbox.restore();
		fs.rmdirSync(TEST_DIR);
	});

	describe('Test createConfigFile function', () => {
		const validate_config_stub = sandbox.stub();
		let validate_config_rw;

		before(() => {
			validate_config_rw = config_utils_rw.__set__('validateConfig', validate_config_stub);
		});

		afterEach(() => {
			sandbox.resetHistory();
			fs.unlinkSync(CONFIG_FILE_PATH);
		});

		after(() => {
			validate_config_rw();
		});

		it('Test that given args are updated in new config file', () => {
			const expected_config = {
				clustering: {
					enabled: true,
					hubServer: {
						cluster: {
							name: 'testHarperDB',
							network: {
								port: 9933,
								routes: [],
							},
						},
						leafNodes: {
							network: {
								port: 9911,
							},
						},
						network: {
							port: 9900,
						},
					},
					ingest: {
						threads: 1,
					},
					leafServer: {
						network: {
							port: 9944,
							routes: [],
						},
						streams: {
							maxAge: null,
							maxBytes: null,
							maxMsgs: null,
							path: null,
						},
					},
					nodeName: 'test_node_name',
					tls: {
						certificate: TEST_CERT,
						certificateAuthority: null,
						privateKey: TEST_PRIVATE_KEY,
						insecure: true,
					},
					user: 'test_user',
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
					root: path.join(DIRNAME, '/test_custom_functions'),
					tls: {
						certificate: TEST_CERT,
						certificateAuthority: null,
						privateKey: TEST_PRIVATE_KEY,
					},
				},
				http: {
					threads: 4,
					remoteAddressAffinity: false,
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
					root: path.join(DIRNAME, '/testlogging'),
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
						certificate: TEST_CERT,
						certificateAuthority: null,
						privateKey: TEST_PRIVATE_KEY,
					},
				},
				rootPath: path.join(DIRNAME, '/yaml'),
				storage: {
					writeAsync: true,
					overlappingSync: false,
					caching: false,
					compression: false,
					noReadAhead: false,
					prefetchWrites: false,
				},
			};
			const expected_flat_config = {
				clustering_enabled: true,
				clustering_hubserver_cluster_name: 'testHarperDB',
				clustering_hubserver_cluster_network_port: 9933,
				clustering_hubserver_cluster_network_routes: [],
				clustering_hubserver_leafnodes_network_port: 9911,
				clustering_hubserver_network_port: 9900,
				clustering_leafserver_network_port: 9944,
				clustering_leafserver_network_routes: [],
				clustering_leafserver_streams_maxage: null,
				clustering_leafserver_streams_maxbytes: null,
				clustering_leafserver_streams_maxmsgs: null,
				clustering_leafserver_streams_path: null,
				clustering_nodename: 'test_node_name',
				clustering_tls_certificate: TEST_CERT,
				clustering_tls_certificateauthority: null,
				clustering_tls_privatekey: TEST_PRIVATE_KEY,
				clustering_tls_insecure: true,
				clustering_user: 'test_user',
				customfunctions_enabled: true,
				customfunctions_network_cors: false,
				customfunctions_network_corsaccesslist: ['test1', 'test2'],
				customfunctions_network_headerstimeout: 59999,
				customfunctions_network_https: true,
				customfunctions_network_keepalivetimeout: 4999,
				customfunctions_network_port: 9936,
				customfunctions_network_timeout: 119999,
				customfunctions_nodeenv: 'development',
				customfunctions_root: path.join(DIRNAME, '/test_custom_functions'),
				customfunctions_tls_certificate: TEST_CERT,
				customfunctions_tls_certificateauthority: null,
				customfunctions_tls_privatekey: TEST_PRIVATE_KEY,
				http_threads: 4,
				http_remoteaddressaffinity: false,
				clustering_ingest_threads: 1,
				localstudio_enabled: true,
				logging_auditlog: true,
				logging_file: false,
				logging_level: 'notify',
				logging_rotation_compress: true,
				logging_rotation_dateformat: 'YYYY-MM-DD',
				logging_rotation_maxsize: '5M',
				logging_rotation_retain: 20,
				logging_rotation_rotate: true,
				logging_rotation_rotateinterval: '0 0 0 0 0',
				logging_rotation_rotatemodule: false,
				logging_rotation_timezone: 'CST',
				logging_rotation_workerinterval: 20,
				logging_root: path.join(DIRNAME, '/testlogging'),
				logging_stdstreams: true,
				operationsapi_authentication_operationtokentimeout: '2d',
				operationsapi_authentication_refreshtokentimeout: '31d',
				operationsapi_foreground: true,
				operationsapi_network_cors: false,
				operationsapi_network_corsaccesslist: ['test1', 'test2'],
				operationsapi_network_headerstimeout: 60001,
				operationsapi_network_https: true,
				operationsapi_network_keepalivetimeout: 5001,
				operationsapi_network_port: 2599,
				operationsapi_network_timeout: 120001,
				operationsapi_nodeenv: 'development',
				rootpath: path.join(DIRNAME, '/yaml'),
				storage_writeasync: true,
				storage_overlappingsync: false,
				storage_caching: false,
				storage_compression: false,
				storage_noreadahead: false,
				storage_prefetchwrites: false,
				operationsapi_tls_certificate: TEST_CERT,
				operationsapi_tls_certificateauthority: null,
				operationsapi_tls_privatekey: TEST_PRIVATE_KEY,
			};

			config_utils_rw.createConfigFile(TEST_ARGS);

			const test_config_doc = YAML.parseDocument(fs.readFileSync(CONFIG_FILE_PATH, 'utf8'));
			const config_json = test_config_doc.toJSON();
			const test_flat_config_obj = config_utils_rw.flattenConfig(config_json);

			expect(config_json).to.eql(expected_config);
			expect(test_flat_config_obj).to.eql(expected_flat_config);
		});
	});

	describe('Test getDefaultConfig function', () => {
		const expected_flat_default_config_obj = {
			clustering_enabled: false,
			clustering_hubserver_cluster_name: 'harperdb',
			clustering_hubserver_cluster_network_port: 9932,
			clustering_hubserver_cluster_network_routes: null,
			clustering_hubserver_leafnodes_network_port: 9931,
			clustering_hubserver_network_port: 9930,
			clustering_ingest_threads: 1,
			clustering_leafserver_network_port: 9940,
			clustering_leafserver_network_routes: null,
			clustering_leafserver_streams_maxage: null,
			clustering_leafserver_streams_maxbytes: null,
			clustering_leafserver_streams_maxmsgs: null,
			clustering_leafserver_streams_path: null,
			clustering_nodename: null,
			clustering_tls_certificate: null,
			clustering_tls_certificateauthority: null,
			clustering_tls_privatekey: null,
			clustering_tls_insecure: true,
			clustering_user: null,
			customfunctions_enabled: true,
			customfunctions_network_cors: true,
			customfunctions_network_corsaccesslist: [null],
			customfunctions_network_headerstimeout: 60000,
			customfunctions_network_https: false,
			customfunctions_network_keepalivetimeout: 5000,
			customfunctions_network_port: 9926,
			customfunctions_network_timeout: 120000,
			customfunctions_nodeenv: 'production',
			customfunctions_root: null,
			customfunctions_tls_certificate: null,
			customfunctions_tls_certificateauthority: null,
			customfunctions_tls_privatekey: null,
			http_threads: null,
			http_remoteaddressaffinity: false,
			localstudio_enabled: false,
			logging_auditlog: false,
			logging_file: true,
			logging_level: 'error',
			logging_root: null,
			logging_rotation_compress: false,
			logging_rotation_dateformat: 'YYYY-MM-DD_HH-mm-ss',
			logging_rotation_maxsize: '10M',
			logging_rotation_retain: 30,
			logging_rotation_rotate: false,
			logging_rotation_rotateinterval: '0 0 * * *',
			logging_rotation_rotatemodule: true,
			logging_rotation_timezone: 'GMT',
			logging_rotation_workerinterval: 30,
			logging_stdstreams: false,
			operationsapi_authentication_operationtokentimeout: '1d',
			operationsapi_authentication_refreshtokentimeout: '30d',
			operationsapi_foreground: false,
			operationsapi_network_cors: true,
			operationsapi_network_corsaccesslist: [null],
			operationsapi_network_headerstimeout: 60000,
			operationsapi_network_https: false,
			operationsapi_network_keepalivetimeout: 5000,
			operationsapi_network_port: 9925,
			operationsapi_network_timeout: 120000,
			operationsapi_nodeenv: 'production',
			rootpath: null,
			storage_writeasync: false,
			storage_caching: true,
			storage_compression: false,
			storage_noreadahead: true,
			storage_prefetchwrites: true,
			operationsapi_tls_certificate: null,
			operationsapi_tls_certificateauthority: null,
			operationsapi_tls_privatekey: null,
		};
		let flat_default_config_obj_rw;

		afterEach(() => {
			flat_default_config_obj_rw();
		});

		it('Test if in-memory object is undefined, the default config obj is instantiated and default value is returned', () => {
			flat_default_config_obj_rw = config_utils_rw.__set__('flat_default_config_obj', undefined);

			const value = config_utils_rw.getDefaultConfig(hdbTerms.CONFIG_PARAMS.CLUSTERING_ENABLED);
			const flat_default_config_obj = config_utils_rw.__get__('flat_default_config_obj');

			expect(value).to.be.false;
			expect(flat_default_config_obj).to.eql(expected_flat_default_config_obj);
		});

		it('Test that if the in-memory object exists, the correct default value is returned', () => {
			flat_default_config_obj_rw = config_utils_rw.__set__('flat_default_config_obj', expected_flat_default_config_obj);
			const parse_document_spy = sandbox.spy(YAML, 'parseDocument');

			const value = config_utils_rw.getDefaultConfig(hdbTerms.CONFIG_PARAMS.LOGGING_ROTATION_COMPRESS);
			const value2 = config_utils_rw.getDefaultConfig(hdbTerms.CONFIG_PARAMS.CUSTOMFUNCTIONS_TLS_CERTIFICATE);
			const value3 = config_utils_rw.getDefaultConfig(hdbTerms.CONFIG_PARAMS.CLUSTERING_HUBSERVER_CLUSTER_NETWORK_PORT);

			expect(value).to.be.false;
			expect(value2).to.be.null;
			expect(value3).to.equal(9932);
			expect(parse_document_spy.callCount).to.equal(0);
		});
	});

	describe('Test getConfigValue function', () => {
		let flat_config_obj_rw;
		let logger_trace_stub;

		before(() => {
			logger_trace_stub = sandbox.stub(logger, 'trace');
		});

		afterEach(() => {
			flat_config_obj_rw();
		});

		after(() => {
			sandbox.restore();
		});

		it('Test if param is defined in instantiated default config, returns in-memory value', () => {
			flat_config_obj_rw = config_utils_rw.__set__('flat_config_obj', FLAT_CONFIG_OBJ);

			const value = config_utils_rw.getConfigValue(hdbTerms.CONFIG_PARAMS.CUSTOMFUNCTIONS_ENABLED);

			expect(value).to.be.false;
		});

		it('Test if param isnt defined in instantiated default config, returns undefined', () => {
			flat_config_obj_rw = config_utils_rw.__set__('flat_config_obj', FLAT_CONFIG_OBJ);
			const logger_error_stub = sandbox.stub(logger, 'error');

			const value = config_utils_rw.getConfigValue(hdbTerms.CONFIG_PARAMS.CUSTOMFUNCTIONS_ON);

			expect(logger_error_stub.firstCall.args[0]).to.equal(EMPTY_GET_VALUE);
			expect(value).to.be.undefined;
		});

		it('Test if in-memory obj doesnt exist, returns undefined', () => {
			flat_config_obj_rw = config_utils_rw.__set__('flat_config_obj', undefined);

			const value = config_utils_rw.getConfigValue(hdbTerms.CONFIG_PARAMS.CUSTOMFUNCTIONS_ENABLED);

			expect(logger_trace_stub.firstCall.args[0]).to.equal(UNINIT_GET_CONFIG_ERR);
			expect(value).to.be.undefined;
		});
	});

	describe('Test initConfig function', () => {
		let flat_config_obj_rw;
		let validate_config_rw;
		let properties_reader_rw;
		let logger_trace_stub;
		let validate_config_stub;
		let properties_reader_stub;
		let get_props_file_path_stub;
		let access_sync_stub;

		before(() => {
			properties_reader_stub = sandbox.stub();
			get_props_file_path_stub = sandbox.stub(common_utils, 'getPropsFilePath');
			properties_reader_rw = config_utils_rw.__set__('PropertiesReader', properties_reader_stub);
		});

		beforeEach(() => {
			logger_trace_stub = sandbox.stub(logger, 'trace');
			access_sync_stub = sandbox.stub(fs, 'accessSync');
			validate_config_stub = sandbox.stub();
			validate_config_rw = config_utils_rw.__set__('validateConfig', validate_config_stub);
		});

		afterEach(() => {
			sandbox.restore();
			logger_trace_stub.restore();
			get_props_file_path_stub.restore();
			access_sync_stub.restore();
			validate_config_rw();
			properties_reader_rw();
			fs.unlinkSync(CONFIG_FILE_PATH);
		});

		it('Test in-memory obj undefined, function reads config doc and adds values to object', () => {
			config_utils_rw.createConfigFile(TEST_ARGS_2);

			flat_config_obj_rw = config_utils_rw.__set__('flat_config_obj', undefined);
			get_props_file_path_stub.returns(CONFIG_FILE_PATH);
			access_sync_stub.returns(true);
			properties_reader_stub.returns({
				get: () => CONFIG_FILE_PATH,
			});
			config_utils_rw.__set__('PropertiesReader', properties_reader_stub);

			config_utils_rw.initConfig();

			expect(logger_trace_stub.secondCall.args[0]).to.equal(CONFIG_INIT_MSG);
		});

		it('Test parameter "force" is true, function reads config doc and adds values to object', () => {
			config_utils_rw.createConfigFile(TEST_ARGS_2);

			get_props_file_path_stub.returns(CONFIG_FILE_PATH);
			access_sync_stub.returns(true);
			properties_reader_stub.returns({
				get: () => CONFIG_FILE_PATH,
			});
			config_utils_rw.__set__('PropertiesReader', properties_reader_stub);

			config_utils_rw.initConfig(true);

			expect(logger_trace_stub.secondCall.args[0]).to.equal(CONFIG_INIT_MSG);
		});

		it('Test in-memory obj undefined, config file path undefined and error is caught', () => {
			config_utils_rw.createConfigFile(TEST_ARGS_2);

			flat_config_obj_rw = config_utils_rw.__set__('flat_config_obj', undefined);
			get_props_file_path_stub.returns(CONFIG_FILE_PATH);
			access_sync_stub.returns(true);
			properties_reader_stub.returns({
				get: () => path.join(DIRNAME, 'yaml', 'harperdb.doesntexist'),
			});
			config_utils_rw.__set__('PropertiesReader', properties_reader_stub);

			config_utils_rw.initConfig();

			expect(logger_trace_stub.secondCall.args[0]).to.equal(UNDFND_CONFIG_FILE_PATH_MSG);
		});
	});

	describe('Test validateConfig function', () => {
		let validate_config;
		let config_validator_stub;

		before(() => {
			validate_config = config_utils_rw.__get__('validateConfig');
		});

		it('Test error message is thrown if there is a validation error', () => {
			const test_val_config_obj = {
				value: {},
				error: {
					message: UNDEFINED_OPS_API,
				},
			};

			config_utils_rw.createConfigFile(TEST_ARGS_3);
			TEST_ARGS_3['ROOTPATH'] = '';

			const test_config_doc = YAML.parseDocument(fs.readFileSync(CONFIG_FILE_PATH, 'utf8'));
			const test_config_json = test_config_doc.toJSON();
			config_validator_stub = sandbox.stub().returns(test_val_config_obj);
			config_utils_rw.__set__('configValidator', config_validator_stub);

			let error;
			try {
				validate_config(test_config_doc);
			} catch (err) {
				error = err;
			}

			expect(error).to.equal('HarperDB config file validation error: operationsApi.root config parameter is undefined');
			expect(config_validator_stub.calledOnce).to.be.true;
			expect(config_validator_stub.firstCall.args[0]).to.eql(test_config_json);

			fs.unlinkSync(CONFIG_FILE_PATH);
		});

		it('Test necessary parameters are setIn by validator', () => {
			const fake_json = {};
			const fake_validation = {
				value: {
					clustering: {
						enabled: false,
						leafServer: {
							streams: {
								path: 'user/harperdb/streams',
							},
						},
						tls: {
							certificate: '/yaml/keys/certificate.pem',
							certificateAuthority: '/yaml/keys/ca.pem',
							privateKey: '/yaml/keys/privateKey.pem',
						},
					},
					customFunctions: {
						enabled: false,
						root: '/yaml/custom_functions',
						tls: {
							certificate: '/yaml/keys/certificate.pem',
							certificateAuthority: '/yaml/keys/ca.pem',
							privateKey: '/yaml/keys/privateKey.pem',
						},
					},
					logging: {
						root: '/yaml/log',
					},
					operationsApi: {
						// 23250
						tls: {
							certificate: '/yaml/keys/certificate.pem',
							certificateAuthority: '/yaml/keys/ca.pem',
							privateKey: '/yaml/keys/privateKey.pem',
						},
					},
					http: {
						threads: 12,
						remoteAddressAffinity: false,
					},
				},
			};

			const set_in_stub = sandbox.stub().callsFake(() => {});

			const fake_config_doc = {
				value: {},
				toJSON: () => fake_json,
				setIn: set_in_stub,
			};
			config_validator_stub = sandbox.stub().returns(fake_validation);
			config_utils_rw.__set__('configValidator', config_validator_stub);

			let error;
			try {
				validate_config(fake_config_doc);
			} catch (err) {
				error = err;
			}

			expect(error).to.not.exist;
			expect(config_validator_stub.called).to.be.true;
			expect(set_in_stub.firstCall.args[0]).to.eql(['http', 'threads']);
			expect(set_in_stub.firstCall.args[1]).to.equal(12);
			expect(set_in_stub.secondCall.args[0]).to.eql(['customFunctions', 'root']);
			expect(set_in_stub.secondCall.args[1]).to.equal(CF_ROOT);
			expect(set_in_stub.args[2][0]).to.eql(['logging', 'root']);
			expect(set_in_stub.args[2][1]).to.equal(LOG_ROOT);
			expect(set_in_stub.args[3][0]).to.eql(['operationsApi', 'tls', 'certificate']);
			expect(set_in_stub.args[3][1]).to.equal(CERT_PEM);
			expect(set_in_stub.args[4][0]).to.eql(['operationsApi', 'tls', 'privateKey']);
			expect(set_in_stub.args[4][1]).to.equal(KEY_PEM);
			expect(set_in_stub.args[5][0]).to.eql(['operationsApi', 'tls', 'certificateAuthority']);
			expect(set_in_stub.args[5][1]).to.equal(CA_PEM);
			expect(set_in_stub.args[6][0]).to.eql(['customFunctions', 'tls', 'certificate']);
			expect(set_in_stub.args[6][1]).to.equal(CERT_PEM);
			expect(set_in_stub.args[7][0]).to.eql(['customFunctions', 'tls', 'privateKey']);
			expect(set_in_stub.args[7][1]).to.equal(KEY_PEM);
			expect(set_in_stub.args[8][0]).to.eql(['customFunctions', 'tls', 'certificateAuthority']);
			expect(set_in_stub.args[8][1]).to.equal(CA_PEM);
			expect(set_in_stub.args[9][0]).to.eql(['clustering', 'tls', 'certificate']);
			expect(set_in_stub.args[9][1]).to.equal(CERT_PEM);
			expect(set_in_stub.args[10][0]).to.eql(['clustering', 'tls', 'privateKey']);
			expect(set_in_stub.args[10][1]).to.equal(KEY_PEM);
			expect(set_in_stub.args[11][0]).to.eql(['clustering', 'tls', 'certificateAuthority']);
			expect(set_in_stub.args[11][1]).to.equal(CA_PEM);
			expect(set_in_stub.args[12][0]).to.eql(['clustering', 'leafServer', 'streams', 'path']);
			expect(set_in_stub.args[12][1]).to.equal('user/harperdb/streams');
		});
	});

	describe('Test updateConfigObject function', () => {
		let flat_config_obj_rw;

		afterEach(() => {
			flat_config_obj_rw();
		});

		it('Test happy path in-memory obj is updated', () => {
			const expected_flat_config = { logging_level: 'fatal' };
			const flat_config = { logging_level: 'notify' };
			flat_config_obj_rw = config_utils_rw.__set__('flat_config_obj', flat_config);
			config_utils_rw.updateConfigObject(hdbTerms.CONFIG_PARAMS.LOGGING_LEVEL, 'fatal');

			expect(flat_config).to.eql(expected_flat_config);
		});

		it('Test logger trace message if param doesnt exist', () => {
			const logger_trace_stub = sandbox.stub(logger, 'trace');
			const flat_config = { logging_level: 'notify' };
			flat_config_obj_rw = config_utils_rw.__set__('flat_config_obj', flat_config);

			config_utils_rw.updateConfigObject('fake_logging_level', 'fatal');

			expect(logger_trace_stub.firstCall.args[0]).to.equal(
				`Unable to update config object because config param 'fake_logging_level' does not exist`
			);
			logger_trace_stub.restore();
		});
	});

	describe('Test updateConfigValue function', () => {
		let validate_config_stub;
		let validate_config_rw;
		let logger_trace_stub;

		beforeEach(() => {
			logger_trace_stub = sandbox.stub(logger, 'trace');
			validate_config_stub = sandbox.stub();
			validate_config_rw = config_utils_rw.__set__('validateConfig', validate_config_stub);
		});

		afterEach(() => {
			logger_trace_stub.restore();
			validate_config_rw();
		});

		it('Test happy path where backup and update_config_obj are true', () => {
			config_utils_rw.createConfigFile(TEST_ARGS_2);

			config_utils_rw.updateConfigValue(hdbTerms.CONFIG_PARAMS.LOGGING_LEVEL, 'debug', undefined, true, true);

			expect(logger_trace_stub.secondCall.args[0]).to.equal(
				`Config file: ${CONFIG_FILE_PATH} backed up to: ${BACKUP_FILE_PATH}`
			);
			expect(logger_trace_stub.thirdCall.args[0]).to.equal(
				`Config parameter: ${hdbTerms.CONFIG_PARAMS.LOGGING_LEVEL} updated with value: debug`
			);

			fs.unlinkSync(CONFIG_FILE_PATH);
			fs.unlinkSync(BACKUP_FILE_PATH);
			fs.rmdirSync(BACKUP_FOLDER_PATH);
		});

		it('Test happy path with parsed_args and where backup and update_config_obj are false', () => {
			const set_in_stub = sandbox.stub().callsFake(() => {});
			const get_in_stub = sandbox.stub().callsFake(() => HDB_ROOT);
			const fake_config_doc = {
				value: CONFIG_DOC_VALUE,
				setIn: set_in_stub,
				getIn: get_in_stub,
			};
			const parse_yaml_doc_stub = sandbox.stub().returns(fake_config_doc);
			config_utils_rw.__set__('parseYamlDoc', parse_yaml_doc_stub);
			const flat_config_obj = {
				clustering_enabled: false,
				clustering_hubserver_cluster_name: 'harperdb',
				clustering_hubserver_cluster_network_port: 9932,
				clustering_hubserver_cluster_network_routes: [
					{
						ip: null,
						port: null,
					},
				],
				clustering_hubserver_leafnodes_network_port: 9931,
				clustering_hubserver_network_port: 9930,
				clustering_ingestservice_processes: 1,
				clustering_leafserver_network_port: 9940,
				clustering_nodename: null,
				clustering_replyservice_processes: 1,
				clustering_tls_certificate: null,
				clustering_tls_certificateauthority: null,
				clustering_tls_privatekey: null,
				clustering_user: null,
				customfunctions_enabled: false,
				customfunctions_network_cors: true,
				customfunctions_network_corsaccesslist: [null],
				customfunctions_network_headerstimeout: 60000,
				customfunctions_network_https: false,
				customfunctions_network_keepalivetimeout: 5000,
				customfunctions_network_port: 9926,
				customfunctions_network_timeout: 120000,
				customfunctions_nodeenv: 'production',
				customfunctions_processes: null,
				customfunctions_root: null,
				customfunctions_tls_certificate: null,
				customfunctions_tls_certificateauthority: null,
				customfunctions_tls_privatekey: null,
				localstudio_enabled: false,
				logging_auditlog: false,
				logging_file: true,
				logging_level: 'error',
				logging_root: null,
				logging_rotation_compress: false,
				logging_rotation_dateformat: 'YYYY-MM-DD_HH-mm-ss',
				logging_rotation_maxsize: '10M',
				logging_rotation_retain: 30,
				logging_rotation_rotate: false,
				logging_rotation_rotateinterval: '0 0 * * *',
				logging_rotation_rotatemodule: true,
				logging_rotation_timezone: 'GMT',
				logging_rotation_workerinterval: 30,
				logging_stdstreams: false,
				operationsapi_authentication_operationtokentimeout: '1d',
				operationsapi_authentication_refreshtokentimeout: '30d',
				operationsapi_foreground: false,
				operationsapi_network_cors: true,
				operationsapi_network_corsaccesslist: [null],
				operationsapi_network_headerstimeout: 60000,
				operationsapi_network_https: false,
				operationsapi_network_keepalivetimeout: 5000,
				operationsapi_network_port: 9925,
				operationsapi_network_timeout: 120000,
				operationsapi_nodeenv: 'production',
				operationsapi_processes: null,
				rootpath: HDB_ROOT,
				storage_writeasync: true,
				storage_overlappingsync: false,
				storage_caching: false,
				storage_compression: false,
				storage_noreadahead: false,
				storage_prefetchwrites: false,
				operationsapi_tls_certificate: null,
				operationsapi_tls_certificateauthority: null,
				operationsapi_tls_privatekey: null,
			};
			config_utils_rw.__set__('flat_config_obj', flat_config_obj);

			config_utils_rw.updateConfigValue(
				undefined,
				undefined,
				{
					logging_level: 'warn',
					logging_stdStreams: true,
					logging_rotation_compress: true,
					fake_config_param: 'fake_value',
				},
				false,
				false
			);

			expect(set_in_stub.calledThrice).to.be.true;
			expect(set_in_stub.firstCall.args[0][0]).to.equal('logging');
			expect(set_in_stub.firstCall.args[0][1]).to.equal('level');
			expect(set_in_stub.firstCall.args[1]).to.equal('warn');
			expect(set_in_stub.secondCall.args[0][0]).to.equal('logging');
			expect(set_in_stub.secondCall.args[0][1]).to.equal('stdStreams');
			expect(set_in_stub.secondCall.args[1]).to.be.true;
			expect(set_in_stub.thirdCall.args[0][0]).to.equal('logging');
			expect(set_in_stub.thirdCall.args[0][1]).to.equal('rotation');
			expect(set_in_stub.thirdCall.args[0][2]).to.equal('compress');
			expect(set_in_stub.thirdCall.args[1]).to.be.true;

			fs.unlinkSync(CONFIG_FILE_PATH);
		});

		it('Test that if there is no in-memory obj, initConfig is hit PLUS it handles error with bad param', () => {
			config_utils_rw.__set__('flat_config_obj', undefined);
			const init_config_spy = sandbox.spy();
			config_utils_rw.__set__('initConfig', init_config_spy);
			const get_config_value_stub = sandbox.stub().returns(HDB_ROOT);
			config_utils_rw.__set__('getConfigValue', get_config_value_stub);
			const set_in_stub = sandbox.stub().callsFake(() => {});
			const get_in_stub = sandbox.stub().callsFake(() => HDB_ROOT);
			const fake_config_doc = {
				value: CONFIG_DOC_VALUE,
				setIn: set_in_stub,
				getIn: get_in_stub,
			};
			const parse_yaml_doc_stub = sandbox.stub().returns(fake_config_doc);
			config_utils_rw.__set__('parseYamlDoc', parse_yaml_doc_stub);

			test_utils.assertErrorSync(
				config_utils_rw.updateConfigValue,
				['FAKE_TIMEZONE', 'test_timezone', undefined, false, false],
				new Error('Unable to update config, unrecognized config parameter: FAKE_TIMEZONE')
			);

			expect(init_config_spy.callCount).to.equal(1);
		});
	});

	describe('Test castConfigValue function', () => {
		const cast_config_value_rw = config_utils_rw.__get__('castConfigValue');

		it('Test nodeName and user as number value returns string', () => {
			const result = cast_config_value_rw(hdb_terms.CONFIG_PARAMS.CLUSTERING_NODENAME, 44);
			expect(result).to.equal('44');

			const result_2 = cast_config_value_rw(hdb_terms.CONFIG_PARAMS.CLUSTERING_USER, 10014);
			expect(result_2).to.equal('10014');
		});

		it('Test nodeName and user as true/false strings returns the value as strings', () => {
			const result = cast_config_value_rw(hdb_terms.CONFIG_PARAMS.CLUSTERING_NODENAME, 'TrUe');
			expect(result).to.equal('TrUe');

			const result_2 = cast_config_value_rw(hdb_terms.CONFIG_PARAMS.CLUSTERING_USER, 'FALSE');
			expect(result_2).to.equal('FALSE');
		});

		it('Test number value returns number', () => {
			const result = cast_config_value_rw(hdb_terms.CONFIG_PARAMS.LOGGING_ROTATION_COMPRESS, 15.33);
			expect(result).to.equal(15.33);

			const result_2 = cast_config_value_rw(hdb_terms.CONFIG_PARAMS.LOCALSTUDIO_ENABLED, '0.777');
			expect(result_2).to.equal(0.777);

			const result_3 = cast_config_value_rw(hdb_terms.CONFIG_PARAMS.LOCALSTUDIO_ENABLED, '-44.6');
			expect(result_3).to.equal(-44.6);
		});

		it('Test if value is boolean, boolean is returned', () => {
			const result = cast_config_value_rw(hdb_terms.CONFIG_PARAMS.LOGGING_ROTATION_COMPRESS, true);
			expect(result).to.equal(true);

			const result_2 = cast_config_value_rw(hdb_terms.CONFIG_PARAMS.LOGGING_ROTATION_COMPRESS, false);
			expect(result_2).to.equal(false);
		});

		it('Test if value is true/false string, boolean is returned', () => {
			const result = cast_config_value_rw(hdb_terms.CONFIG_PARAMS.LOCALSTUDIO_ENABLED, 'true');
			expect(result).to.equal(true);

			const result_2 = cast_config_value_rw(hdb_terms.CONFIG_PARAMS.LOCALSTUDIO_ENABLED, 'false');
			expect(result_2).to.equal(false);
		});

		it('Test if value is undefined or undefined as string, null is returned', () => {
			const result = cast_config_value_rw(hdb_terms.CONFIG_PARAMS.LOGGING_LEVEL, 'undefined');
			expect(result).to.equal(null);

			const result_2 = cast_config_value_rw(hdb_terms.CONFIG_PARAMS.LOGGING_LEVEL, undefined);
			expect(result_2).to.equal(null);
		});

		it('Test if value is an object, string, or array, the same data type is returned', () => {
			const result = cast_config_value_rw(hdb_terms.CONFIG_PARAMS.LOGGING_LEVEL, { bleep: 'bloop' });
			expect(result).to.eql({ bleep: 'bloop' });

			const result_2 = cast_config_value_rw(hdb_terms.CONFIG_PARAMS.LOCALSTUDIO_ENABLED, [true, false, 25]);
			expect(result_2).to.eql([true, false, 25]);

			const result_3 = cast_config_value_rw(hdb_terms.CONFIG_PARAMS.LOCALSTUDIO_ENABLED, 'cool string');
			expect(result_3).to.equal('cool string');
		});
	});

	describe('Test getConfiguration function', () => {
		it('Test a config object is returned', () => {
			const get_props_file_path_stub = sandbox.stub(common_utils, 'getPropsFilePath').returns(CONFIG_FILE_PATH);
			const properties_reader_stub = sandbox.stub().returns({
				get: () => CONFIG_FILE_PATH,
			});
			const properties_reader_rw = config_utils_rw.__set__('PropertiesReader', properties_reader_stub);
			const fake_config_doc = {
				value: CONFIG_DOC_VALUE,
				toJSON: () => FAKE_JSON_1,
			};
			const parse_yaml_doc_stub = sandbox.stub().returns(fake_config_doc);
			config_utils_rw.__set__('parseYamlDoc', parse_yaml_doc_stub);

			const result = config_utils_rw.getConfiguration();

			expect(get_props_file_path_stub.called).to.be.true;
			expect(properties_reader_stub.called).to.be.true;
			expect(properties_reader_stub.args[0]).to.eql([CONFIG_FILE_PATH]);
			expect(result).to.eql(FAKE_JSON_1);

			get_props_file_path_stub.restore();
			properties_reader_rw();
		});
	});
	describe('Test setConfiguration function', async () => {
		let update_config_value_stub;
		let update_config_value_rw;

		beforeEach(() => {
			update_config_value_stub = sandbox.stub();
			update_config_value_rw = config_utils_rw.__set__('updateConfigValue', update_config_value_stub);
		});

		afterEach(() => {
			sandbox.restore();
			update_config_value_rw();
		});

		it('Test happy path success response returned', async () => {
			const test_set_config_json = {
				operation: 'set_configuration',
				operationsApi_processes: 18,
				hdb_user: {},
				hdb_auth_header: 'test_header',
			};

			const result = await config_utils_rw.setConfiguration(test_set_config_json);

			expect(result).to.equal(CONFIGURE_SUCCESS_RESPONSE);
		});

		it('Test error handled if updateConfigValue throws error', async () => {
			const test_set_config_json = {
				operation: 'set_configuration',
				logging_rotation_maxSize: true,
				hdb_user: {},
				hdb_auth_header: 'test_header',
			};

			update_config_value_stub.throws(STRING_ERROR);

			let error;
			try {
				await config_utils_rw.setConfiguration(test_set_config_json);
			} catch (err) {
				error = err;
			}

			expect(error.name).to.equal(STRING_ERROR);
		});
	});
	describe('Test readConfigFile function', () => {
		let properties_reader_rw;
		let properties_reader_stub;
		let get_props_file_path_stub;

		before(() => {
			properties_reader_stub = sandbox.stub().returns({
				get: () => CONFIG_FILE_PATH,
			});
			properties_reader_rw = config_utils_rw.__set__('PropertiesReader', properties_reader_stub);
		});

		beforeEach(() => {
			get_props_file_path_stub = sandbox.stub(common_utils, 'getPropsFilePath');
		});

		afterEach(() => {
			sandbox.restore();
			get_props_file_path_stub.restore();
			properties_reader_rw();
		});

		it('Test happy path, function returns json config object', () => {
			const fake_config_doc = {
				value: CONFIG_DOC_VALUE,
				toJSON: () => FAKE_JSON_1,
			};
			sandbox.stub(fs, 'accessSync');
			const parse_yaml_doc_stub = sandbox.stub().returns(fake_config_doc);
			config_utils_rw.__set__('parseYamlDoc', parse_yaml_doc_stub);

			const result = config_utils_rw.readConfigFile();

			expect(result).to.eql(FAKE_JSON_1);
		});

		it('Test that function handles error if boot props file doesnt exist', () => {
			get_props_file_path_stub.returns(BAD_CONFIG_FILE_PATH);
			const logger_error_stub = sandbox.stub(logger, 'error');

			let error;
			try {
				config_utils_rw.readConfigFile();
			} catch (err) {
				error = err;
			}

			expect(error.message).to.equal(`HarperDB properties file at path ${BAD_CONFIG_FILE_PATH} does not exist`);
			expect(logger_error_stub.firstCall.args[0].message).to.equal(
				`ENOENT: no such file or directory, access '${BAD_CONFIG_FILE_PATH}'`
			);
		});
	});

	it('Test getClusteringRoutes returns the correct routes', () => {
		const fake_json_config = {
			clustering: {
				hubServer: {
					cluster: {
						network: {
							routes: [
								{
									host: '3.6.3.3',
									port: 7916,
								},
								{
									host: '4.4.4.6',
									port: 7117,
								},
							],
						},
					},
				},
				leafServer: {
					network: {
						routes: [{ host: 'leaf.server', port: 1111 }],
					},
				},
			},
		};
		const read_config_file_stub = sandbox.stub().returns(fake_json_config);
		config_utils_rw.__set__('readConfigFile', read_config_file_stub);
		const routes = config_utils_rw.getClusteringRoutes();
		expect(routes).to.eql({
			hub_routes: [
				{
					host: '3.6.3.3',
					port: 7916,
				},
				{
					host: '4.4.4.6',
					port: 7117,
				},
			],
			leaf_routes: [{ host: 'leaf.server', port: 1111 }],
		});
	});

	it('Test getClusteringRoutes returns empty array if no routes', () => {
		const fake_json_config = {
			clustering: {
				hubServer: {
					cluster: {
						network: {
							routes: null,
						},
					},
				},
			},
		};
		const read_config_file_stub = sandbox.stub().returns(fake_json_config);
		config_utils_rw.__set__('readConfigFile', read_config_file_stub);
		const routes = config_utils_rw.getClusteringRoutes();
		expect(routes).to.eql({
			hub_routes: [],
			leaf_routes: [],
		});
	});

	it('Test validation error thrown if there are duplicate hub/leaf routes', () => {
		const fake_json_config = {
			clustering: {
				hubServer: {
					cluster: {
						network: {
							routes: [
								{
									host: '3.6.3.3',
									port: 7916,
								},
								{
									host: '4.4.4.6',
									port: 7117,
								},
							],
						},
					},
				},
				leafServer: {
					network: {
						routes: [
							{
								host: '3.6.3.3',
								port: 7916,
							},
						],
					},
				},
			},
		};
		const read_config_file_stub = sandbox.stub().returns(fake_json_config);
		config_utils_rw.__set__('readConfigFile', read_config_file_stub);
		let error;
		try {
			config_utils_rw.getClusteringRoutes();
		} catch (err) {
			error = err;
		}

		expect(error).to.equal(
			'HarperDB config file validation error: Duplicate hub and leaf routes found [{"host":"3.6.3.3","port":7916}]'
		);
	});

	describe('Test initOldConfig function', () => {
		function matchParam(param, config_obj) {
			for (const [key, value] of Object.entries(config_obj)) {
				if (key === param) {
					return value;
				}
			}
		}
		const old_props = {
			'HDB_ROOT': path.join(__dirname, '../../'),
			'SERVER_PORT': 9925,
			'CERTIFICATE': path.join(__dirname, '../../keys/certificate.pem'),
			'PRIVATE_KEY': path.join(__dirname, '../../keys/privateKey.pem'),
			'HTTPS_ON': '',
			'CORS_ON': true,
			'LOG_LEVEL': 'error',
			'LOG_PATH': path.join(__dirname, '../../log/hdb_log.log'),
			'NODE_ENV': [],
			'CLUSTERING': false,
			'MAX_HDB_PROCESSES': 12,
			'SERVER_TIMEOUT_MS': 120000,
			'SERVER_KEEP_ALIVE_TIMEOUT': 5000,
			'SERVER_HEADERS_TIMEOUT': 60000,
			'DISABLE_TRANSACTION_LOG': false,
			'OPERATION_TOKEN_TIMEOUT': '1d',
			'REFRESH_TOKEN_TIMEOUT': '30d',
			'CUSTOM_FUNCTIONS': false,
			'CUSTOM_FUNCTIONS_PORT': 9926,
			'CUSTOM_FUNCTIONS_DIRECTORY': path.join(__dirname, '../../custom_functions'),
			'MAX_CUSTOM_FUNCTION_PROCESSES': 12,
			'LOG_TO_FILE': true,
			'LOG_TO_STDSTREAMS': false,
			'RUN_IN_FOREGROUND': false,
			';Settings for the HarperDB process.': '',
		};
		const EXPECTED_CONFIG_OBJ = {
			rootpath: path.join(__dirname, '../../'),
			operationsapi_network_port: 9925,
			operationsapi_tls_certificate: path.join(__dirname, '../../keys/certificate.pem'),
			operationsapi_tls_privatekey: path.join(__dirname, '../../keys/privateKey.pem'),
			operationsapi_network_cors: true,
			logging_level: 'error',
			logging_root: path.join(__dirname, '../../log'),
			operationsapi_nodeenv: [],
			clustering_enabled: false,
			http_threads: 12,
			operationsapi_network_timeout: 120000,
			operationsapi_network_keepalivetimeout: 5000,
			operationsapi_network_headerstimeout: 60000,
			logging_auditlog: false,
			operationsapi_authentication_operationtokentimeout: '1d',
			operationsapi_authentication_refreshtokentimeout: '30d',
			customfunctions_enabled: false,
			customfunctions_network_port: 9926,
			customfunctions_root: path.join(__dirname, '../../custom_functions'),
			logging_file: true,
			logging_stdstreams: false,
			operationsapi_foreground: false,
		};

		after(() => {
			sandbox.restore();
		});

		it('Test updates in-memory config object', () => {
			let properties_reader_stub = sandbox.stub();
			config_utils_rw.__set__('PropertiesReader', properties_reader_stub);
			properties_reader_stub.returns({
				get: (x) => matchParam(x, old_props),
			});
			config_utils_rw.__set__('PropertiesReader', properties_reader_stub);

			const result = config_utils_rw.initOldConfig(OLD_CONFIG_PATH);

			expect(result).to.eql(EXPECTED_CONFIG_OBJ);
		});
	});
});
