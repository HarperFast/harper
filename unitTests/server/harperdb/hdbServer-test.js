'use strict';

const test_utils = require('../../test_utils');

const rewire = require('rewire');
const fs = require('fs-extra');
const path = require('path');
const { pack, unpack } = require('msgpackr');
require('events').EventEmitter.defaultMaxListeners = 60;

const chai = require('chai');
const { expect } = chai;
const sinon = require('sinon');
const sandbox = sinon.createSandbox();

const serverHandlers = require('../../../server/serverHelpers/serverHandlers');
const server_utilities = require('../../../server/serverHelpers/serverUtilities');
const OperationFunctionCaller = require('../../../utility/OperationFunctionCaller');
const harper_logger = require('../../../utility/logging/harper_logger');
const user_schema = require('../../../security/user');
const global_schema = require('../../../utility/globalSchema');
const hdb_license = require('../../../utility/registration/hdb_license');
const env = require('../../../utility/environment/environmentManager');
const config_utils = require('../../../config/configUtils');

const { CONFIG_PARAMS } = require('../../../utility/hdbTerms');
const HDB_SERVER_PATH = '../../../server/harperdb/hdbServer';
const KEYS_PATH = path.join(test_utils.getMockTestPath(), 'utility/keys');
const PRIVATE_KEY_PATH = path.join(KEYS_PATH, 'privateKey.pem');
const CERTIFICATE_PATH = path.join(KEYS_PATH, 'certificate.pem');

const test_req_options = {
	headers: {
		'Content-Type': 'application/json',
		'Authorization': 'Basic YWRtaW46QWJjMTIzNCE=',
	},
	body: {
		operation: 'describe_all',
	},
};

// eslint-disable-next-line no-magic-numbers
const REQ_MAX_BODY_SIZE = 1024 * 1024 * 1024; //this is 1GB in bytes
const DEFAULT_FASTIFY_PLUGIN_ARR = [
	'fastify',
	'hdb-request-time',
	'@fastify/compress',
	'@fastify/static',
	'@fastify/accepts-serializer',
	'@fastify/accepts',
];

let setUsersToGlobal_stub;
let setSchemaGlobal_stub;
let handlePostRequest_spy;
let getLicense_stub;
let logger_error_spy;

const test_op_resp = "table 'dev.dogz' successfully created.";
const test_cert_val = test_utils.getHTTPSCredentials().cert;
const test_key_val = test_utils.getHTTPSCredentials().key;

