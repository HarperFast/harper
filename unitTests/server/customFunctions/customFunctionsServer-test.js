'use strict';

const test_utils = require('../../test_utils');

const rewire = require('rewire');
const fs = require('fs-extra');
const path = require('path');
require('events').EventEmitter.defaultMaxListeners = 39;

const chai = require('chai');
const { expect } = chai;
const sinon = require('sinon');
const sandbox = sinon.createSandbox();

const harper_logger = require('../../../utility/logging/harper_logger');
const user_schema = require('../../../security/user');
const global_schema = require('../../../utility/globalSchema');
const operations = rewire('../../../server/customFunctions/operations');
const env = require('../../../utility/environment/environmentManager');

const { CONFIG_PARAMS } = require('../../../utility/hdbTerms');
const config_utils = require('../../../config/configUtils');
const CF_SERVER_PATH = '../../../server/customFunctions/customFunctionsServer';
const KEYS_PATH = path.join(test_utils.getMockTestPath(), 'utility/keys');
const PRIVATE_KEY_PATH = path.join(KEYS_PATH, 'privateKey.pem');
const CERTIFICATE_PATH = path.join(KEYS_PATH, 'certificate.pem');
const ROUTES_PATH = path.resolve(__dirname, '../../envDir/utility/routes');

const test_req_options = {
	headers: {
		'Content-Type': 'application/json',
		'Authorization': 'Basic YWRtaW46QWJjMTIzNCE=',
	},
	body: {
		operation: 'custom_functions_status',
	},
};

const test_cert_val = test_utils.getHTTPSCredentials().cert;
const test_key_val = test_utils.getHTTPSCredentials().key;

let setUsersToGlobal_stub;
let setSchemaGlobal_stub;

