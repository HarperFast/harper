'use strict';

const test_utils = require('../../test_utils');

const rewire = require('rewire');
const fs = require('fs-extra');
const path = require('path');
const { pack } = require('msgpackr');
const { encode, decode } = require('cbor-x');
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
require('../../../server/threads/threadServer');

const { CONFIG_PARAMS } = require('../../../utility/hdbTerms');
const HDB_SERVER_PATH = '../../../server/operationsServer';
const KEYS_PATH = path.join(test_utils.getMockTestPath(), 'utility/keys');
const PRIVATE_KEY_PATH = path.join(KEYS_PATH, 'privateKey.pem');
const CERTIFICATE_PATH = path.join(KEYS_PATH, 'certificate.pem');

const test_req_options = {
	headers: {
		'Accept': 'application/json',
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
	'content-type-negotiation',
];

let setUsersToGlobal_stub;
let setSchemaGlobal_stub;
let handlePostRequest_spy;
let getLicense_stub;
let logger_error_spy;

const test_op_resp = [];
for (let i = 0; i < 10; i++) {
	test_op_resp.push({
		i,
		name: 'test',
	});
}
async function* test_iterable_response() {
	for (let i = 0; i < 10; i++) {
		if (i % 4 === 0) await new Promise((resolve) => setTimeout(resolve, 1));
		yield test_op_resp[i];
	}
}

const test_cert_val = test_utils.getHTTPSCredentials().cert;
const test_key_val = test_utils.getHTTPSCredentials().key;

describe('Test hdbServer module', () => {
	before(() => {
		env.initTestEnvironment();

		sandbox.stub(harper_logger, 'info').callsFake(() => {});
		sandbox.stub(harper_logger, 'debug').callsFake(() => {});
		sandbox.stub(harper_logger, 'fatal').callsFake(() => {});
		sandbox.stub(harper_logger, 'trace').callsFake(() => {});
		sandbox.stub(OperationFunctionCaller, 'callOperationFunctionAsAwait').callsFake(() => {
			return test_iterable_response();
		});
		sandbox.stub(serverHandlers, 'authHandler').callsFake((req, resp, done) => done());
		sandbox.stub(server_utilities, 'chooseOperation').callsFake(() => {});
		setUsersToGlobal_stub = sandbox.stub(user_schema, 'setUsersWithRolesCache').resolves();
		//setSchemaGlobal_stub = sandbox.stub(global_schema, 'setSchemaDataToGlobal').callsArg(0);
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
			const test_config_settings = { operationsApi_network_securePort: 9927 };
			env.setProperty('operationsApi_network_securePort', 9927);
			test_utils.preTestPrep(test_config_settings);

			const hdbServer_rw = await rewire(HDB_SERVER_PATH);
			await hdbServer_rw.hdbServer({ securePort: 9927 }); // need to use explicit ports

			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = hdbServer_rw.__get__('server');

			expect(server).to.not.be.undefined;
			expect(server.server.constructor.name).to.contains('Server');
			expect(typeof server.server.sessionIdContext === 'string').to.be.true;
			expect(!!server.initialConfig.https).to.be.true;

			server.close();
			env.setProperty('operationsApi_network_securePort', null);
		});
		it('should build HTTPS server when https_enabled set to true and multiple tls', async () => {
			const test_config_settings = { operationsApi_network_securePort: 9927 };
			env.setProperty('operationsApi_network_securePort', 9927);
			// invalid certificate and private key, but verify that they are read
			env.setProperty('operationsApi_tls', [
				{
					certificate: '-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE----- ',
					privateKey: '-----BEGIN RSA PRIVATE KEY-----\n-----END RSA PRIVATE KEY-----',
					hostnames: ['localhost', 'localhost2'],
				},
			]);
			test_utils.preTestPrep(test_config_settings);

			const hdbServer = await require(HDB_SERVER_PATH);
			let caught_error;
			hdbServer.hdbServer({ securePort: 9927 }); // need to use explicit ports
		});

		it('should build HTTP server when https_enabled set to false', async () => {
			const test_config_settings = { https_enabled: false };
			test_utils.preTestPrep(test_config_settings);

			const hdbServer_rw = await rewire(HDB_SERVER_PATH);
			await hdbServer_rw.hdbServer({ port: 9925 });

			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = hdbServer_rw.__get__('server');

			expect(server).to.not.be.undefined;
			expect(server.server.constructor.name).to.equal('Server');
			expect(typeof server.server.sessionIdContext === 'string').to.be.false;

			server.close();
		});

		it('should build HTTPS server instance with started and listening state equal to true', async () => {
			const test_config_settings = { https_enabled: true };
			test_utils.preTestPrep(test_config_settings);
			env.setProperty('operationsApi_network_securePort', 9927);

			const hdbServer_rw = await rewire(HDB_SERVER_PATH);
			await hdbServer_rw.hdbServer({ securePort: 9927 });

			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = hdbServer_rw.__get__('server');

			const state_key = Object.getOwnPropertySymbols(server).find((s) => String(s) === 'Symbol(fastify.state)');
			expect(server[state_key].started).to.be.true;

			server.close();
			env.setProperty('operationsApi_network_securePort', null);
		});

		it('should build HTTP server instance with started and listening state equal to true', async () => {
			const test_config_settings = { https_enabled: false };
			test_utils.preTestPrep(test_config_settings);

			const hdbServer_rw = await rewire(HDB_SERVER_PATH);
			await hdbServer_rw.hdbServer({ port: 9925 });

			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = hdbServer_rw.__get__('server');

			const state_key = Object.getOwnPropertySymbols(server).find((s) => String(s) === 'Symbol(fastify.state)');
			expect(server[state_key].started).to.be.true;

			server.close();
		});

		it('should build HTTP server instances with mixed cap boolean spelling', async () => {
			const test_config_settings = { https_enabled: 'FalsE' };
			test_utils.preTestPrep(test_config_settings);

			const hdbServer_rw = await rewire(HDB_SERVER_PATH);
			await hdbServer_rw.hdbServer({ port: 9925 });

			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = hdbServer_rw.__get__('server');

			expect(server).to.not.be.undefined;
			expect(server.server.constructor.name).to.equal('Server');
			expect(typeof server.server.sessionIdContext === 'string').to.be.false;

			server.close();
		});

		it('should build HTTPS server instance with default config settings', async () => {
			const hdbServer_rw = await rewire(HDB_SERVER_PATH);
			await hdbServer_rw.hdbServer({ port: 9925 });

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
			await hdbServer_rw.hdbServer({ port: 9925 });

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
			await hdbServer_rw.hdbServer({ port: 9925 });

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
			await hdbServer_rw.hdbServer({ port: 9925 });

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
			await hdbServer_rw.hdbServer({ port: 9925 });

			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = hdbServer_rw.__get__('server');

			const plugin_key = Object.getOwnPropertySymbols(server).find(
				(s) => String(s) === 'Symbol(fastify.pluginNameChain)'
			);

			expect(server[plugin_key]).to.not.includes('@fastify/cors');

			server.close();
		});

		it('should register @fastify/cors if cors is enabled', async () => {
			const test_config_settings = { cors_enabled: true, cors_accesslist: 'harperdb.io, sam-johnson.io' };
			test_utils.preTestPrep(test_config_settings);

			const hdbServer_rw = await rewire(HDB_SERVER_PATH);
			await hdbServer_rw.hdbServer({ port: 9925 });

			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = hdbServer_rw.__get__('server');

			const plugin_key = Object.getOwnPropertySymbols(server).find(
				(s) => String(s) === 'Symbol(fastify.pluginNameChain)'
			);

			expect(server[plugin_key]).to.includes('@fastify/cors');

			server.close();
		});

		it('should register @fastify/cors if cors is enabled boolean has mixed cap spelling', async () => {
			const test_config_settings = { cors_enabled: 'TRue', cors_accesslist: 'harperdb.io, sam-johnson.io' };
			test_utils.preTestPrep(test_config_settings);

			const hdbServer_rw = await rewire(HDB_SERVER_PATH);
			await hdbServer_rw.hdbServer({ port: 9925 });

			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = hdbServer_rw.__get__('server');

			const plugin_key = Object.getOwnPropertySymbols(server).find(
				(s) => String(s) === 'Symbol(fastify.pluginNameChain)'
			);

			expect(server[plugin_key]).to.includes('@fastify/cors');

			server.close();
		});

		it('should call handlePostRequest on HTTP post request', async () => {
			const test_config_settings = { https_enabled: false };
			test_utils.preTestPrep(test_config_settings);

			const hdbServer_rw = await rewire(HDB_SERVER_PATH);
			await hdbServer_rw.hdbServer({ port: 9925 });

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
			await hdbServer_rw.hdbServer({ port: 9925 });

			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = hdbServer_rw.__get__('server');

			const test_response = await server.inject({
				method: 'POST',
				url: '/',
				headers: { ...test_req_options.headers, Accept: 'application/x-msgpack' },
				body: test_req_options.body,
			});

			expect(test_response.statusCode).to.equal(200);
			const expectedResponse = Buffer.concat(test_op_resp.map((entry) => pack(entry)));
			expect(test_response.rawPayload).to.deep.equal(expectedResponse);

			server.close();
		});

		it('should parse MessagePack when HTTP request include Content-Type: application/x-msgpack', async () => {
			const test_config_settings = { https_enabled: false };
			test_utils.preTestPrep(test_config_settings);

			const hdbServer_rw = await rewire(HDB_SERVER_PATH);
			await hdbServer_rw.hdbServer({ port: 9925 });

			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = hdbServer_rw.__get__('server');

			const body = pack(test_req_options.body);
			const test_response = await server.inject({
				method: 'POST',
				url: '/',
				headers: {
					...test_req_options.headers,
					'Accept': 'application/json',
					'Content-Type': 'application/x-msgpack',
					'Content-Length': body.length,
				},
				body,
			});

			expect(test_response.statusCode).to.equal(200);
			expect(test_response.body).to.equal(JSON.stringify(test_op_resp));

			server.close();
		});

		it('should 400 with invalid MessagePack', async () => {
			const test_config_settings = { https_enabled: false };
			test_utils.preTestPrep(test_config_settings);

			const hdbServer_rw = await rewire(HDB_SERVER_PATH);
			await hdbServer_rw.hdbServer({ port: 9925 });

			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = hdbServer_rw.__get__('server');

			const body = Buffer.from('this is not valid MessagePack');
			const test_response = await server.inject({
				method: 'POST',
				url: '/',
				headers: {
					...test_req_options.headers,
					'Content-Type': 'application/x-msgpack',
					'Content-Length': body.length,
				},
				body,
			});

			expect(test_response.statusCode).to.equal(400);

			server.close();
		});
		it('should return CBOR when HTTP request include Accept: application/cbor', async () => {
			const test_config_settings = { https_enabled: false };
			test_utils.preTestPrep(test_config_settings);

			const hdbServer_rw = await rewire(HDB_SERVER_PATH);
			await hdbServer_rw.hdbServer({ port: 9925 });
			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = hdbServer_rw.__get__('server');

			const test_response = await server.inject({
				method: 'POST',
				url: '/',
				headers: { ...test_req_options.headers, Accept: 'application/cbor' },
				body: test_req_options.body,
			});

			expect(test_response.statusCode).to.equal(200);
			let decoded = decode(test_response.rawPayload);
			expect(decoded).to.deep.equal(test_op_resp);

			server.close();
		});

		it('should parse CBOR when HTTP request include Content-Type: application/x-msgpack', async () => {
			const test_config_settings = { https_enabled: false };
			test_utils.preTestPrep(test_config_settings);

			const hdbServer_rw = await rewire(HDB_SERVER_PATH);
			await hdbServer_rw.hdbServer({ port: 9925 });

			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = hdbServer_rw.__get__('server');

			const body = encode(test_req_options.body);
			const test_response = await server.inject({
				method: 'POST',
				url: '/',
				headers: {
					...test_req_options.headers,
					'Accept': 'application/json',
					'Content-Type': 'application/cbor',
					'Content-Length': body.length,
				},
				body,
			});

			expect(test_response.statusCode).to.equal(200);
			expect(test_response.body).to.equal(JSON.stringify(test_op_resp));

			server.close();
		});

		it('should 400 with invalid CBOR', async () => {
			const test_config_settings = { https_enabled: false };
			test_utils.preTestPrep(test_config_settings);

			const hdbServer_rw = await rewire(HDB_SERVER_PATH);
			await hdbServer_rw.hdbServer({ port: 9925 });

			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = hdbServer_rw.__get__('server');

			const body = Buffer.from('this is not valid CBOR');
			const test_response = await server.inject({
				method: 'POST',
				url: '/',
				headers: { ...test_req_options.headers, 'Content-Type': 'application/cbor', 'Content-Length': body.length },
				body,
			});

			expect(test_response.statusCode).to.equal(400);

			server.close();
		});
		it('should return CSV when HTTP request include Accept: text/csv', async () => {
			const test_config_settings = { https_on: false };
			test_utils.preTestPrep(test_config_settings);

			const hdbServer_rw = await rewire(HDB_SERVER_PATH);
			await hdbServer_rw.hdbServer({ port: 9925 });
			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = hdbServer_rw.__get__('server');

			const test_response = await server.inject({
				method: 'POST',
				url: '/',
				headers: { ...test_req_options.headers, Accept: 'text/csv' },
				body: test_req_options.body,
			});

			expect(test_response.statusCode).to.equal(200);
			const expectedResponse =
				'"i","name"\n0,"test"\n1,"test"\n2,"test"\n3,"test"\n4,"test"\n5,"test"\n6,"test"\n7,"test"\n8,"test"\n9,"test"';
			expect(test_response.body).to.equal(expectedResponse);

			server.close();
		});

		it.skip('should return docs html static file result w/ status 200 for valid HTTP get request', async () => {
			const test_config_settings = { https_enabled: false, local_studio_on: true };
			test_utils.preTestPrep(test_config_settings);

			const hdbServer_rw = await rewire(HDB_SERVER_PATH);
			await hdbServer_rw.hdbServer({ port: 9925 });
			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = hdbServer_rw.__get__('server');

			const test_response = await server.inject({ method: 'get', url: '/' });

			expect(test_response.statusCode).to.equal(200);
			expect(test_response.body).to.equal(fs.readFileSync(path.join(__dirname, '../../../studio/index.html'), 'utf8'));

			server.close();
		});

		it.skip('should return docs html static file result w/ status 200 for valid HTTPS get request', async () => {
			const test_config_settings = { https_enabled: true, local_studio_on: true };
			test_utils.preTestPrep(test_config_settings);

			const hdbServer_rw = await rewire(HDB_SERVER_PATH);
			await hdbServer_rw.hdbServer({ port: 9925 });
			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = hdbServer_rw.__get__('server');

			const test_response = await server.inject({ method: 'get', url: '/' });

			expect(test_response.statusCode).to.equal(200);
			expect(test_response.body).to.equal(fs.readFileSync(path.join(__dirname, '../../../studio/index.html'), 'utf8'));

			server.close();
		});

		it.skip('should not return docs html static file result w/ status 404 for valid HTTP get request when local studio is turned off', async () => {
			const test_config_settings = { https_enabled: false, local_studio_on: false };
			test_utils.preTestPrep(test_config_settings);

			const hdbServer_rw = await rewire(HDB_SERVER_PATH);
			await hdbServer_rw.hdbServer({ port: 9925 });
			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = hdbServer_rw.__get__('server');

			const test_response = await server.inject({ method: 'get', url: '/' });

			expect(test_response.statusCode).to.equal(200);
			expect(test_response.body).to.equal(
				fs.readFileSync(path.join(__dirname, '../../../studio/running.html'), 'utf8')
			);

			server.close();
		});

		it.skip('should not return docs html static file result w/ status 404 for valid HTTPS get request when local studio is turned off', async () => {
			const test_config_settings = { https_enabled: true, local_studio_on: false };
			test_utils.preTestPrep(test_config_settings);

			const hdbServer_rw = await rewire(HDB_SERVER_PATH);
			await hdbServer_rw.hdbServer({ port: 9925 });
			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = hdbServer_rw.__get__('server');

			const test_response = await server.inject({ method: 'get', url: '/' });

			expect(test_response.statusCode).to.equal(200);
			expect(test_response.body).to.equal(
				fs.readFileSync(path.join(__dirname, '../../../studio/running.html'), 'utf8')
			);

			server.close();
		});

		it('should return op result w/ status 200 for valid HTTP post request', async () => {
			const test_config_settings = { https_enabled: false };
			test_utils.preTestPrep(test_config_settings);

			const hdbServer_rw = await rewire(HDB_SERVER_PATH);
			await hdbServer_rw.hdbServer({ port: 9925 });
			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = hdbServer_rw.__get__('server');

			const test_response = await server.inject({
				method: 'POST',
				url: '/',
				headers: test_req_options.headers,
				body: test_req_options.body,
			});

			expect(test_response.statusCode).to.equal(200);
			expect(test_response.body).to.equal(JSON.stringify(test_op_resp));

			server.close();
		});

		it('should call handlePostRequest on HTTPS post request', async () => {
			const hdbServer_rw = await rewire(HDB_SERVER_PATH);
			await hdbServer_rw.hdbServer({ port: 9925 });
			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = hdbServer_rw.__get__('server');

			await server.inject({ method: 'POST', url: '/', headers: test_req_options.headers, body: test_req_options.body });

			expect(handlePostRequest_spy.calledOnce).to.be.true;

			server.close();
		});

		it('should return op result w/ status 200 for valid HTTPS post request', async () => {
			const hdbServer_rw = await rewire(HDB_SERVER_PATH);
			await hdbServer_rw.hdbServer({ port: 9925 });
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
			await hdbServer_rw.hdbServer({ port: 9925 });
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
			await hdbServer_rw.hdbServer({ port: 9925 });
			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = hdbServer_rw.__get__('server');

			const test_headers = { origin: 'https://google.com', ...test_req_options.headers };
			const test_response = await server.inject({
				method: 'POST',
				url: '/',
				headers: test_headers,
				body: test_req_options.body,
			});

			expect(test_response.headers['access-allow-origin']).to.equal(undefined);

			server.close();
		});

		it('should return resp with 200 for request from origin included in CORS whitelist', async () => {
			const test_config_settings = { cors_enabled: true, cors_accesslist: 'https://harperdb.io' };
			test_utils.preTestPrep(test_config_settings);

			const hdbServer_rw = await rewire(HDB_SERVER_PATH);
			await hdbServer_rw.hdbServer({ port: 9925 });
			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = hdbServer_rw.__get__('server');

			const test_headers = { origin: 'https://harperdb.io', ...test_req_options.headers };
			const test_response = await server.inject({
				method: 'POST',
				url: '/',
				headers: test_headers,
				body: test_req_options.body,
			});

			expect(test_response.headers['access-control-allow-origin']).to.equal('https://harperdb.io');
			server.close();
		});
	});

	describe('buildServer() method', () => {
		it('should return an http server', async () => {
			const hdbServer_rw = await rewire(HDB_SERVER_PATH);
			await hdbServer_rw.hdbServer({ port: 9925 });
			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = hdbServer_rw.__get__('server');
			const buildServer_rw = hdbServer_rw.__get__('buildServer');

			const test_is_https = false;
			const test_result = await buildServer_rw(test_is_https);

			expect(test_result.server.constructor.name).to.equal('Server');
			expect(typeof test_result.server.sessionIdContext === 'string').to.be.false;

			server.close();
		});

		it('should return an https server', async () => {
			const hdbServer_rw = await rewire(HDB_SERVER_PATH);
			await hdbServer_rw.hdbServer({ port: 9925 });
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
			await hdbServer_rw.hdbServer({ port: 9925 });
			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = hdbServer_rw.__get__('server');
			const getServerOptions_rw = hdbServer_rw.__get__('getServerOptions');

			const test_is_https = false;
			const test_results = getServerOptions_rw(test_is_https);

			expect(test_results.bodyLimit).to.equal(REQ_MAX_BODY_SIZE);
			expect(test_results.keepAliveTimeout).to.equal(test_config_settings.keep_alive_timeout);
			expect(test_results.connectionTimeout).to.equal(test_config_settings.server_timeout);
			expect(test_results.https).to.be.false;

			server.close();
		});

		it('should return https server options based based on settings values', async () => {
			const test_config_settings = { server_timeout: 3333, keep_alive_timeout: 2222 };
			test_utils.preTestPrep(test_config_settings);

			const hdbServer_rw = await rewire(HDB_SERVER_PATH);
			await hdbServer_rw.hdbServer({ securePort: 9927 });
			await new Promise((resolve) => setTimeout(resolve, 100));
			const server = hdbServer_rw.__get__('server');
			const getServerOptions_rw = hdbServer_rw.__get__('getServerOptions');

			const test_is_https = true;
			const test_results = getServerOptions_rw(test_is_https);

			expect(test_results.bodyLimit).to.equal(REQ_MAX_BODY_SIZE);
			expect(test_results.keepAliveTimeout).to.equal(test_config_settings.keep_alive_timeout);
			expect(test_results.connectionTimeout).to.equal(test_config_settings.server_timeout);
			expect(test_results.https).to.be.true;

			server.close();
		});
	});

	describe('getHeaderTimeoutConfig() method', () => {
		it('should return the header timeout config value', async () => {
			const hdbServer_rw = await rewire(HDB_SERVER_PATH);
			await hdbServer_rw.hdbServer({ port: 9925 });
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
});
