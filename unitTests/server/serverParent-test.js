'use strict';

const test_utils = require('../test_utils');

const rewire = require('rewire');
const fs = require('fs-extra');
const path = require('path');
const DEFAULT_CONFIG = require('../../utility/hdbTerms').HDB_SETTINGS_DEFAULT_VALUES;

const serverHandlers = require('../../server/serverHelpers/serverHandlers');
const server_utilities = require('../../server/serverHelpers/serverUtilities');
const OperationFunctionCaller = require('../../utility/OperationFunctionCaller');
const harper_logger = require('../../utility/logging/harper_logger');

const KEYS_PATH = path.join(test_utils.getMockFSPath(), 'utility/keys');
const PRIVATE_KEY_PATH = path.join(KEYS_PATH, 'privateKey.pem');
const CERTIFICATE_PATH = path.join(KEYS_PATH, 'certificate.pem');

const chai = require('chai');
const { expect } = chai;
const sinon = require('sinon');
const sandbox = sinon.createSandbox();

let serverParent_rw;
let launch_orig;
let check_jwt_tokens_stub;
let process_stub;
let cluster_stub;
let launch_stub;
let hdb_license_stub;
let p_schema_to_global_stub;
let closeEnv_stub;
let setUsersToGlobal_stub
let logger_notify_stub;
let logger_info_stub;
let logger_debug_stub;
let logger_fatal_stub;
let logger_error_stub;
const fake = () => {};

const test_worker_num = 3;
const test_license_values = {
    "exp_date": 1643328000000,
    "storage_type": "fs",
    "api_call": 10000,
    "ram_allocation": 8192,
    "version": "2.2.0",
    "enterprise": true
}

