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
const signalling = require('../../utility/signalling');
const hdb_util = require('../../utility/common_utils');
const user_schema = require('../../security/user');

const KEYS_PATH = path.join(test_utils.getMockFSPath(), 'utility/keys');
const PRIVATE_KEY_PATH = path.join(KEYS_PATH, 'privateKey.pem');
const CERTIFICATE_PATH = path.join(KEYS_PATH, 'certificate.pem');

const test_req_options = {
    headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic YWRtaW46QWJjMTIzNCE='
    },
    body: { 'operation': 'describe_all'}
};

const REQ_MAX_BODY_SIZE = 1024*1024*1024; //this is 1GB in bytes
const DEFAULT_FASTIFY_PLUGIN_ARR = ['fastify-helmet', 'fastify-compress', 'fastify-static'];

const chai = require('chai');
const { expect } = chai;
const sinon = require('sinon');
const sandbox = sinon.createSandbox();

let serverChild_rw;
let handlePostRequest_spy;
let callOperation_stub;
let auth_stub;
let setup_stub;
let chooseOp_stub;
let logger_info_stub;
let logger_debug_stub;
let logger_error_spy;
let logger_fatal_spy;
const fake = () => {};

const test_op_resp = "table 'dev.dogz' successfully created.";
const test_cert_val = test_utils.getHTTPSCredentials().cert;
const test_key_val = test_utils.getHTTPSCredentials().key;

