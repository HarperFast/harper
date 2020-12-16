'use strict';

const test_utils = require('../test_utils');

const rewire = require('rewire');
const env = require('../../utility/environment/environmentManager');
const fastify = require('fastify');
const fs = require('fs-extra');
const path = require('path');
const token_auth = rewire('../../security/tokenAuthentication');
const hdb_error = require('../../utility/errors/hdbError').handleHDBError;
const DEFAULT_CONFIG = require('../../utility/hdbTerms').HDB_SETTINGS_DEFAULT_VALUES;

const auth = require('../../security/auth');
const server_utilities = require('../../server/serverUtilities');
const OperationFunctionCaller = require('../../utility/OperationFunctionCaller');

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

let handlePostRequest_spy;
let callOperation_stub;
let auth_stub;
let chooseOp_stub;
let serverChild_rw;

const test_op_resp = "table 'dev.dogz' successfully created.";
const test_cert_val = test_utils.getHTTPSOptsVals().cert;
const test_key_val = test_utils.getHTTPSOptsVals().key;

function setupServerTest() {
    serverChild_rw = rewire('../../server/serverChild');
    const handlePostRequest_rw = serverChild_rw.__get__('handlePostRequest');
    handlePostRequest_spy = sandbox.spy(handlePostRequest_rw);
    serverChild_rw.__set__('handlePostRequest', handlePostRequest_spy);
}