describe('Test hdbServer module', () => {
	before(() => {
		env.initTestEnvironment();

		sandbox.stub(harper_logger, 'info').callsFake(() => {});
		sandbox.stub(harper_logger, 'debug').callsFake(() => {});
		sandbox.stub(harper_logger, 'fatal').callsFake(() => {});
		sandbox.stub(harper_logger, 'trace').callsFake(() => {});
		sandbox.stub(OperationFunctionCaller, 'callOperationFunctionAsAwait').resolves(test_op_resp);
		sandbox.stub(serverHandlers, 'authHandler').callsFake((req, resp, done) => done());
		sandbox.stub(server_utilities, 'chooseOperation').callsFake(() => {});
		setUsersToGlobal_stub = sandbox.stub(user_schema, 'setUsersToGlobal').resolves();
		setSchemaGlobal_stub = sandbox.stub(global_schema, 'setSchemaDataToGlobal').callsArg(0);
		handlePostRequest_spy = sandbox.spy(serverHandlers, 'handlePostRequest');
		getLicense_stub = sandbox.stub(hdb_license, 'getLicense').resolves();
		logger_error_spy = sandbox.stub(harper_logger, 'error').callsFake(() => {});
		sandbox.stub().callsFake(() => {});

		test_utils.preTestPrep();
		fs.mkdirpSync(KEYS_PATH);
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

	describe('Test hdbServer function', () => {
		it('should build HTTPS server when https_enabled set to true', async () => {
			const test_config_settings = { https_enabled: true };
			test_utils.preTestPrep(test_config_settings);

			const hdbServer_rw = await rewire(HDB_SERVER_PATH);
			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = hdbServer_rw.__get__('server');

			expect(server).to.not.be.undefined;
			expect(server.server.constructor.name).to.contains('Server');
			expect(server.server.key).to.be.instanceOf(Buffer);
			expect(server.server.cert).to.be.instanceOf(Buffer);
			expect(!!server.initialConfig.https).to.be.true;

			// Check to see that server handler event listeners are added to process
			const before_exit_listeners = process.listeners('beforeExit').map((func) => func.name);
			expect(before_exit_listeners).to.include('handleBeforeExit');
			const exit_listeners = process.listeners('exit').map((func) => func.name);
			expect(exit_listeners).to.include('handleExit');
			const signit_listeners = process.listeners('SIGINT').map((func) => func.name);
			expect(signit_listeners).to.include('handleSigint');
			const sigquit_listeners = process.listeners('SIGQUIT').map((func) => func.name);
			expect(sigquit_listeners).to.include('handleSigquit');
			const sigterm_listeners = process.listeners('SIGTERM').map((func) => func.name);
			expect(sigterm_listeners).to.include('handleSigterm');

			server.close();
		});

		it('should build HTTP server when https_enabled set to false', async () => {
			const test_config_settings = { https_enabled: false };
			test_utils.preTestPrep(test_config_settings);

			const hdbServer_rw = await rewire(HDB_SERVER_PATH);
			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = hdbServer_rw.__get__('server');

			expect(server).to.not.be.undefined;
			expect(server.server.constructor.name).to.equal('Server');
			expect(server.initialConfig.https).to.be.undefined;

			server.close();
		});

		it('should build HTTPS server instance with started and listening state equal to true', async () => {
			const test_config_settings = { https_enabled: true };
			test_utils.preTestPrep(test_config_settings);

			const hdbServer_rw = await rewire(HDB_SERVER_PATH);
			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = hdbServer_rw.__get__('server');

			const state_key = Object.getOwnPropertySymbols(server).find((s) => String(s) === 'Symbol(fastify.state)');
			expect(server[state_key].started).to.be.true;
			expect(server[state_key].listening).to.be.true;

			server.close();
		});

		it('should build HTTP server instance with started and listening state equal to true', async () => {
			const test_config_settings = { https_enabled: false };
			test_utils.preTestPrep(test_config_settings);

			const hdbServer_rw = await rewire(HDB_SERVER_PATH);
			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = hdbServer_rw.__get__('server');

			const state_key = Object.getOwnPropertySymbols(server).find((s) => String(s) === 'Symbol(fastify.state)');
			expect(server[state_key].started).to.be.true;
			expect(server[state_key].listening).to.be.true;

			server.close();
		});

		it('should build HTTPS server instances with mixed cap boolean spelling', async () => {
			const test_config_settings = { https_enabled: 'TRUe' };
			test_utils.preTestPrep(test_config_settings);

			const hdbServer_rw = await rewire(HDB_SERVER_PATH);
			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = hdbServer_rw.__get__('server');

			expect(server).to.not.be.undefined;
			expect(server.server.constructor.name).to.contain('Server');
			expect(server.server.key).to.be.instanceOf(Buffer);
			expect(server.server.cert).to.be.instanceOf(Buffer);
			expect(!!server.initialConfig.https).to.be.true;

			server.close();
		});

		it('should build HTTP server instances with mixed cap boolean spelling', async () => {
			const test_config_settings = { https_enabled: 'FalsE' };
			test_utils.preTestPrep(test_config_settings);

			const hdbServer_rw = await rewire(HDB_SERVER_PATH);
			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = hdbServer_rw.__get__('server');

			expect(server).to.not.be.undefined;
			expect(server.server.constructor.name).to.equal('Server');
			expect(server.initialConfig.https).to.be.undefined;

			server.close();
		});

		it('should register 4 fastify plugins by default - @fastify/compress, @fastify/static, @fastify/accepts-serializer', async () => {
			const hdbServer_rw = await rewire(HDB_SERVER_PATH);
			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = hdbServer_rw.__get__('server');

			const plugin_key = Object.getOwnPropertySymbols(server).find(
				(s) => String(s) === 'Symbol(fastify.pluginNameChain)'
			);

			expect(server[plugin_key]).to.deep.equal(DEFAULT_FASTIFY_PLUGIN_ARR);

			server.close();
		});

		it('should build HTTPS server instance with default config settings', async () => {
			const hdbServer_rw = await rewire(HDB_SERVER_PATH);
			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = hdbServer_rw.__get__('server');
			const test_max_body_size = hdbServer_rw.__get__('REQ_MAX_BODY_SIZE');

			expect(server.initialConfig.bodyLimit).to.equal(test_max_body_size);
			expect(server.initialConfig.connectionTimeout).to.equal(
				config_utils.getDefaultConfig(CONFIG_PARAMS.OPERATIONSAPI_NETWORK_TIMEOUT)
			);
			expect(server.initialConfig.keepAliveTimeout).to.equal(
				config_utils.getDefaultConfig(CONFIG_PARAMS.OPERATIONSAPI_NETWORK_KEEPALIVETIMEOUT)
			);

			server.close();
		});

		it('should build HTTP server instances with default config settings', async () => {
			const test_config_settings = { https_enabled: false };
			test_utils.preTestPrep(test_config_settings);

			const hdbServer_rw = await rewire(HDB_SERVER_PATH);
			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = hdbServer_rw.__get__('server');

			const test_max_body_size = hdbServer_rw.__get__('REQ_MAX_BODY_SIZE');

			expect(server.initialConfig.bodyLimit).to.equal(test_max_body_size);
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
				https_enabled: true,
				server_timeout: 3333,
				headers_timeout: 1111,
			};
			test_utils.preTestPrep(test_config_settings);

			const hdbServer_rw = await rewire(HDB_SERVER_PATH);
			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = hdbServer_rw.__get__('server');

			expect(server.server.timeout).to.equal(test_config_settings.server_timeout);
			expect(server.server.headersTimeout).to.equal(test_config_settings.headers_timeout);

			server.close();
		});

		it('should build HTTP server instances with provided config settings', async () => {
			const test_config_settings = {
				https_enabled: false,
				server_timeout: 3333,
				keep_alive_timeout: 2222,
				headers_timeout: 1111,
			};
			test_utils.preTestPrep(test_config_settings);

			const hdbServer_rw = await rewire(HDB_SERVER_PATH);
			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = hdbServer_rw.__get__('server');

			expect(server.server.timeout).to.equal(test_config_settings.server_timeout);
			expect(server.server.keepAliveTimeout).to.equal(test_config_settings.keep_alive_timeout);
			expect(server.server.headersTimeout).to.equal(test_config_settings.headers_timeout);

			server.close();
		});

		it('should not register @fastify/cors if cors is not enabled', async () => {
			test_utils.preTestPrep();

			const hdbServer_rw = await rewire(HDB_SERVER_PATH);
			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = hdbServer_rw.__get__('server');

			const plugin_key = Object.getOwnPropertySymbols(server).find(
				(s) => String(s) === 'Symbol(fastify.pluginNameChain)'
			);

			expect(server[plugin_key].length).to.equal(6);
			expect(server[plugin_key]).to.deep.equal(DEFAULT_FASTIFY_PLUGIN_ARR);

			server.close();
		});

		it('should register @fastify/cors if cors is enabled', async () => {
			const test_config_settings = { cors_enabled: true, cors_accesslist: 'harperdb.io, sam-johnson.io' };
			test_utils.preTestPrep(test_config_settings);

			const hdbServer_rw = await rewire(HDB_SERVER_PATH);
			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = hdbServer_rw.__get__('server');

			const plugin_key = Object.getOwnPropertySymbols(server).find(
				(s) => String(s) === 'Symbol(fastify.pluginNameChain)'
			);

			expect(server[plugin_key].length).to.equal(7);
			expect(server[plugin_key].sort()).to.deep.equal(['@fastify/cors', ...DEFAULT_FASTIFY_PLUGIN_ARR].sort());

			server.close();
		});

		it('should register @fastify/cors if cors is enabled boolean has mixed cap spelling', async () => {
			const test_config_settings = { cors_enabled: 'TRue', cors_accesslist: 'harperdb.io, sam-johnson.io' };
			test_utils.preTestPrep(test_config_settings);

			const hdbServer_rw = await rewire(HDB_SERVER_PATH);
			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = hdbServer_rw.__get__('server');

			const plugin_key = Object.getOwnPropertySymbols(server).find(
				(s) => String(s) === 'Symbol(fastify.pluginNameChain)'
			);

			expect(server[plugin_key].length).to.equal(7);
			expect(server[plugin_key].sort()).to.deep.equal(['@fastify/cors', ...DEFAULT_FASTIFY_PLUGIN_ARR].sort());

			server.close();
		});

		it('should call handlePostRequest on HTTP post request', async () => {
			const test_config_settings = { https_enabled: false };
			test_utils.preTestPrep(test_config_settings);

			const hdbServer_rw = await rewire(HDB_SERVER_PATH);
			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = hdbServer_rw.__get__('server');

			await server.inject({ method: 'POST', url: '/', headers: test_req_options.headers, body: test_req_options.body });

			expect(handlePostRequest_spy.calledOnce).to.be.true;

			server.close();
		});

		it('should return MessagePack when HTTP request include Accept: application/x-msgpack', async () => {
			const test_config_settings = { https_enabled: false };
			test_utils.preTestPrep(test_config_settings);

			const hdbServer_rw = await rewire(HDB_SERVER_PATH);
			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = hdbServer_rw.__get__('server');

			const test_response = await server.inject({
				method: 'POST',
				url: '/',
				headers: Object.assign(
					{
						Accept: 'application/x-msgpack',
					},
					test_req_options.headers
				),
				body: test_req_options.body,
			});

			expect(test_response.statusCode).to.equal(200);
			const expectedResponse = pack({ message: test_op_resp });
			expect(test_response.body).to.equal(expectedResponse.toString());

			server.close();
		});

		it('should parse MessagePack when HTTP request include Content-Type: application/x-msgpack', async () => {
			const test_config_settings = { https_enabled: false };
			test_utils.preTestPrep(test_config_settings);

			const hdbServer_rw = await rewire(HDB_SERVER_PATH);
			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = hdbServer_rw.__get__('server');

			const body = pack(test_req_options.body);
			const test_response = await server.inject({
				method: 'POST',
				url: '/',
				headers: Object.assign({}, test_req_options.headers, {
					'Content-Type': 'application/x-msgpack',
					'Content-Length': body.length,
				}),
				body,
			});

			expect(test_response.statusCode).to.equal(200);
			expect(test_response.body).to.equal(JSON.stringify({ message: test_op_resp }));

			server.close();
		});

		it('should 400 with invalid MessagePack', async () => {
			const test_config_settings = { https_enabled: false };
			test_utils.preTestPrep(test_config_settings);

			const hdbServer_rw = await rewire(HDB_SERVER_PATH);
			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = hdbServer_rw.__get__('server');

			const body = Buffer.from('this is not valid MessagePack');
			const test_response = await server.inject({
				method: 'POST',
				url: '/',
				headers: Object.assign({}, test_req_options.headers, {
					'Content-Type': 'application/x-msgpack',
					'Content-Length': body.length,
				}),
				body,
			});

			expect(test_response.statusCode).to.equal(400);

			server.close();
		});
		it('should return CSV when HTTP request include Accept: text/csv', async () => {
			const test_config_settings = { https_on: false };
			test_utils.preTestPrep(test_config_settings);

			const hdbServer_rw = await rewire(HDB_SERVER_PATH);
			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = hdbServer_rw.__get__('server');

			const test_response = await server.inject({
				method: 'POST',
				url: '/',
				headers: Object.assign(
					{
						Accept: 'text/csv',
					},
					test_req_options.headers
				),
				body: test_req_options.body,
			});

			expect(test_response.statusCode).to.equal(200);
			const expectedResponse = '"message"\n"table \'dev.dogz\' successfully created."';
			expect(test_response.body).to.equal(expectedResponse);

			server.close();
		});


		it('should return docs html static file result w/ status 200 for valid HTTP get request', async () => {
			const test_config_settings = { https_enabled: false, local_studio_on: true };
			test_utils.preTestPrep(test_config_settings);

			const hdbServer_rw = await rewire(HDB_SERVER_PATH);
			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = hdbServer_rw.__get__('server');

			const test_response = await server.inject({ method: 'get', url: '/' });

			expect(test_response.statusCode).to.equal(200);
			expect(test_response.body).to.equal(fs.readFileSync(path.join(__dirname, '../../../docs/index.html'), 'utf8'));

			server.close();
		});

		it('should return docs html static file result w/ status 200 for valid HTTPS get request', async () => {
			const test_config_settings = { https_enabled: true, local_studio_on: true };
			test_utils.preTestPrep(test_config_settings);

			const hdbServer_rw = await rewire(HDB_SERVER_PATH);
			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = hdbServer_rw.__get__('server');

			const test_response = await server.inject({ method: 'get', url: '/' });

			expect(test_response.statusCode).to.equal(200);
			expect(test_response.body).to.equal(fs.readFileSync(path.join(__dirname, '../../../docs/index.html'), 'utf8'));

			server.close();
		});

		it('should not return docs html static file result w/ status 404 for valid HTTP get request when local studio is turned off', async () => {
			const test_config_settings = { https_enabled: false, local_studio_on: false };
			test_utils.preTestPrep(test_config_settings);

			const hdbServer_rw = await rewire(HDB_SERVER_PATH);
			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = hdbServer_rw.__get__('server');

			const test_response = await server.inject({ method: 'get', url: '/' });

			expect(test_response.statusCode).to.equal(404);
			expect(JSON.parse(test_response.body)).to.deep.equal({ error: 'Not Found', statusCode: 404 });

			server.close();
		});

		it('should not return docs html static file result w/ status 404 for valid HTTPS get request when local studio is turned off', async () => {
			const test_config_settings = { https_enabled: true, local_studio_on: false };
			test_utils.preTestPrep(test_config_settings);

			const hdbServer_rw = await rewire(HDB_SERVER_PATH);
			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = hdbServer_rw.__get__('server');

			const test_response = await server.inject({ method: 'get', url: '/' });

			expect(test_response.statusCode).to.equal(404);
			expect(JSON.parse(test_response.body)).to.deep.equal({ error: 'Not Found', statusCode: 404 });

			server.close();
		});

		it('should return op result w/ status 200 for valid HTTP post request', async () => {
			const test_config_settings = { https_enabled: false };
			test_utils.preTestPrep(test_config_settings);

			const hdbServer_rw = await rewire(HDB_SERVER_PATH);
			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = hdbServer_rw.__get__('server');

			const test_response = await server.inject({
				method: 'POST',
				url: '/',
				headers: test_req_options.headers,
				body: test_req_options.body,
			});

			expect(test_response.statusCode).to.equal(200);
			expect(test_response.body).to.equal(JSON.stringify({ message: test_op_resp }));

			server.close();
		});

		it('should call handlePostRequest on HTTPS post request', async () => {
			const hdbServer_rw = await rewire(HDB_SERVER_PATH);
			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = hdbServer_rw.__get__('server');

			await server.inject({ method: 'POST', url: '/', headers: test_req_options.headers, body: test_req_options.body });

			expect(handlePostRequest_spy.calledOnce).to.be.true;

			server.close();
		});

		it('should return op result w/ status 200 for valid HTTPS post request', async () => {
			const hdbServer_rw = await rewire(HDB_SERVER_PATH);
			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = hdbServer_rw.__get__('server');

			const test_response = await server.inject({
				method: 'POST',
				url: '/',
				headers: test_req_options.headers,
				body: test_req_options.body,
			});

			expect(test_response.statusCode).to.equal(200);

			server.close();
		});

		it('should return 400 error for post request w/o body', async () => {
			const hdbServer_rw = await rewire(HDB_SERVER_PATH);
			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = hdbServer_rw.__get__('server');

			const test_response = await server.inject({ method: 'POST', url: '/', headers: test_req_options.headers });

			expect(test_response.statusCode).to.equal(400);
			expect(test_response.json().error).to.equal(
				"Body cannot be empty when content-type is set to 'application/json'"
			);

			server.close();
		});

		it('should return 500 error for request from origin not included in CORS whitelist', async () => {
			const test_config_settings = { cors_enabled: true, cors_accesslist: 'https://harperdb.io' };
			test_utils.preTestPrep(test_config_settings);

			const hdbServer_rw = await rewire(HDB_SERVER_PATH);
			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = hdbServer_rw.__get__('server');

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

			const hdbServer_rw = await rewire(HDB_SERVER_PATH);
			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = hdbServer_rw.__get__('server');

			const test_headers = Object.assign({ origin: 'https://harperdb.io' }, test_req_options.headers);
			const test_response = await server.inject({
				method: 'POST',
				url: '/',
				headers: test_headers,
				body: test_req_options.body,
			});

			expect(test_response.statusCode).to.equal(200);

			server.close();
		});
	});

	describe('buildServer() method', () => {
		it('should return an http server', async () => {
			const hdbServer_rw = await rewire(HDB_SERVER_PATH);
			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = hdbServer_rw.__get__('server');
			const buildServer_rw = hdbServer_rw.__get__('buildServer');

			const test_is_https = false;
			const test_result = await buildServer_rw(test_is_https);

			expect(test_result.server.constructor.name).to.equal('Server');
			expect(test_result.initialConfig.https).to.be.undefined;

			server.close();
		});

		it('should return an https server', async () => {
			const hdbServer_rw = await rewire(HDB_SERVER_PATH);
			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = hdbServer_rw.__get__('server');
			const buildServer_rw = hdbServer_rw.__get__('buildServer');

			const test_is_https = true;
			const test_result = await buildServer_rw(test_is_https);

			expect(test_result.server.constructor.name).to.contains('Server');
			expect(!!test_result.initialConfig.https).to.be.true;

			server.close();
		});
	});

	describe('getServerOptions() method', () => {
		it('should return http server options based based on settings values', async () => {
			const test_config_settings = { server_timeout: 3333, keep_alive_timeout: 2222, headers_timeout: 1111 };
			test_utils.preTestPrep(test_config_settings);

			const hdbServer_rw = await rewire(HDB_SERVER_PATH);
			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = hdbServer_rw.__get__('server');
			const getServerOptions_rw = hdbServer_rw.__get__('getServerOptions');

			const test_is_https = false;
			const test_results = getServerOptions_rw(test_is_https);

			expect(test_results.bodyLimit).to.equal(REQ_MAX_BODY_SIZE);
			expect(test_results.keepAliveTimeout).to.equal(test_config_settings.keep_alive_timeout);
			expect(test_results.connectionTimeout).to.equal(test_config_settings.server_timeout);
			expect(test_results.https).to.be.undefined;

			server.close();
		});

		it('should return https server options based based on settings values', async () => {
			const test_config_settings = { server_timeout: 3333, keep_alive_timeout: 2222 };
			test_utils.preTestPrep(test_config_settings);

			const hdbServer_rw = await rewire(HDB_SERVER_PATH);
			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = hdbServer_rw.__get__('server');
			const getServerOptions_rw = hdbServer_rw.__get__('getServerOptions');

			const test_is_https = true;
			const test_results = getServerOptions_rw(test_is_https);

			expect(test_results.bodyLimit).to.equal(REQ_MAX_BODY_SIZE);
			expect(test_results.keepAliveTimeout).to.equal(test_config_settings.keep_alive_timeout);
			expect(test_results.connectionTimeout).to.equal(test_config_settings.server_timeout);
			expect(test_results.https).to.be.an.instanceOf(Object);
			expect(test_results.https.key).to.be.an.instanceOf(Buffer);
			expect(test_results.https.cert).to.be.an.instanceOf(Buffer);

			server.close();
		});
	});

	describe('getHeaderTimeoutConfig() method', () => {
		it('should return the header timeout config value', async () => {
			const hdbServer_rw = await rewire(HDB_SERVER_PATH);
			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = hdbServer_rw.__get__('server');
			const getHeaderTimeoutConfig_rw = hdbServer_rw.__get__('getHeaderTimeoutConfig');

			const test_config_settings = { headers_timeout: 1234 };
			test_utils.preTestPrep(test_config_settings);

			const test_results = getHeaderTimeoutConfig_rw();
			expect(test_results).to.equal(test_config_settings.headers_timeout);

			server.close();
		});
	});

	describe('setUp() method', () => {
		beforeEach(() => {
			sandbox.resetHistory();
		});

		it('NOMINAL - should call initial setup methods', async () => {
			const hdbServer_rw = await rewire(HDB_SERVER_PATH);
			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = hdbServer_rw.__get__('server');

			expect(setSchemaGlobal_stub.called).to.be.true;
			expect(setUsersToGlobal_stub.called).to.be.true;
			expect(getLicense_stub.called).to.be.true;

			server.close();
		});

		it('should catch error thrown within method and log', async () => {
			const test_err = 'test error!';
			getLicense_stub.throws(new Error(test_err));
			const hdbServer_rw = await rewire(HDB_SERVER_PATH);
			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = hdbServer_rw.__get__('server');
			await hdbServer_rw.__get__('setUp');

			expect(logger_error_spy.called).to.be.true;
			expect(logger_error_spy.getCall(0).args[0].message).to.equal(test_err);

			server.close();
		});
	});
});