describe('Test serverParent.js', () => {
    before(() => {
        serverParent_rw = rewire('../../server/serverParent');

        logger_notify_stub = sandbox.stub(harper_logger, 'notify').callsFake(fake);
        logger_info_stub = sandbox.stub(harper_logger, 'info').callsFake(fake);
        logger_debug_stub = sandbox.stub(harper_logger, 'debug').callsFake(fake);
        logger_fatal_stub = sandbox.stub(harper_logger, 'fatal').callsFake(fake);
        logger_error_stub = sandbox.stub(harper_logger, 'error').callsFake(fake);
        check_jwt_tokens_stub = sandbox.stub().callsFake(fake);
        serverParent_rw.__set__('check_jwt_tokens', check_jwt_tokens_stub);
        launch_stub = sandbox.stub().resolves();
        launch_orig = serverParent_rw.__get__('launch');
        serverParent_rw.__set__('launch', launch_stub);
    })

    afterEach(async() => {
        sandbox.resetHistory();
    })

    after(() => {
        sandbox.restore();
        rewire('../../server/serverParent');
    })

    describe('exported serverParent method', () => {

        it('should launch parent process', async() => {
            await serverParent_rw(test_worker_num);

            expect(check_jwt_tokens_stub.calledOnce).to.be.true;
            expect(launch_stub.calledOnce).to.be.true;
            expect(launch_stub.args[0][0]).to.eql(test_worker_num);
        })

        // it('should build HTTP server when HTTPS_ON set to false', async() => {
        //     const test_config_settings = { https_enabled: false }
        //     test_utils.preTestPrep(test_config_settings);
        //     serverChild_rw = rewire('../../server/serverChild');
        //
        //     await serverChild_rw();
        //     const hdb_server = serverChild_rw.__get__('hdbServer');
        //
        //     expect(hdb_server).to.not.be.undefined;
        //     expect(hdb_server.server.constructor.name).to.equal('Server');
        //     expect(hdb_server.initialConfig.https).to.be.undefined;
        // })
        //
        // it('should build HTTPS server instance with started and listening state equal to true', async() => {
        //     const test_config_settings = { https_enabled: true }
        //     test_utils.preTestPrep(test_config_settings);
        //     serverChild_rw = rewire('../../server/serverChild');
        //
        //     await serverChild_rw();
        //     const hdb_server = serverChild_rw.__get__('hdbServer');
        //
        //     const state_key = Object.getOwnPropertySymbols(hdb_server).find((s => String(s) === "Symbol(fastify.state)"))
        //     expect(hdb_server[state_key].started).to.be.true;
        //     expect(hdb_server[state_key].listening).to.be.true;
        // })
        //
        // it('should build HTTP server instance with started and listening state equal to true', async() => {
        //     const test_config_settings = { https_enabled: false }
        //     test_utils.preTestPrep(test_config_settings);
        //     serverChild_rw = rewire('../../server/serverChild');
        //
        //     await serverChild_rw();
        //     const hdb_server = serverChild_rw.__get__('hdbServer');
        //
        //     const state_key = Object.getOwnPropertySymbols(hdb_server).find((s => String(s) === "Symbol(fastify.state)"))
        //     expect(hdb_server[state_key].started).to.be.true;
        //     expect(hdb_server[state_key].listening).to.be.true;
        // })
        //
        // it('should build HTTPS server instances with mixed cap boolean spelling', async() => {
        //     const test_config_settings = { https_enabled: 'TRUe' }
        //     test_utils.preTestPrep(test_config_settings);
        //     serverChild_rw = rewire('../../server/serverChild');
        //
        //     await serverChild_rw();
        //     const hdb_server = serverChild_rw.__get__('hdbServer');
        //
        //     expect(hdb_server).to.not.be.undefined;
        //     expect(hdb_server.server.constructor.name).to.equal('Server');
        //     expect(hdb_server.server.key).to.be.instanceOf(Buffer);
        //     expect(hdb_server.server.cert).to.be.instanceOf(Buffer);
        //     expect(hdb_server.initialConfig.https).to.be.true;
        // })
        //
        // it('should build HTTP server instances with mixed cap boolean spelling', async() => {
        //     const test_config_settings = { https_enabled: 'FalsE' }
        //     test_utils.preTestPrep(test_config_settings);
        //     serverChild_rw = rewire('../../server/serverChild');
        //
        //     await serverChild_rw();
        //     const hdb_server = serverChild_rw.__get__('hdbServer');
        //
        //     expect(hdb_server).to.not.be.undefined;
        //     expect(hdb_server.server.constructor.name).to.equal('Server');
        //     expect(hdb_server.initialConfig.https).to.be.undefined;
        // })
        //
        // it('should register 3 fastify plugins by default - fastify-helmet, fastify-compress, fastify-static', async() => {
        //     await serverChild_rw();
        //     const hdb_server = serverChild_rw.__get__('hdbServer');
        //     const plugin_key = Object.getOwnPropertySymbols(hdb_server).find((s => String(s) === "Symbol(fastify.pluginNameChain)"))
        //
        //     expect(hdb_server[plugin_key]).to.deep.equal(DEFAULT_FASTIFY_PLUGIN_ARR);
        // })
        //
        // it('should build HTTPS server instance with default config settings', async() => {
        //     await serverChild_rw();
        //     const test_max_body_size = serverChild_rw.__get__('REQ_MAX_BODY_SIZE');
        //     const hdb_server = serverChild_rw.__get__('hdbServer');
        //
        //     expect(hdb_server.initialConfig.bodyLimit).to.equal(test_max_body_size);
        //     expect(hdb_server.initialConfig.connectionTimeout).to.equal(DEFAULT_CONFIG.SERVER_TIMEOUT_MS);
        //     expect(hdb_server.initialConfig.keepAliveTimeout).to.equal(DEFAULT_CONFIG.SERVER_KEEP_ALIVE_TIMEOUT);
        // })
        //
        // it('should build HTTP server instances with default config settings', async() => {
        //     const test_config_settings = { https_enabled: false }
        //     test_utils.preTestPrep(test_config_settings);
        //     serverChild_rw = rewire('../../server/serverChild');
        //
        //     await serverChild_rw();
        //     const test_max_body_size = serverChild_rw.__get__('REQ_MAX_BODY_SIZE');
        //     const hdb_server = serverChild_rw.__get__('hdbServer');
        //
        //     expect(hdb_server.initialConfig.bodyLimit).to.equal(test_max_body_size);
        //     expect(hdb_server.initialConfig.connectionTimeout).to.equal(DEFAULT_CONFIG.SERVER_TIMEOUT_MS);
        //     expect(hdb_server.initialConfig.keepAliveTimeout).to.equal(DEFAULT_CONFIG.SERVER_KEEP_ALIVE_TIMEOUT);
        // })
        //
        // it('should build HTTPS server instances with provided config settings', async() => {
        //     const test_config_settings = {
        //         https_on: true,
        //         server_timeout: 3333,
        //         keep_alive_timeout: 2222,
        //         headers_timeout: 1111
        //     }
        //     test_utils.preTestPrep(test_config_settings);
        //     serverChild_rw = rewire('../../server/serverChild');
        //
        //     await serverChild_rw();
        //     const hdb_server = serverChild_rw.__get__('hdbServer');
        //
        //     expect(hdb_server.server.timeout).to.equal(test_config_settings.server_timeout);
        //     expect(hdb_server.server.keepAliveTimeout).to.equal(test_config_settings.keep_alive_timeout);
        //     expect(hdb_server.server.headersTimeout).to.equal(test_config_settings.headers_timeout);
        // })
        //
        // it('should build HTTP server instances with provided config settings', async() => {
        //     const test_config_settings = {
        //         https_on: false,
        //         server_timeout: 3333,
        //         keep_alive_timeout: 2222,
        //         headers_timeout: 1111
        //     }
        //     test_utils.preTestPrep(test_config_settings);
        //     serverChild_rw = rewire('../../server/serverChild');
        //
        //     await serverChild_rw();
        //     const hdb_server = serverChild_rw.__get__('hdbServer');
        //
        //     expect(hdb_server.server.timeout).to.equal(test_config_settings.server_timeout);
        //     expect(hdb_server.server.keepAliveTimeout).to.equal(test_config_settings.keep_alive_timeout);
        //     expect(hdb_server.server.headersTimeout).to.equal(test_config_settings.headers_timeout);
        // })
        //
        // it('should not register fastify-cors if cors is not enabled',async() => {
        //     test_utils.preTestPrep();
        //     await serverChild_rw();
        //     const hdb_server = serverChild_rw.__get__('hdbServer');
        //
        //     const plugin_key = Object.getOwnPropertySymbols(hdb_server).find((s => String(s) === "Symbol(fastify.pluginNameChain)"))
        //
        //     expect(hdb_server[plugin_key].length).to.equal(3);
        //     expect(hdb_server[plugin_key]).to.deep.equal(['fastify-helmet', 'fastify-compress', 'fastify-static']);
        // })
        //
        // it('should register fastify-cors if cors is enabled',async() => {
        //     const test_config_settings = {
        //         cors_enabled: true,
        //         cors_whitelist: 'harperdb.io, sam-johnson.io'
        //     }
        //     test_utils.preTestPrep(test_config_settings);
        //     await serverChild_rw();
        //     const hdb_server = serverChild_rw.__get__('hdbServer');
        //
        //     const plugin_key = Object.getOwnPropertySymbols(hdb_server).find((s => String(s) === "Symbol(fastify.pluginNameChain)"))
        //
        //     expect(hdb_server[plugin_key].length).to.equal(4);
        //     expect(hdb_server[plugin_key]).to.deep.equal(['fastify-cors', ...DEFAULT_FASTIFY_PLUGIN_ARR]);
        // })
        //
        // it('should register fastify-cors if cors is enabled boolean has mixed cap spelling',async() => {
        //     const test_config_settings = {
        //         cors_enabled: 'TRue',
        //         cors_whitelist: 'harperdb.io, sam-johnson.io'
        //     }
        //     test_utils.preTestPrep(test_config_settings);
        //     await serverChild_rw();
        //     const hdb_server = serverChild_rw.__get__('hdbServer');
        //
        //     const plugin_key = Object.getOwnPropertySymbols(hdb_server).find((s => String(s) === "Symbol(fastify.pluginNameChain)"))
        //
        //     expect(hdb_server[plugin_key].length).to.equal(4);
        //     expect(hdb_server[plugin_key]).to.deep.equal(['fastify-cors', ...DEFAULT_FASTIFY_PLUGIN_ARR]);
        // })
        //
        //
        //
        // it('should call handlePostRequest on HTTP post request',async() => {
        //     const test_config_settings = { https_on: false }
        //     test_utils.preTestPrep(test_config_settings);
        //     serverChild_rw = rewire('../../server/serverChild');
        //
        //     await serverChild_rw();
        //     const hdb_server = serverChild_rw.__get__('hdbServer');
        //
        //     await hdb_server.inject({
        //         method: 'POST',
        //         url:'/',
        //         headers: test_req_options.headers,
        //         body: test_req_options.body
        //     })
        //
        //     expect(handlePostRequest_spy.calledOnce).to.be.true;
        // })
        //
        // it('should return docs html static file result w/ status 200 for valid HTTP get request',async() => {
        //     const test_config_settings = { https_on: false }
        //     test_utils.preTestPrep(test_config_settings);
        //     serverChild_rw = rewire('../../server/serverChild');
        //
        //     await serverChild_rw();
        //     const hdb_server = serverChild_rw.__get__('hdbServer');
        //
        //     const test_response = await hdb_server.inject({
        //         method: 'get',
        //         url:'/'
        //     })
        //
        //     expect(test_response.statusCode).to.equal(200);
        //     expect(test_response.body).to.equal(fs.readFileSync(path.join(__dirname, '../../docs/index.html'), 'utf8'));
        // })
        //
        // it('should return docs html static file result w/ status 200 for valid HTTPS get request',async() => {
        //     const test_config_settings = { https_on: true }
        //     test_utils.preTestPrep(test_config_settings);
        //     serverChild_rw = rewire('../../server/serverChild');
        //
        //     await serverChild_rw();
        //     const hdb_server = serverChild_rw.__get__('hdbServer');
        //
        //     const test_response = await hdb_server.inject({
        //         method: 'get',
        //         url:'/'
        //     })
        //
        //     expect(test_response.statusCode).to.equal(200);
        //     expect(test_response.body).to.equal(fs.readFileSync(path.join(__dirname, '../../docs/index.html'), 'utf8'));
        // })
        //
        // it('should return op result w/ status 200 for valid HTTP post request',async() => {
        //     const test_config_settings = { https_on: false }
        //     test_utils.preTestPrep(test_config_settings);
        //     serverChild_rw = rewire('../../server/serverChild');
        //     await serverChild_rw()
        //     const hdb_server = serverChild_rw.__get__('hdbServer');
        //
        //     const test_response = await hdb_server.inject({
        //         method: 'POST',
        //         url:'/',
        //         headers: test_req_options.headers,
        //         body: test_req_options.body
        //     })
        //
        //     expect(test_response.statusCode).to.equal(200);
        //     expect(test_response.body).to.equal(JSON.stringify({message: test_op_resp}));
        // })
        //
        // it('should call handlePostRequest on HTTPS post request',async() => {
        //     await serverChild_rw();
        //     const hdb_server = serverChild_rw.__get__('hdbServer');
        //
        //     await hdb_server.inject({
        //         method: 'POST',
        //         url:'/',
        //         headers: test_req_options.headers,
        //         body: test_req_options.body
        //     })
        //
        //     expect(handlePostRequest_spy.calledOnce).to.be.true;
        // })
        //
        // it('should return op result w/ status 200 for valid HTTPS post request',async() => {
        //     await serverChild_rw();
        //     const hdb_server = serverChild_rw.__get__('hdbServer');
        //
        //     const test_response = await hdb_server.inject({
        //         method: 'POST',
        //         url:'/',
        //         headers: test_req_options.headers,
        //         body: test_req_options.body
        //     })
        //
        //     expect(test_response.statusCode).to.equal(200);
        // })
        //
        // it('should return 400 error for post request w/o body',async() => {
        //     await serverChild_rw();
        //     const hdb_server = serverChild_rw.__get__('hdbServer');
        //
        //     const test_response = await hdb_server.inject({
        //         method: 'POST',
        //         url:'/',
        //         headers: test_req_options.headers
        //     })
        //
        //     expect(test_response.statusCode).to.equal(400);
        //     expect(test_response.json().error).to.equal("Body cannot be empty when content-type is set to 'application/json'");
        // })
        //
        // it('should return 500 error for request from origin not included in CORS whitelist',async() => {
        //     const test_config_settings = {
        //         cors_enabled: true,
        //         cors_whitelist: 'https://harperdb.io'
        //     }
        //
        //     test_utils.preTestPrep(test_config_settings);
        //
        //     await serverChild_rw();
        //     const hdb_server = serverChild_rw.__get__('hdbServer');
        //
        //     const test_headers = Object.assign({
        //         origin: 'https://google.com'
        //     }, test_req_options.headers);
        //
        //     const test_response = await hdb_server.inject({
        //         method: 'POST',
        //         url:'/',
        //         headers: test_headers,
        //         body: test_req_options.body
        //     })
        //
        //     expect(test_response.statusCode).to.equal(500);
        //     expect(test_response.json().error).to.equal("domain https://google.com is not whitelisted");
        // })
        //
        // it('should return resp with 200 for request from origin included in CORS whitelist',async() => {
        //     const test_config_settings = {
        //         cors_enabled: true,
        //         cors_whitelist: 'https://harperdb.io'
        //     }
        //
        //     test_utils.preTestPrep(test_config_settings);
        //
        //     await serverChild_rw();
        //     const hdb_server = serverChild_rw.__get__('hdbServer');
        //
        //     const test_headers = Object.assign({
        //         origin: 'https://harperdb.io'
        //     }, test_req_options.headers);
        //
        //     const test_response = await hdb_server.inject({
        //         method: 'POST',
        //         url:'/',
        //         headers: test_headers,
        //         body: test_req_options.body
        //     })
        //
        //     expect(test_response.statusCode).to.equal(200);
        // })
    })

    describe('launch() method',async() => {

        beforeEach(() => {

        })

        it('should do a thing', () => {
            // const test_config_settings = {
            //     headers_timeout: 1234
            // }
            // test_utils.preTestPrep(test_config_settings);
            //
            // const test_results = getHeaderTimeoutConfig_rw();
            // expect(test_results).to.equal(test_config_settings.headers_timeout);
        })
    })
})