describe('Test serverChild.js', () => {
    before(() => {
        test_utils.preTestPrep();
        fs.mkdirpSync(KEYS_PATH);

        fs.writeFileSync(PRIVATE_KEY_PATH, test_key_val);
        fs.writeFileSync(CERTIFICATE_PATH, test_cert_val);
        callOperation_stub = sandbox.stub(OperationFunctionCaller, 'callOperationFunctionAsAwait').resolves(test_op_resp);
        auth_stub = sandbox.stub(auth, 'authorize').callsFake((req, res, next) => next(null, {}));
        chooseOp_stub = sandbox.stub(server_utilities, 'chooseOperation').callsFake(({}, callback) => callback(null, {}));
    })

    beforeEach(() => {
        setupServerTest();

    })

    afterEach(async() => {
        test_utils.preTestPrep();
        const http = serverChild_rw.__get__('httpServer');
        if (http) await http.close();
        const https = serverChild_rw.__get__('secureServer');
        if (https) await https.close();
        sandbox.resetHistory();
    })

    after(() => {
        fs.removeSync(KEYS_PATH);
        sandbox.restore();
        rewire('../../server/serverChild');
    })

    describe('exported serverChild method', () => {
        it('should build http and https server instances when env variables set to true', async() => {
            await serverChild_rw();
            const http_server = serverChild_rw.__get__('httpServer');
            const secure_server = serverChild_rw.__get__('secureServer');

            expect(http_server).to.not.be.undefined;
            expect(http_server.server.constructor.name).to.equal('Server');
            expect(http_server.initialConfig.https).to.be.undefined;
            expect(secure_server).to.not.be.undefined;
            expect(secure_server.server.constructor.name).to.equal('Server');
            expect(secure_server.server.key).to.be.instanceOf(Buffer);
            expect(secure_server.server.cert).to.be.instanceOf(Buffer);
            expect(secure_server.initialConfig.https).to.be.true;
        })

        it('should build http and https server instances with started and listening state equal to true', async() => {
            await serverChild_rw();
            const http_server = serverChild_rw.__get__('httpServer');
            const secure_server = serverChild_rw.__get__('secureServer');

            const state_key = Object.getOwnPropertySymbols(http_server).find((s => String(s) === "Symbol(fastify.state)"))
            expect(http_server[state_key].started).to.be.true;
            expect(http_server[state_key].listening).to.be.true;
            expect(secure_server[state_key].started).to.be.true;
            expect(secure_server[state_key].listening).to.be.true;
        })

        it('should register 3 fastify plugins by default - fastify-helmet, fastify-compress, fastify-static', async() => {
            await serverChild_rw();
            const http_server = serverChild_rw.__get__('httpServer');
            const secure_server = serverChild_rw.__get__('secureServer');
            const plugin_key = Object.getOwnPropertySymbols(secure_server).find((s => String(s) === "Symbol(fastify.pluginNameChain)"))

            expect(http_server[plugin_key]).to.deep.equal(DEFAULT_FASTIFY_PLUGIN_ARR);
            expect(secure_server[plugin_key]).to.deep.equal(DEFAULT_FASTIFY_PLUGIN_ARR);
        })

        it('should build http and https server instances with default config settings', async() => {
            await serverChild_rw();
            const test_max_body_size = serverChild_rw.__get__('REQ_MAX_BODY_SIZE');
            const http_server = serverChild_rw.__get__('httpServer');
            const secure_server = serverChild_rw.__get__('secureServer');

            expect(http_server.initialConfig.bodyLimit).to.equal(test_max_body_size);
            expect(http_server.initialConfig.connectionTimeout).to.equal(DEFAULT_CONFIG.SERVER_TIMEOUT_MS);
            expect(http_server.initialConfig.keepAliveTimeout).to.equal(DEFAULT_CONFIG.SERVER_KEEP_ALIVE_TIMEOUT);

            expect(secure_server.initialConfig.bodyLimit).to.equal(test_max_body_size);
            expect(secure_server.initialConfig.connectionTimeout).to.equal(DEFAULT_CONFIG.SERVER_TIMEOUT_MS);
            expect(secure_server.initialConfig.keepAliveTimeout).to.equal(DEFAULT_CONFIG.SERVER_KEEP_ALIVE_TIMEOUT);
        })

        it('should build http and https server instances with provided config settings', async() => {
            const test_config_settings = {
                server_timeout: 3333,
                keep_alive_timeout: 2222,
                headers_timeout: 1111
            }

            test_utils.preTestPrep(test_config_settings);
            serverChild_rw = rewire('../../server/serverChild');

            await serverChild_rw();
            const http_server = serverChild_rw.__get__('httpServer');
            const secure_server = serverChild_rw.__get__('secureServer');

            expect(http_server.server.timeout).to.equal(test_config_settings.server_timeout);
            expect(http_server.server.keepAliveTimeout).to.equal(test_config_settings.keep_alive_timeout);
            expect(http_server.server.headersTimeout).to.equal(test_config_settings.headers_timeout);

            expect(secure_server.server.timeout).to.equal(test_config_settings.server_timeout);
            expect(secure_server.server.keepAliveTimeout).to.equal(test_config_settings.keep_alive_timeout);
            expect(secure_server.server.headersTimeout).to.equal(test_config_settings.headers_timeout);
        })

        it('should build only https server instance with provided config settings', async() => {
            const test_config_settings = {
                http_enabled: false,
                https_enabled: true,
                server_timeout: 3333,
                keep_alive_timeout: 2222,
                headers_timeout: 1111
            }

            test_utils.preTestPrep(test_config_settings);
            serverChild_rw = rewire('../../server/serverChild');

            await serverChild_rw();
            const http_server = serverChild_rw.__get__('httpServer');
            const secure_server = serverChild_rw.__get__('secureServer');

            expect(http_server).to.be.undefined;

            expect(secure_server.server.timeout).to.equal(test_config_settings.server_timeout);
            expect(secure_server.server.keepAliveTimeout).to.equal(test_config_settings.keep_alive_timeout);
            expect(secure_server.server.headersTimeout).to.equal(test_config_settings.headers_timeout);
        })

        it('should build only http server instance with provided config settings', async() => {
            const test_config_settings = {
                http_enabled: true,
                https_enabled: false,
                server_timeout: 3333,
                keep_alive_timeout: 2222,
                headers_timeout: 1111
            }

            test_utils.preTestPrep(test_config_settings);
            serverChild_rw = rewire('../../server/serverChild');

            await serverChild_rw();
            const http_server = serverChild_rw.__get__('httpServer');
            const secure_server = serverChild_rw.__get__('secureServer');

            expect(secure_server).to.be.undefined;

            expect(http_server.server.timeout).to.equal(test_config_settings.server_timeout);
            expect(http_server.server.keepAliveTimeout).to.equal(test_config_settings.keep_alive_timeout);
            expect(http_server.server.headersTimeout).to.equal(test_config_settings.headers_timeout);
        })

        it('should call handlePostRequest on HTTP post request',async() => {
            test_utils.preTestPrep();
            await serverChild_rw();
            const http_server = serverChild_rw.__get__('httpServer');

            await http_server.inject({
                method: 'POST',
                url:'/',
                headers: test_req_options.headers,
                body: test_req_options.body
            })

            expect(handlePostRequest_spy.calledOnce).to.be.true;
        })

        it('should return docs html static file result w/ status 200 for valid HTTP get request',async() => {
            await serverChild_rw();
            const http_server = serverChild_rw.__get__('httpServer');

            const test_response = await http_server.inject({
                method: 'get',
                url:'/'
            })

            expect(test_response.statusCode).to.equal(200);
            expect(test_response.body).to.equal(fs.readFileSync(path.join(__dirname, '../../docs/index.html'), 'utf8'));
        })

        it('should return docs html static file result w/ status 200 for valid HTTPS get request',async() => {
            await serverChild_rw();
            const https_server = serverChild_rw.__get__('secureServer');

            const test_response = await https_server.inject({
                method: 'get',
                url:'/'
            })

            expect(test_response.statusCode).to.equal(200);
            expect(test_response.body).to.equal(fs.readFileSync(path.join(__dirname, '../../docs/index.html'), 'utf8'));
        })

        it('should return op result w/ status 200 for valid HTTP post request',async() => {
            await serverChild_rw();
            const http_server = serverChild_rw.__get__('httpServer');

            const test_response = await http_server.inject({
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
            const secure_server = serverChild_rw.__get__('secureServer');

            await secure_server.inject({
                method: 'POST',
                url:'/',
                headers: test_req_options.headers,
                body: test_req_options.body
            })

            expect(handlePostRequest_spy.calledOnce).to.be.true;
        })

        it('should return op result w/ status 200 for valid HTTPS post request',async() => {
            await serverChild_rw();
            const secure_server = serverChild_rw.__get__('secureServer');

            const test_response = await secure_server.inject({
                method: 'POST',
                url:'/',
                headers: test_req_options.headers,
                body: test_req_options.body
            })

            expect(test_response.statusCode).to.equal(200);
        })

        it('should not register fastify-cors if cors is not enabled',async() => {
            test_utils.preTestPrep();
            await serverChild_rw();
            const secure_server = serverChild_rw.__get__('secureServer');

            const plugin_key = Object.getOwnPropertySymbols(secure_server).find((s => String(s) === "Symbol(fastify.pluginNameChain)"))

            expect(secure_server[plugin_key].length).to.equal(3);
            expect(secure_server[plugin_key]).to.deep.equal(['fastify-helmet', 'fastify-compress', 'fastify-static']);
        })

        it('should register fastify-cors if cors is enabled',async() => {
            const test_config_settings = {
                cors_enabled: true,
                cors_whitelist: 'harperdb.io, sam-johnson.io'
            }

            test_utils.preTestPrep(test_config_settings);
            await serverChild_rw();
            const secure_server = serverChild_rw.__get__('secureServer');

            const plugin_key = Object.getOwnPropertySymbols(secure_server).find((s => String(s) === "Symbol(fastify.pluginNameChain)"))

            expect(secure_server[plugin_key].length).to.equal(4);
            expect(secure_server[plugin_key]).to.deep.equal(['fastify-cors', ...DEFAULT_FASTIFY_PLUGIN_ARR]);
        })
    })

    describe('buildServer() method', () => {
        let buildServer_rw;
        let test_result;

        beforeEach(() => {
            buildServer_rw = serverChild_rw.__get__('buildServer');
        });

        afterEach(async() => {
            await test_result.close();
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
})