describe('Test serverChild.js', () => {
    let signalChildStarted_stub;

    before(() => {
        logger_info_stub = sandbox.stub(harper_logger, 'info').callsFake(fake);
        logger_debug_stub = sandbox.stub(harper_logger, 'debug').callsFake(fake);
        logger_error_spy = sandbox.stub(harper_logger, 'error').callsFake(fake);
        logger_fatal_spy = sandbox.stub(harper_logger, 'fatal').callsFake(fake);
        callOperation_stub = sandbox.stub(OperationFunctionCaller, 'callOperationFunctionAsAwait').resolves(test_op_resp);
        auth_stub = sandbox.stub(serverHandlers, 'authHandler').callsFake((req, resp, done) => done());
        handlePostRequest_spy = sandbox.spy(serverHandlers, 'handlePostRequest');
        chooseOp_stub = sandbox.stub(server_utilities, 'chooseOperation').callsFake(fake);
        signalChildStarted_stub = sandbox.stub(signalling, "signalChildStarted").callsFake(fake);
        setup_stub = sandbox.stub().callsFake(fake);

        serverChild_rw = rewire('../../server/serverChild');
        serverChild_rw.__set__('setUp', setup_stub);
        test_utils.preTestPrep();
        fs.mkdirpSync(KEYS_PATH);

        fs.writeFileSync(PRIVATE_KEY_PATH, test_key_val);
        fs.writeFileSync(CERTIFICATE_PATH, test_cert_val);
    })

    afterEach(async() => {
        test_utils.preTestPrep();
        const server = serverChild_rw.__get__('hdbServer');
        if (server) {
            await server.close();
        }
        sandbox.resetHistory();

        //remove listener added by serverChild component
        const exceptionListeners = process.listeners('uncaughtException');
        exceptionListeners.forEach(listener => {
            if (listener.name === 'handleServerUncaughtException') {
                process.removeListener('uncaughtException', listener);
            }
        })
    })

    after(() => {
        fs.removeSync(KEYS_PATH);
        sandbox.restore();
        rewire('../../server/serverChild');
    })

    describe('exported serverChild method', () => {

        it('should build HTTPS server when HTTPS_ON set to true', async() => {
            const test_config_settings = { https_enabled: true }
            test_utils.preTestPrep(test_config_settings);

            await serverChild_rw();
            const hdb_server = serverChild_rw.__get__('hdbServer');

            expect(hdb_server).to.not.be.undefined;
            expect(hdb_server.server.constructor.name).to.equal('Server');
            expect(hdb_server.server.key).to.be.instanceOf(Buffer);
            expect(hdb_server.server.cert).to.be.instanceOf(Buffer);
            expect(hdb_server.initialConfig.https).to.be.true;
        })

        it('should build HTTP server when HTTPS_ON set to false', async() => {
            const test_config_settings = { https_enabled: false }
            test_utils.preTestPrep(test_config_settings);

            await serverChild_rw();
            const hdb_server = serverChild_rw.__get__('hdbServer');

            expect(hdb_server).to.not.be.undefined;
            expect(hdb_server.server.constructor.name).to.equal('Server');
            expect(hdb_server.initialConfig.https).to.be.undefined;
        })

        it('should build HTTPS server instance with started and listening state equal to true', async() => {
            const test_config_settings = { https_enabled: true }
            test_utils.preTestPrep(test_config_settings);

            await serverChild_rw();
            const hdb_server = serverChild_rw.__get__('hdbServer');

            const state_key = Object.getOwnPropertySymbols(hdb_server).find((s => String(s) === "Symbol(fastify.state)"))
            expect(hdb_server[state_key].started).to.be.true;
            expect(hdb_server[state_key].listening).to.be.true;
        })

        it('should build HTTP server instance with started and listening state equal to true', async() => {
            const test_config_settings = { https_enabled: false }
            test_utils.preTestPrep(test_config_settings);

            await serverChild_rw();
            const hdb_server = serverChild_rw.__get__('hdbServer');

            const state_key = Object.getOwnPropertySymbols(hdb_server).find((s => String(s) === "Symbol(fastify.state)"))
            expect(hdb_server[state_key].started).to.be.true;
            expect(hdb_server[state_key].listening).to.be.true;
        })

        it('should build HTTPS server instances with mixed cap boolean spelling', async() => {
            const test_config_settings = { https_enabled: 'TRUe' }
            test_utils.preTestPrep(test_config_settings);

            await serverChild_rw();
            const hdb_server = serverChild_rw.__get__('hdbServer');

            expect(hdb_server).to.not.be.undefined;
            expect(hdb_server.server.constructor.name).to.equal('Server');
            expect(hdb_server.server.key).to.be.instanceOf(Buffer);
            expect(hdb_server.server.cert).to.be.instanceOf(Buffer);
            expect(hdb_server.initialConfig.https).to.be.true;
        })

        it('should build HTTP server instances with mixed cap boolean spelling', async() => {
            const test_config_settings = { https_enabled: 'FalsE' }
            test_utils.preTestPrep(test_config_settings);

            await serverChild_rw();
            const hdb_server = serverChild_rw.__get__('hdbServer');

            expect(hdb_server).to.not.be.undefined;
            expect(hdb_server.server.constructor.name).to.equal('Server');
            expect(hdb_server.initialConfig.https).to.be.undefined;
        })

        it('should register 3 fastify plugins by default - fastify-helmet, fastify-compress, fastify-static', async() => {
            await serverChild_rw();
            const hdb_server = serverChild_rw.__get__('hdbServer');
            const plugin_key = Object.getOwnPropertySymbols(hdb_server).find((s => String(s) === "Symbol(fastify.pluginNameChain)"))

            expect(hdb_server[plugin_key]).to.deep.equal(DEFAULT_FASTIFY_PLUGIN_ARR);
        })

        it('should build HTTPS server instance with default config settings', async() => {
            await serverChild_rw();
            const test_max_body_size = serverChild_rw.__get__('REQ_MAX_BODY_SIZE');
            const hdb_server = serverChild_rw.__get__('hdbServer');

            expect(hdb_server.initialConfig.bodyLimit).to.equal(test_max_body_size);
            expect(hdb_server.initialConfig.connectionTimeout).to.equal(DEFAULT_CONFIG.SERVER_TIMEOUT_MS);
            expect(hdb_server.initialConfig.keepAliveTimeout).to.equal(DEFAULT_CONFIG.SERVER_KEEP_ALIVE_TIMEOUT);
        })

        it('should build HTTP server instances with default config settings', async() => {
            const test_config_settings = { https_enabled: false }
            test_utils.preTestPrep(test_config_settings);

            await serverChild_rw();
            const test_max_body_size = serverChild_rw.__get__('REQ_MAX_BODY_SIZE');
            const hdb_server = serverChild_rw.__get__('hdbServer');

            expect(hdb_server.initialConfig.bodyLimit).to.equal(test_max_body_size);
            expect(hdb_server.initialConfig.connectionTimeout).to.equal(DEFAULT_CONFIG.SERVER_TIMEOUT_MS);
            expect(hdb_server.initialConfig.keepAliveTimeout).to.equal(DEFAULT_CONFIG.SERVER_KEEP_ALIVE_TIMEOUT);
        })

        it('should build HTTPS server instances with provided config settings', async() => {
            const test_config_settings = {
                https_on: true,
                server_timeout: 3333,
                keep_alive_timeout: 2222,
                headers_timeout: 1111
            }
            test_utils.preTestPrep(test_config_settings);

            await serverChild_rw();
            const hdb_server = serverChild_rw.__get__('hdbServer');

            expect(hdb_server.server.timeout).to.equal(test_config_settings.server_timeout);
            expect(hdb_server.server.keepAliveTimeout).to.equal(test_config_settings.keep_alive_timeout);
            expect(hdb_server.server.headersTimeout).to.equal(test_config_settings.headers_timeout);
        })

        it('should build HTTP server instances with provided config settings', async() => {
            const test_config_settings = {
                https_on: false,
                server_timeout: 3333,
                keep_alive_timeout: 2222,
                headers_timeout: 1111
            }
            test_utils.preTestPrep(test_config_settings);

            await serverChild_rw();
            const hdb_server = serverChild_rw.__get__('hdbServer');

            expect(hdb_server.server.timeout).to.equal(test_config_settings.server_timeout);
            expect(hdb_server.server.keepAliveTimeout).to.equal(test_config_settings.keep_alive_timeout);
            expect(hdb_server.server.headersTimeout).to.equal(test_config_settings.headers_timeout);
        })

        it('should not register fastify-cors if cors is not enabled',async() => {
            test_utils.preTestPrep();
            await serverChild_rw();
            const hdb_server = serverChild_rw.__get__('hdbServer');

            const plugin_key = Object.getOwnPropertySymbols(hdb_server).find((s => String(s) === "Symbol(fastify.pluginNameChain)"))

            expect(hdb_server[plugin_key].length).to.equal(3);
            expect(hdb_server[plugin_key]).to.deep.equal(['fastify-helmet', 'fastify-compress', 'fastify-static']);
        })

        it('should register fastify-cors if cors is enabled',async() => {
            const test_config_settings = {
                cors_enabled: true,
                cors_whitelist: 'harperdb.io, sam-johnson.io'
            }
            test_utils.preTestPrep(test_config_settings);
            await serverChild_rw();
            const hdb_server = serverChild_rw.__get__('hdbServer');

            const plugin_key = Object.getOwnPropertySymbols(hdb_server).find((s => String(s) === "Symbol(fastify.pluginNameChain)"))

            expect(hdb_server[plugin_key].length).to.equal(4);
            expect(hdb_server[plugin_key]).to.deep.equal(['fastify-cors', ...DEFAULT_FASTIFY_PLUGIN_ARR]);
        })

        it('should register fastify-cors if cors is enabled boolean has mixed cap spelling',async() => {
            const test_config_settings = {
                cors_enabled: 'TRue',
                cors_whitelist: 'harperdb.io, sam-johnson.io'
            }
            test_utils.preTestPrep(test_config_settings);
            await serverChild_rw();
            const hdb_server = serverChild_rw.__get__('hdbServer');

            const plugin_key = Object.getOwnPropertySymbols(hdb_server).find((s => String(s) === "Symbol(fastify.pluginNameChain)"))

            expect(hdb_server[plugin_key].length).to.equal(4);
            expect(hdb_server[plugin_key]).to.deep.equal(['fastify-cors', ...DEFAULT_FASTIFY_PLUGIN_ARR]);
        })



        it('should call handlePostRequest on HTTP post request',async() => {
            const test_config_settings = { https_on: false }
            test_utils.preTestPrep(test_config_settings);

            await serverChild_rw();
            const hdb_server = serverChild_rw.__get__('hdbServer');

            await hdb_server.inject({
                method: 'POST',
                url:'/',
                headers: test_req_options.headers,
                body: test_req_options.body
            })

            expect(handlePostRequest_spy.calledOnce).to.be.true;
        })

        it('should return docs html static file result w/ status 200 for valid HTTP get request',async() => {
            const test_config_settings = { https_on: false }
            test_utils.preTestPrep(test_config_settings);

            await serverChild_rw();
            const hdb_server = serverChild_rw.__get__('hdbServer');

            const test_response = await hdb_server.inject({
                method: 'get',
                url:'/'
            })

            expect(test_response.statusCode).to.equal(200);
            expect(test_response.body).to.equal(fs.readFileSync(path.join(__dirname, '../../docs/index.html'), 'utf8'));
        })

        it('should return docs html static file result w/ status 200 for valid HTTPS get request',async() => {
            const test_config_settings = { https_on: true }
            test_utils.preTestPrep(test_config_settings);

            await serverChild_rw();
            const hdb_server = serverChild_rw.__get__('hdbServer');

            const test_response = await hdb_server.inject({
                method: 'get',
                url:'/'
            })

            expect(test_response.statusCode).to.equal(200);
            expect(test_response.body).to.equal(fs.readFileSync(path.join(__dirname, '../../docs/index.html'), 'utf8'));
        })

        it('should return op result w/ status 200 for valid HTTP post request',async() => {
            const test_config_settings = { https_on: false }
            test_utils.preTestPrep(test_config_settings);

            await serverChild_rw()
            const hdb_server = serverChild_rw.__get__('hdbServer');

            const test_response = await hdb_server.inject({
                method: 'POST',
                url:'/',
                headers: test_req_options.headers,
                body: test_req_options.body
            })

            expect(test_response.statusCode).to.equal(200);
            expect(test_response.body).to.equal(JSON.stringify({message: test_op_resp}));
        })

        it('should call handlePostRequest on HTTPS post request',async() => {
            await serverChild_rw();
            const hdb_server = serverChild_rw.__get__('hdbServer');

            await hdb_server.inject({
                method: 'POST',
                url:'/',
                headers: test_req_options.headers,
                body: test_req_options.body
            })

            expect(handlePostRequest_spy.calledOnce).to.be.true;
        })

        it('should return op result w/ status 200 for valid HTTPS post request',async() => {
            await serverChild_rw();
            const hdb_server = serverChild_rw.__get__('hdbServer');

            const test_response = await hdb_server.inject({
                method: 'POST',
                url:'/',
                headers: test_req_options.headers,
                body: test_req_options.body
            })

            expect(test_response.statusCode).to.equal(200);
        })

        it('should return 400 error for post request w/o body',async() => {
            await serverChild_rw();
            const hdb_server = serverChild_rw.__get__('hdbServer');

            const test_response = await hdb_server.inject({
                method: 'POST',
                url:'/',
                headers: test_req_options.headers
            })

            expect(test_response.statusCode).to.equal(400);
            expect(test_response.json().error).to.equal("Body cannot be empty when content-type is set to 'application/json'");
        })

        it('should return 500 error for request from origin not included in CORS whitelist',async() => {
            const test_config_settings = {
                cors_enabled: true,
                cors_whitelist: 'https://harperdb.io'
            }

            test_utils.preTestPrep(test_config_settings);

            await serverChild_rw();
            const hdb_server = serverChild_rw.__get__('hdbServer');

            const test_headers = Object.assign({
                origin: 'https://google.com'
            }, test_req_options.headers);

            const test_response = await hdb_server.inject({
                method: 'POST',
                url:'/',
                headers: test_headers,
                body: test_req_options.body
            })

            expect(test_response.statusCode).to.equal(500);
            expect(test_response.json().error).to.equal("domain https://google.com is not whitelisted");
        })

        it('should return resp with 200 for request from origin included in CORS whitelist',async() => {
            const test_config_settings = {
                cors_enabled: true,
                cors_whitelist: 'https://harperdb.io'
            }

            test_utils.preTestPrep(test_config_settings);

            await serverChild_rw();
            const hdb_server = serverChild_rw.__get__('hdbServer');

            const test_headers = Object.assign({
                origin: 'https://harperdb.io'
            }, test_req_options.headers);

            const test_response = await hdb_server.inject({
                method: 'POST',
                url:'/',
                headers: test_headers,
                body: test_req_options.body
            })

            expect(test_response.statusCode).to.equal(200);
        })

        it('should catch and log an error and exit process if thrown from app.listen()', async() => {
            const process_stub = sandbox.stub(process, "exit").callsFake(fake);
            const test_err = "This is a test error.";
            signalChildStarted_stub.throws(new Error(test_err));

            test_utils.preTestPrep();
            await serverChild_rw();

            expect(logger_error_spy.calledTwice).to.be.true;
            expect(logger_error_spy.args[0][0]).to.equal("Error configuring HTTPS server");
            expect(logger_error_spy.args[1][0]).to.equal(`Failed to build server on ${process.pid}`);

            expect(logger_fatal_spy.calledOnce).to.be.true;
            expect(logger_fatal_spy.args[0][0].message).to.equal(test_err);

            expect(process_stub.calledOnce).to.be.true;
            expect(process_stub.args[0][0]).to.equal(1);

            process_stub.restore();
        })
    })

    describe('buildServer() method', () => {
        let buildServer_rw;
        let test_result;

        beforeEach(() => {
            buildServer_rw = serverChild_rw.__get__('buildServer');
        });

        afterEach(async() => {
            if (test_result.server) {
                await test_result.close();
            }
            test_result = undefined;
        })

        it('should return an http server', async() => {
            const test_is_https = false;
            test_result = await buildServer_rw(test_is_https);

            expect(test_result.server.constructor.name).to.equal('Server');
            expect(test_result.initialConfig.https).to.be.undefined;
        })

        it('should return an https server', async() => {
            const test_is_https = true;
            test_result = await buildServer_rw(test_is_https);

            expect(test_result.server.constructor.name).to.equal('Server');
            expect(test_result.initialConfig.https).to.be.true;
        })
    })

    describe('getServerOptions() method', () => {
        let getServerOptions_rw;

        beforeEach(() => {
            getServerOptions_rw = serverChild_rw.__get__('getServerOptions');
        })

        it('should return http server options based based on settings values',() => {
            const test_config_settings = {
                server_timeout: 3333,
                keep_alive_timeout: 2222,
                headers_timeout: 1111
            }
            test_utils.preTestPrep(test_config_settings);

            const test_is_https = false;
            const test_results = getServerOptions_rw(test_is_https);

            expect(test_results.bodyLimit).to.equal(REQ_MAX_BODY_SIZE);
            expect(test_results.keepAliveTimeout).to.equal(test_config_settings.keep_alive_timeout);
            expect(test_results.connectionTimeout).to.equal(test_config_settings.server_timeout);
            expect(test_results.https).to.be.undefined;
        })

        it('should return https server options based based on settings values',() => {
            const test_config_settings = {
                server_timeout: 3333,
                keep_alive_timeout: 2222
            }
            test_utils.preTestPrep(test_config_settings);

            const test_is_https = true;
            const test_results = getServerOptions_rw(test_is_https);

            expect(test_results.bodyLimit).to.equal(REQ_MAX_BODY_SIZE);
            expect(test_results.keepAliveTimeout).to.equal(test_config_settings.keep_alive_timeout);
            expect(test_results.connectionTimeout).to.equal(test_config_settings.server_timeout);
            expect(test_results.https).to.be.an.instanceOf(Object);
            expect(test_results.https.key).to.be.an.instanceOf(Buffer);
            expect(test_results.https.cert).to.be.an.instanceOf(Buffer);
        })
    })

    describe('getHeaderTimeoutConfig() method',() => {
        let getHeaderTimeoutConfig_rw;

        beforeEach(() => {
            getHeaderTimeoutConfig_rw = serverChild_rw.__get__('getHeaderTimeoutConfig');
        })

        it('should return the header timeout config value', () => {
            const test_config_settings = {
                headers_timeout: 1234
            }
            test_utils.preTestPrep(test_config_settings);

            const test_results = getHeaderTimeoutConfig_rw();
            expect(test_results).to.equal(test_config_settings.headers_timeout);
        })
    })

    describe('handleServerMessage() method',() => {
        let clean_lmdb_stub;
        let syncSchemaMetadata_stub;
        let setUsersToGlobal_stub;
        let job_runner_stub;
        let shutDown_stub;
        let handleServerMessage_rw;
        const test_msg = (msg) => ({ type: msg })

        before(() => {
            setUsersToGlobal_stub = sandbox.stub(user_schema, 'setUsersToGlobal').resolves();
        })

        beforeEach(() => {
            serverChild_rw = rewire('../../server/serverChild');
            clean_lmdb_stub = sandbox.stub().returns();
            serverChild_rw.__set__('clean_lmdb', clean_lmdb_stub);

            syncSchemaMetadata_stub = sandbox.stub().resolves();
            serverChild_rw.__set__('syncSchemaMetadata', syncSchemaMetadata_stub);

            job_runner_stub = sandbox.stub().resolves({});
            const job_runner_rw = serverChild_rw.__get__('job_runner');
            job_runner_rw.parseMessage = job_runner_stub;
            serverChild_rw.__set__('job_runner', job_runner_rw);

            shutDown_stub = sandbox.stub().resolves();
            serverChild_rw.__set__('shutDown', shutDown_stub);

            handleServerMessage_rw = serverChild_rw.__get__('handleServerMessage');
        })

        it('should call clean_lmdb and syncSchemaMetadata methods on `schema` msg', async() => {
            await handleServerMessage_rw(test_msg('schema'));

            expect(clean_lmdb_stub.calledOnce).to.be.true;
            expect(syncSchemaMetadata_stub.calledOnce).to.be.true;
        })

        it('should call user_schema.setUsersToGlobal method on `user` msg', async() => {
            await handleServerMessage_rw(test_msg('user'));

            expect(setUsersToGlobal_stub.calledOnce).to.be.true;
        })

        it('should call job_runner.parseMessage method on `job` msg', async() => {
            await handleServerMessage_rw(test_msg('job'));

            expect(job_runner_stub.calledOnce).to.be.true;
        })

        it('should call shutdown method', async() => {
            const process_stub = sandbox.stub(process, "exit").callsFake(fake);
            handleServerMessage_rw = serverChild_rw.__get__('handleServerMessage');

            await handleServerMessage_rw(test_msg('restart'));

            expect(shutDown_stub.calledOnce).to.be.true;
            expect(logger_info_stub.calledTwice).to.be.true;
            expect(logger_info_stub.args[0][0]).to.include('Server close event received for process ');
            expect(logger_info_stub.args[1][0]).to.equal(`Completed shut down`);
            expect(process_stub.calledOnce).to.be.true;
            expect(process_stub.args[0][0]).to.equal(24);
            serverChild_rw = rewire('../../server/serverChild');
            process_stub.restore();
        })
    })

    describe('shutDown() method',() => {
        let serverClose_stub;
        let hdbServer_stub;
        let callProcessSend_stub;
        let shutDown_rw;
        let timeout_stub;

        before(() => {
            serverChild_rw = rewire('../../server/serverChild');
            serverClose_stub = sandbox.stub().resolves();
            hdbServer_stub = {
                close: serverClose_stub
            }
            callProcessSend_stub = sandbox.stub(hdb_util, 'callProcessSend');
            timeout_stub = sandbox.stub().callsFake(fake);
            serverChild_rw.__set__('setTimeout', timeout_stub);
        })

        beforeEach(() => {
            serverChild_rw.__set__('hdbServer', hdbServer_stub);
            shutDown_rw = serverChild_rw.__get__('shutDown');
        })

        afterEach(() => {
            sandbox.resetHistory();
        })
        after(() => {
            sandbox.restore();
        })

        it('Should set hdbServer variable to null', async() => {
            await shutDown_rw();

            const test_server = serverChild_rw.__get__('hdbServer');
            expect(test_server).to.be.null;
        })

        it('Should call .close() on server isntance', async() => {
            await shutDown_rw();

            expect(serverClose_stub.calledOnce).to.be.true;
        })

        it('Should call .callProcessSend() after server is closed', async() => {
            await shutDown_rw();

            expect(callProcessSend_stub.calledOnce).to.be.true;
        })

        it('Should call .callProcessSend() even if no hdbServer is set on process', async() => {
            serverChild_rw.__set__('hdbServer', undefined);
            await shutDown_rw();

            expect(callProcessSend_stub.calledOnce).to.be.true;
        })

        it('Should not call .close() if there is no server instance set on process', async() => {
            serverChild_rw.__set__('hdbServer', undefined);
            await shutDown_rw();

            expect(serverClose_stub.called).to.be.false;
        })
    })
})
