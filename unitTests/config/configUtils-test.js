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
	CLUSTERING_REPLY_SERVICE_PROCESSES: '1',
	CLUSTERING_TLS_CERTIFICATE: TEST_CERT,
	CLUSTERING_TLS_PRIVATEKEY: TEST_PRIVATE_KEY,
	CLUSTERING_TLS_CERT_AUTH: TEST_CERT_AUTH,
	CLUSTERING_NETWORK_PORT: '54321',
	CLUSTERING_NETWORK_SELFSIGNEDSSLCERTS: true,
	CLUSTERING_NODENAME: 'test_node_name',
	CLUSTERING_REPUBLISHMESSAGES: true,
	CLUSTERING_DATABASELEVEL: false,
	HTTP_PORT: '9936',
	HTTP_CORS: false,
	HTTP_CORSACCESSLIST: '["test1", "test2"]',
	HTTP_HEADERSTIMEOUT: '59999',
	HTTP_KEEPALIVETIMEOUT: '4999',
	TLS_CERTIFICATE: TEST_CERT,
	TLS_CERTIFICATEAUTHORITY: null,
	TLS_PRIVATEKEY: TEST_PRIVATE_KEY,
	HTTP_TIMEOUT: '119999',
	COMPONENTSROOT: path.join(DIRNAME, 'test_custom_functions'),
	THREADS_COUNT: '4',
	THREADS_DEBUG: false,
	HTTP_REMOTE_ADDRESS_AFFINITY: false,
	LOCALSTUDIO_ENABLED: true,
	LOGGING_FILE: false,
	LOGGING_LEVEL: 'notify',
	LOGGING_ROOT: path.join(DIRNAME, 'testlogging'),
	LOGGING_ROTATION_ENABLED: true,
	LOGGING_ROTATION_COMPRESS: true,
	LOGGING_ROTATION_INTERVAL: '10D',
	LOGGING_ROTATION_MAXSIZE: '10M',
	LOGGING_ROTATION_PATH: 'lets/send/log/here',
	LOGGING_STDSTREAMS: true,
	LOGGING_AUDITLOG: true,
	AUTHENTICATION_OPERATIONTOKENTIMEOUT: '2d',
	AUTHENTICATION_REFRESHTOKENTIMEOUT: '31d',
	OPERATIONSAPI_NETWORK_CORS: false,
	OPERATIONSAPI_NETWORK_CORSACCESSLIST: '["test1", "test2"]',
	OPERATIONSAPI_NETWORK_HEADERSTIMEOUT: '60001',
	OPERATIONSAPI_NETWORK_HTTPS: true,
	OPERATIONSAPI_NETWORK_KEEPALIVETIMEOUT: '5001',
	OPERATIONSAPI_NETWORK_PORT: '2599',
	OPERATIONSAPI_NETWORK_TIMEOUT: '120001',
	ROOTPATH: HDB_ROOT,
	STORAGE_WRITEASYNC: true,
	STORAGE_OVERLAPPINGSYNC: false,
	STORAGE_CACHING: false,
	STORAGE_COMPRESSION: false,
	STORAGE_NOREADAHEAD: false,
	STORAGE_PREFETCHWRITES: false,
	STORAGE_PATH: 'users/unit_test/path',
};
const TEST_ARGS_2 = {
	CLUSTERING_ENABLED: true,
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
	clustering_leafserver_network_port: 9940,
	clustering_nodename: null,
	clustering_replyservice_processes: 1,
	clustering_tls_certificate: null,
	clustering_tls_certificateauthority: null,
	clustering_tls_privatekey: null,
	clustering_user: null,
	http_cors: true,
	http_corsaccesslist: [null],
	http_headerstimeout: 60000,
	customfunctions_network_https: false,
	http_keepalivetimeout: 5000,
	http_port: 9926,
	http_timeout: 120000,
	customfunctions_processes: null,
	componentsroot: null,
	tls_certificate: null,
	tls_certificateauthority: null,
	tls_privatekey: null,
	localstudio_enabled: false,
	logging_auditlog: true,
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
	authentication_operationtokentimeout: '1d',
	authentication_refreshtokentimeout: '30d',
	operationsapi_network_cors: true,
	operationsapi_network_corsaccesslist: [null],
	operationsapi_network_headerstimeout: 60000,
	operationsapi_network_https: false,
	operationsapi_network_keepalivetimeout: 5000,
	operationsapi_network_port: 9925,
	operationsapi_network_timeout: 120000,
	operationsapi_processes: null,
	rootpath: null,
	storage_writeasync: true,
	storage_overlappingsync: false,
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
				authentication: {
					cacheTTL: 30000,
					enableSessions: true,
					operationTokenTimeout: '2d',
					refreshTokenTimeout: '31d',
				},
				analytics: {
					aggregatePeriod: 60,
				},
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
					logLevel: 'info',
					nodeName: 'test_node_name',
					republishMessages: true,
					databaseLevel: false,
					tls: {
						certificate: TEST_CERT,
						certificateAuthority: null,
						privateKey: TEST_PRIVATE_KEY,
						insecure: true,
						verify: true,
					},
					user: 'test_user',
				},
				componentsRoot: path.join(DIRNAME, '/test_custom_functions'),
				localStudio: {
					enabled: true,
				},
				logging: {
					auditAuthEvents: {
						logFailed: false,
						logSuccessful: false,
					},
					auditLog: true,
					auditRetention: '3d',
					file: false,
					level: 'notify',
					root: path.join(DIRNAME, '/testlogging'),
					rotation: {
						enabled: true,
						compress: true,
						interval: '10D',
						maxSize: '10M',
						path: 'lets/send/log/here',
					},
					stdStreams: true,
				},
				mqtt: {
					network: {
						mtls: false,
						port: 1883,
						securePort: 8883,
					},
					webSocket: true,
					requireAuthentication: true,
				},
				operationsApi: {
					network: {
						compressionThreshold: 0,
						cors: false,
						corsAccessList: ['test1', 'test2'],
						port: 2599,
						securePort: null,
						domainSocket: 'hdb/operations-server',
						headersTimeout: 60001,
						https: true,
						mtls: false,
						keepAliveTimeout: 5001,
						timeout: 120001,
					},
					tls: {
						certificate: TEST_CERT,
						certificateAuthority: null,
						privateKey: TEST_PRIVATE_KEY,
					},
				},
				http: {
					compressionThreshold: 0,
					cors: false,
					corsAccessList: ['test1', 'test2'],
					keepAliveTimeout: 4999,
					port: 9936,
					securePort: null,
					timeout: 119999,
					headersTimeout: 59999,
					mtls: false,
				},
				threads: {
					count: 4,
					debug: false,
				},
				rootPath: path.join(DIRNAME, '/yaml'),
				storage: {
					writeAsync: true,
					caching: false,
					compression: false,
					noReadAhead: false,
					path: 'users/unit_test/path',
					prefetchWrites: false,
					overlappingSync: false,
				},
				tls: {
					certificate: TEST_CERT,
					certificateAuthority: null,
					privateKey: TEST_PRIVATE_KEY,
				},
			};
			const expected_flat_config = {
				authentication_cachettl: 30000,
				authentication_enablesessions: true,
				authentication_operationtokentimeout: '2d',
				authentication_refreshtokentimeout: '31d',
				analytics_aggregateperiod: 60,
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
				clustering_loglevel: 'info',
				clustering_nodename: 'test_node_name',
				clustering_republishmessages: true,
				clustering_databaselevel: false,
				clustering_tls_certificate: TEST_CERT,
				clustering_tls_certificateauthority: null,
				clustering_tls_privatekey: TEST_PRIVATE_KEY,
				clustering_tls_insecure: true,
				clustering_tls_verify: true,
				clustering_user: 'test_user',
				componentsroot: path.join(DIRNAME, '/test_custom_functions'),
				localstudio_enabled: true,
				logging_auditauthevents_logfailed: false,
				logging_auditauthevents_logsuccessful: false,
				logging_auditlog: true,
				logging_auditretention: '3d',
				logging_file: false,
				logging_level: 'notify',
				logging_root: path.join(DIRNAME, '/testlogging'),
				logging_rotation_enabled: true,
				logging_rotation_compress: true,
				logging_rotation_interval: '10D',
				logging_rotation_maxsize: '10M',
				logging_rotation_path: 'lets/send/log/here',
				logging_stdstreams: true,
				mqtt_network_mtls: false,
				mqtt_network_port: 1883,
				mqtt_network_secureport: 8883,
				mqtt_websocket: true,
				mqtt_requireauthentication: true,
				operationsapi_network_compressionthreshold: 0,
				operationsapi_network_cors: false,
				operationsapi_network_corsaccesslist: ['test1', 'test2'],
				operationsapi_network_port: 2599,
				operationsapi_network_secureport: null,
				operationsapi_network_domainsocket: 'hdb/operations-server',
				operationsapi_network_headerstimeout: 60001,
				operationsapi_network_https: true,
				operationsapi_network_keepalivetimeout: 5001,
				operationsapi_network_timeout: 120001,
				http_compressionthreshold: 0,
				http_cors: false,
				http_corsaccesslist: ['test1', 'test2'],
				http_keepalivetimeout: 4999,
				http_port: 9936,
				http_secureport: null,
				http_mtls: false,
				threads_count: 4,
				threads_debug: false,
				http_timeout: 119999,
				http_headerstimeout: 59999,
				rootpath: path.join(DIRNAME, '/yaml'),
				storage_writeasync: true,
				storage_caching: false,
				storage_compression: false,
				storage_noreadahead: false,
				storage_path: 'users/unit_test/path',
				storage_prefetchwrites: false,
				storage_overlappingsync: false,
				tls_certificate: TEST_CERT,
				tls_certificateauthority: null,
				tls_privatekey: TEST_PRIVATE_KEY,
				operationsapi_tls_certificate: TEST_CERT,
				operationsapi_tls_privatekey: TEST_PRIVATE_KEY,
				operationsapi_tls_certificateauthority: null,
				operationsapi_network_mtls: false,
			};

			config_utils_rw.createConfigFile(TEST_ARGS);

			const test_config_doc = YAML.parseDocument(fs.readFileSync(CONFIG_FILE_PATH, 'utf8'));
			const config_json = test_config_doc.toJSON();
			const test_flat_config_obj = config_utils_rw.flattenConfig(config_json);

			expect(config_json).to.eql(expected_config);
			const non_object_flat_test_config_obj = Object.assign({}, test_flat_config_obj);
			for (let key in non_object_flat_test_config_obj) {
				if (
					typeof non_object_flat_test_config_obj[key] === 'object' &&
					non_object_flat_test_config_obj[key] &&
					!Array.isArray(non_object_flat_test_config_obj[key])
				)
					delete non_object_flat_test_config_obj[key];
			}

			expect(non_object_flat_test_config_obj).to.eql(expected_flat_config);
		});
	});

	describe('Test getDefaultConfig function', () => {
		const expected_flat_default_config_obj = {
			analytics_aggregateperiod: 60,
			authentication_cachettl: 30000,
			authentication_enablesessions: true,
			authentication_operationtokentimeout: '1d',
			authentication_refreshtokentimeout: '30d',
			clustering_enabled: false,
			clustering_hubserver_cluster_name: 'harperdb',
			clustering_hubserver_cluster_network_port: 9932,
			clustering_hubserver_cluster_network_routes: null,
			clustering_hubserver_leafnodes_network_port: 9931,
			clustering_hubserver_network_port: 9930,
			clustering_leafserver_network_port: 9940,
			clustering_leafserver_network_routes: null,
			clustering_leafserver_streams_maxage: null,
			clustering_leafserver_streams_maxbytes: null,
			clustering_leafserver_streams_maxmsgs: null,
			clustering_leafserver_streams_path: null,
			clustering_loglevel: 'info',
			clustering_nodename: null,
			clustering_republishmessages: false,
			clustering_databaselevel: false,
			clustering_tls_certificate: null,
			clustering_tls_certificateauthority: null,
			clustering_tls_privatekey: null,
			clustering_tls_insecure: true,
			clustering_tls_verify: true,
			clustering_user: null,
			http_cors: false,
			http_corsaccesslist: [null],
			http_compressionthreshold: 0,
			http_keepalivetimeout: 30000,
			http_port: 9926,
			http_secureport: null,
			http_timeout: 120000,
			http_mtls: false,
			componentsroot: null,
			tls_certificate: null,
			tls_certificateauthority: null,
			tls_privatekey: null,
			threads_count: null,
			threads_debug: false,
			localstudio_enabled: false,
			logging_auditauthevents_logfailed: false,
			logging_auditauthevents_logsuccessful: false,
			logging_auditlog: true,
			logging_auditretention: '3d',
			logging_file: true,
			logging_level: 'warn',
			logging_root: null,
			logging_rotation_enabled: false,
			logging_rotation_interval: null,
			logging_rotation_compress: false,
			logging_rotation_maxsize: null,
			logging_rotation_path: null,
			logging_stdstreams: false,
			mqtt_network_mtls: false,
			mqtt_network_port: 1883,
			mqtt_network_secureport: 8883,
			mqtt_requireauthentication: true,
			mqtt_websocket: true,
			operationsapi_network_cors: true,
			operationsapi_network_corsaccesslist: ['*'],
			operationsapi_network_domainsocket: 'hdb/operations-server',
			operationsapi_network_keepalivetimeout: 30000,
			operationsapi_network_port: 9925,
			operationsapi_network_secureport: null,
			operationsapi_network_timeout: 120000,
			operationsapi_network_mtls: false,
			operationsapi_tls_certificate: null,
			operationsapi_tls_certificateauthority: null,
			operationsapi_tls_privatekey: null,
			operationsapi_network_compressionthreshold: 0,
			rootpath: null,
			storage_writeasync: false,
			storage_caching: true,
			storage_compression: false,
			storage_noreadahead: true,
			storage_prefetchwrites: true,
			storage_path: null,
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
			const non_object_flat_default_config_obj = Object.assign({}, flat_default_config_obj);
			for (let key in non_object_flat_default_config_obj) {
				if (
					typeof non_object_flat_default_config_obj[key] === 'object' &&
					non_object_flat_default_config_obj[key] &&
					!Array.isArray(non_object_flat_default_config_obj[key])
				)
					delete non_object_flat_default_config_obj[key];
			}
			expect(non_object_flat_default_config_obj).to.eql(expected_flat_default_config_obj);
		});

		it('Test that if the in-memory object exists, the correct default value is returned', () => {
			flat_default_config_obj_rw = config_utils_rw.__set__('flat_default_config_obj', expected_flat_default_config_obj);
			const parse_document_spy = sandbox.spy(YAML, 'parseDocument');

			const value = config_utils_rw.getDefaultConfig(hdbTerms.CONFIG_PARAMS.LOGGING_ROTATION_ENABLED);
			const value2 = config_utils_rw.getDefaultConfig(hdbTerms.CONFIG_PARAMS.TLS_CERTIFICATE);
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

			const value = config_utils_rw.getConfigValue(hdbTerms.CONFIG_PARAMS.CLUSTERING_HUBSERVER_CLUSTER_NAME);

			expect(value).to.equal('harperdb');
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

			const value = config_utils_rw.getConfigValue(hdbTerms.CONFIG_PARAMS.CLUSTERING_HUBSERVER_CLUSTER_NAME);

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
					},
					customFunctions: {
						enabled: false,
						root: '/yaml/custom_functions',
					},
					logging: {
						root: '/yaml/log',
						rotation: {
							path: 'path/for/rotated/logs',
						},
					},
					threads: {
						count: 12,
						debug: false,
					},
					http: {
						remoteAddressAffinity: false,
					},
					storage: {
						path: 'path/to/storage',
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
			expect(set_in_stub.firstCall.args[0]).to.eql(['threads', 'count']);
			expect(set_in_stub.firstCall.args[1]).to.equal(12);
			expect(set_in_stub.secondCall.args[0]).to.eql(['componentsRoot']);
			expect(set_in_stub.args[2][0]).to.eql(['logging', 'root']);
			expect(set_in_stub.args[2][1]).to.equal(LOG_ROOT);
			expect(set_in_stub.args[3][1]).to.equal('path/to/storage');
			expect(set_in_stub.args[4][1]).to.equal('path/for/rotated/logs');
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
				clustering_leafserver_network_port: 9940,
				clustering_nodename: null,
				clustering_replyservice_processes: 1,
				clustering_tls_certificate: null,
				clustering_tls_certificateauthority: null,
				clustering_tls_privatekey: null,
				clustering_user: null,
				http_cors: true,
				http_corsaccesslist: [null],
				http_headerstimeout: 60000,
				customfunctions_network_https: false,
				http_keepalivetimeout: 5000,
				http_port: 9926,
				http_timeout: 120000,
				customfunctions_processes: null,
				componentsroot: null,
				tls_certificate: null,
				tls_certificateauthority: null,
				tls_privatekey: null,
				localstudio_enabled: false,
				logging_auditlog: true,
				logging_file: true,
				logging_level: 'warn',
				logging_root: null,
				logging_rotation_enabled: false,
				logging_rotation_frequency: null,
				logging_rotation_size: null,
				logging_rotation_path: null,
				logging_stdstreams: false,
				authentication_operationtokentimeout: '1d',
				authentication_refreshtokentimeout: '30d',
				operationsapi_network_cors: true,
				operationsapi_network_corsaccesslist: [null],
				operationsapi_network_headerstimeout: 60000,
				operationsapi_network_https: false,
				operationsapi_network_keepalivetimeout: 5000,
				operationsapi_network_port: 9925,
				operationsapi_network_timeout: 120000,
				operationsapi_processes: null,
				rootpath: HDB_ROOT,
				storage_writeasync: true,
				storage_overlappingsync: false,
				storage_caching: false,
				storage_compression: false,
				storage_noreadahead: false,
				storage_prefetchwrites: false,
			};
			config_utils_rw.__set__('flat_config_obj', flat_config_obj);

			config_utils_rw.updateConfigValue(
				undefined,
				undefined,
				{
					logging_level: 'warn',
					logging_stdStreams: true,
					logging_rotation_enabled: true,
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
			expect(set_in_stub.thirdCall.args[0][2]).to.equal('enabled');
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
			authentication_operationtokentimeout: '1d',
			authentication_refreshtokentimeout: '30d',
			rootpath: path.join(__dirname, '../../'),
			operationsapi_network_port: 9925,
			tls_certificate: path.join(__dirname, '../../keys/certificate.pem'),
			tls_privatekey: path.join(__dirname, '../../keys/privateKey.pem'),
			operationsapi_network_cors: true,
			logging_level: 'error',
			logging_root: path.join(__dirname, '../../log'),
			clustering_enabled: false,
			threads_count: 12,
			operationsapi_network_timeout: 120000,
			operationsapi_network_keepalivetimeout: 5000,
			operationsapi_network_headerstimeout: 60000,
			logging_auditlog: false,
			http_port: 9926,
			componentsroot: path.join(__dirname, '../../custom_functions'),
			logging_file: true,
			logging_stdstreams: false,
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

	describe('Test setSchemasConfig function', () => {
		const set_in_stub = sandbox.stub().callsFake(() => {});
		const has_in_stub = sandbox.stub().callsFake(() => false);
		const add_in_stub = sandbox.stub().callsFake(() => {});
		const fake_config_doc = {
			value: {},
			setIn: set_in_stub,
			addIn: add_in_stub,
			hasIn: has_in_stub,
		};
		const schema_conf = [
			{
				dev_schema: {
					tables: {
						furry_friend: {
							path: 'path/to/the/fur',
						},
					},
				},
			},
			{
				second_test_schema: {
					path: 'im/number/two',
				},
			},
			{
				audit_test_schema: {
					auditPath: 'audit/path',
				},
			},
		];

		it('Test all schemas config is added to config doc', () => {
			const setSchemasConfig = config_utils_rw.__get__('setSchemasConfig');
			setSchemasConfig(fake_config_doc, schema_conf);
			expect(add_in_stub.getCall(0).firstArg).to.eql(['databases', 'dev_schema', 'tables', 'furry_friend', 'path']);
			expect(add_in_stub.getCall(0).lastArg).to.eql('path/to/the/fur');
			expect(add_in_stub.getCall(1).firstArg).to.eql(['databases', 'second_test_schema', 'path']);
			expect(add_in_stub.getCall(1).lastArg).to.eql('im/number/two');
			expect(add_in_stub.getCall(2).firstArg).to.eql(['databases', 'audit_test_schema', 'auditPath']);
			expect(add_in_stub.getCall(2).lastArg).to.eql('audit/path');
		});
	});
});