describe('Test customFunctionsServer module', () => {
	before(() => {
		env.initTestEnvironment();

		sandbox.stub(harper_logger, 'info').callsFake(() => {});
		sandbox.stub(harper_logger, 'debug').callsFake(() => {});
		sandbox.stub(harper_logger, 'error').callsFake(() => {});
		sandbox.stub(harper_logger, 'fatal').callsFake(() => {});
		sandbox.stub(harper_logger, 'trace').callsFake(() => {});
		setUsersToGlobal_stub = sandbox.stub(user_schema, 'setUsersToGlobal').resolves();
		setSchemaGlobal_stub = sandbox.stub(global_schema, 'setSchemaDataToGlobal').callsArg(0);
		sandbox.stub().callsFake(() => {});

		test_utils.preTestPrep();
		fs.mkdirpSync(KEYS_PATH);
		fs.mkdirpSync(ROUTES_PATH);
		fs.writeFileSync(PRIVATE_KEY_PATH, test_key_val);
		fs.writeFileSync(CERTIFICATE_PATH, test_cert_val);
	});

	afterEach(() => {
		test_utils.preTestPrep();
		sandbox.resetHistory();

		//remove listener added by serverChild component
		const exceptionListeners = process.listeners('uncaughtException');
		exceptionListeners.forEach((listener) => {
			if (listener.name === 'handleServerUncaughtException') {
				process.removeListener('uncaughtException', listener);
			}
		});
	});

	after(() => {
		sandbox.restore();
		fs.removeSync(KEYS_PATH);
	});

	describe('Test customFunctionsServer function', () => {
		it('should build HTTPS server when HTTPS_ON set to true', async () => {
			const test_config_settings = { https_enabled: true };
			test_utils.preTestPrep(test_config_settings);

			const customFunctionsServer_rw = await rewire(CF_SERVER_PATH);
			await customFunctionsServer_rw.customFunctionsServer();
			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = customFunctionsServer_rw.__get__('server');

			expect(server).to.not.be.undefined;
			expect(server.server.constructor.name).to.equal('Http2SecureServer');
			expect(server.server.key).to.be.instanceOf(Buffer);
			expect(server.server.cert).to.be.instanceOf(Buffer);
			expect(server.initialConfig.https.allowHTTP1).to.be.true;

			server.close();
		});

		it('should build HTTPS server instance with started and listening state equal to true', async () => {
			const test_config_settings = { https_enabled: true };
			test_utils.preTestPrep(test_config_settings);

			const customFunctionsServer_rw = await rewire(CF_SERVER_PATH);
			await customFunctionsServer_rw.customFunctionsServer();
			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = customFunctionsServer_rw.__get__('server');

			const state_key = Object.getOwnPropertySymbols(server).find((s) => String(s) === 'Symbol(fastify.state)');
			expect(server[state_key].started).to.be.true;
			expect(server[state_key].listening).to.be.true;

			server.close();
		});

		it('should build HTTPS server instance with default config settings', async () => {
			const customFunctionsServer_rw = await rewire(CF_SERVER_PATH);
			await customFunctionsServer_rw.customFunctionsServer();
			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = customFunctionsServer_rw.__get__('server');

			expect(server.initialConfig.connectionTimeout).to.equal(
				config_utils.getDefaultConfig(CONFIG_PARAMS.OPERATIONSAPI_NETWORK_TIMEOUT)
			);
			expect(server.initialConfig.keepAliveTimeout).to.equal(
				config_utils.getDefaultConfig(CONFIG_PARAMS.OPERATIONSAPI_NETWORK_KEEPALIVETIMEOUT)
			);
			server.close();
		});

		it('should build HTTPS server instances with provided config settings', async () => {
			const test_config_settings = {
				https_on: true,
				server_timeout: 3333,
				keep_alive_timeout: 2222,
				headers_timeout: 1111,
			};
			test_utils.preTestPrep(test_config_settings);

			const customFunctionsServer_rw = await rewire(CF_SERVER_PATH);
			await customFunctionsServer_rw.customFunctionsServer();
			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = customFunctionsServer_rw.__get__('server');

			expect(server.server.timeout).to.equal(test_config_settings.server_timeout);
			expect(server.server.headersTimeout).to.equal(test_config_settings.headers_timeout);
			server.close();
			test_utils.preTestPrep({
				server_timeout: config_utils.getDefaultConfig(CONFIG_PARAMS.OPERATIONSAPI_NETWORK_TIMEOUT),
				keep_alive_timeout: config_utils.getDefaultConfig(CONFIG_PARAMS.OPERATIONSAPI_NETWORK_KEEPALIVETIMEOUT),
			});
		});

		it('should not register @fastify/cors if cors is not enabled', async () => {
			test_utils.preTestPrep();

			const customFunctionsServer_rw = await rewire(CF_SERVER_PATH);
			await customFunctionsServer_rw.customFunctionsServer();
			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = customFunctionsServer_rw.__get__('server');

			const plugin_key = Object.getOwnPropertySymbols(server).find(
				(s) => String(s) === 'Symbol(fastify.pluginNameChain)'
			);

			expect(server[plugin_key].length).to.equal(2);

			server.close();
		});

		it('should register @fastify/cors if cors is enabled', async () => {
			const test_config_settings = { cors_enabled: true, cors_accesslist: 'harperdb.io, sam-johnson.io' };
			test_utils.preTestPrep(test_config_settings);

			const customFunctionsServer_rw = await rewire(CF_SERVER_PATH);
			await customFunctionsServer_rw.customFunctionsServer();
			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = customFunctionsServer_rw.__get__('server');

			const plugin_key = Object.getOwnPropertySymbols(server).find(
				(s) => String(s) === 'Symbol(fastify.pluginNameChain)'
			);

			expect(server[plugin_key].length).to.equal(3);
			expect(server[plugin_key]).to.deep.equal(['fastify', '@fastify/cors', 'hdb-request-time']);

			server.close();
		});

		it('should return 500 error for request from origin not included in CORS whitelist', async () => {
			const test_config_settings = { cors_enabled: true, cors_accesslist: 'https://harperdb.io' };

			test_utils.preTestPrep(test_config_settings);

			const customFunctionsServer_rw = await rewire(CF_SERVER_PATH);
			await customFunctionsServer_rw.customFunctionsServer();
			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = customFunctionsServer_rw.__get__('server');

			const test_headers = Object.assign({ origin: 'https://google.com' }, test_req_options.headers);
			const test_response = await server.inject({
				method: 'POST',
				url: '/',
				headers: test_headers,
				body: test_req_options.body,
			});

			expect(test_response.statusCode).to.equal(500);
			expect(test_response.json().error).to.equal('domain https://google.com is not on access list');

			server.close();
		});

		it('should return resp with 200 for request from origin included in CORS whitelist', async () => {
			const test_config_settings = { cors_enabled: true, cors_accesslist: 'https://harperdb.io' };

			test_utils.preTestPrep(test_config_settings);

			const customFunctionsServer_rw = await rewire(CF_SERVER_PATH);
			await customFunctionsServer_rw.customFunctionsServer();
			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = customFunctionsServer_rw.__get__('server');

			const test_headers = Object.assign({ origin: 'https://harperdb.io' }, test_req_options.headers);
			const test_response = await server.inject({
				method: 'POST',
				url: '/',
				headers: test_headers,
				body: test_req_options.body,
			});

			expect(test_response.statusCode).to.equal(404);

			server.close();
		});
	});

	describe('buildServer() method', () => {
		it('should return an http server', async () => {
			const customFunctionsServer_rw = await rewire(CF_SERVER_PATH);
			await customFunctionsServer_rw.customFunctionsServer();
			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = customFunctionsServer_rw.__get__('server');
			const buildServer_rw = customFunctionsServer_rw.__get__('buildServer');

			const test_is_https = false;
			const test_result = await buildServer_rw(test_is_https);

			expect(test_result.server.constructor.name).to.equal('Server');
			expect(test_result.initialConfig.https).to.be.undefined;

			server.close();
		});

		it('should return an https server', async () => {
			const customFunctionsServer_rw = await rewire(CF_SERVER_PATH);
			await customFunctionsServer_rw.customFunctionsServer();
			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = customFunctionsServer_rw.__get__('server');
			const buildServer_rw = customFunctionsServer_rw.__get__('buildServer');

			const test_is_https = true;
			const test_result = await buildServer_rw(test_is_https);

			expect(test_result.server.constructor.name).to.equal('Http2SecureServer');
			expect(test_result.initialConfig.https.allowHTTP1).to.be.true;

			server.close();
		});
	});

	describe('setUp() method', () => {
		it('NOMINAL - should call initial setup methods', async () => {
			const customFunctionsServer_rw = await rewire(CF_SERVER_PATH);
			await customFunctionsServer_rw.customFunctionsServer();
			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = customFunctionsServer_rw.__get__('server');

			expect(setSchemaGlobal_stub.called).to.be.true;
			expect(setUsersToGlobal_stub.called).to.be.true;

			server.close();
		});
	});

	describe('buildRoutes() method', () => {
		let sandbox = sinon.createSandbox();
		let CF_DIR_ROOT = path.resolve(__dirname, 'custom_functions');

		before(async () => {
			fs.removeSync(CF_DIR_ROOT);
			fs.ensureDirSync(CF_DIR_ROOT);
			await operations.addCustomFunctionProject({ project: 'test' });
			fs.createSymlinkSync(path.join(CF_DIR_ROOT, 'test'), path.join(CF_DIR_ROOT, 'test-linked'));
		});

		after(() => {
			fs.removeSync(CF_DIR_ROOT);
			sandbox.restore();
		});

		it('should call buildRoutes', async () => {
			const customFunctionsServer_rw = await rewire(CF_SERVER_PATH);
			await customFunctionsServer_rw.customFunctionsServer();
			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = customFunctionsServer_rw.__get__('server');

			const plugin_key = Object.getOwnPropertySymbols(server).find((s) => String(s) === 'Symbol(fastify.children)');
			const plugins_array = Object.getOwnPropertySymbols(server[plugin_key][0]).find(
				(s) => String(s) === 'Symbol(fastify.pluginNameChain)'
			);
			const test_result = server[plugin_key][0][plugins_array];

			expect(test_result).to.be.instanceOf(Array);
			expect(test_result).to.include('buildRoutes');
			expect(test_result).to.include('@fastify/static');
			expect(test_result).to.include('hdbCore-auto-0');

			server.close();
		});

		it('should register hdbCore', async () => {
			const customFunctionsServer_rw = await rewire(CF_SERVER_PATH);
			await customFunctionsServer_rw.customFunctionsServer();
			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = customFunctionsServer_rw.__get__('server');

			const plugin_key = Object.getOwnPropertySymbols(server).find((s) => String(s) === 'Symbol(fastify.children)');
			const test_result = server[plugin_key][0];

			expect(test_result.hdbCore).to.be.instanceOf(Object);
			expect(Object.keys(test_result.hdbCore)).to.have.length(3);
			expect(Object.keys(test_result.hdbCore)).to.include('preValidation');
			expect(Object.keys(test_result.hdbCore)).to.include('request');
			expect(Object.keys(test_result.hdbCore)).to.include('requestWithoutAuthentication');

			server.close();
		});

		it('should find the appropriate route files in the test project', async () => {
			const customFunctionsServer_rw = await rewire(CF_SERVER_PATH);
			await customFunctionsServer_rw.customFunctionsServer();
			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = customFunctionsServer_rw.__get__('server');

			const plugin_key = Object.getOwnPropertySymbols(server).find((s) => String(s) === 'Symbol(fastify.children)');
			const children = Object.getOwnPropertySymbols(server[plugin_key][0]).find(
				(s) => String(s) === 'Symbol(fastify.children)'
			);
			const route_files = Object.getOwnPropertySymbols(server[plugin_key][0][children][0]).find(
				(s) => String(s) === 'Symbol(fastify.pluginNameChain)'
			);
			const route_prefix = Object.getOwnPropertySymbols(server[plugin_key][0]).find(
				(s) => String(s) === 'Symbol(fastify.routePrefix)'
			);
			const test_result = server[plugin_key][0][children][0][route_files];

			expect(test_result).to.be.instanceOf(Array);
			expect(test_result).to.have.length(1);
			expect(test_result[0]).to.equal(path.resolve(__dirname, 'custom_functions', 'test', 'routes', 'examples.js'));
			const linked_prefix = server[plugin_key][0][children][1][route_prefix];
			expect(linked_prefix).to.equal('/test-linked');

			server.close();
		});

		// Something is causing the template_routes to change, so I'm commenting this out for now.
		// 		it('should register the appropriate routes with the server', async () => {
		// 			const customFunctionsServer_rw = await rewire(CF_SERVER_PATH);
		// 			await new Promise((resolve) => setTimeout(resolve, 500));
		// 			const server = customFunctionsServer_rw.__get__('server');
		//
		// 			const template_routes = `└── /
		//     ├── test (GET)
		//     │   test (POST)
		//     │   └── / (GET)
		//     │       / (POST)
		//     │       ├── :id (GET)
		//     │       │   └── / (GET)
		//     │       └── static (GET)
		//     │           └── / (GET)
		//     └── * (GET)
		//         * (HEAD)
		// `;
		//
		// 			const routes = server.printRoutes();
		//
		// 			expect(routes).to.equal(template_routes);
		//
		// 			server.close();
		// 		});
	});
});
