'use strict';

const test_utils = require('../../test_utils');

const rewire = require('rewire');
const fs = require('fs-extra');
const path = require('path');
const DEFAULT_CONFIG = require('../../../utility/hdbTerms').HDB_SETTINGS_DEFAULT_VALUES;

const harper_logger = require('../../../utility/logging/harper_logger');
const signalling = require('../../../utility/signalling');
const user_schema = require('../../../security/user');
const global_schema = require('../../../utility/globalSchema');
const hdb_license = require('../../../utility/registration/hdb_license');
const env = require('../../../utility/environment/environmentManager');

const KEYS_PATH = path.join(test_utils.getMockTestPath(), 'utility/keys');
const PRIVATE_KEY_PATH = path.join(KEYS_PATH, 'privateKey.pem');
const CERTIFICATE_PATH = path.join(KEYS_PATH, 'certificate.pem');
const ROUTES_PATH = path.resolve(__dirname, '../../envDir/utility/routes') ;

const test_req_options = {
  headers: {
    'Content-Type': 'application/json', 'Authorization': 'Basic YWRtaW46QWJjMTIzNCE=',
  }, body: { 'operation': 'custom_functions_status' },
};

const DEFAULT_FASTIFY_PLUGIN_ARR = ['fastify-helmet'];

const chai = require('chai');
const { expect } = chai;
const sinon = require('sinon');
const sandbox = sinon.createSandbox();

let serverChild_rw;
let setup_stub;
let logger_info_stub;
let logger_error_spy;
let logger_fatal_spy;
let setUsersToGlobal_stub;
let setSchemaGlobal_stub;
const fake = () => {
};

const test_cert_val = test_utils.getHTTPSCredentials().cert;
const test_key_val = test_utils.getHTTPSCredentials().key;

describe('Test custom functions serverChild.js', () => {
  let signalChildStarted_stub;
  let serverClose_stub;
  let customFunctionsServer_stub;
  let ipc_client_stub;

  before(() => {
    env.initTestEnvironment();
    ipc_client_stub = sandbox.stub();
    logger_info_stub = sandbox.stub(harper_logger, 'info').callsFake(fake);
    logger_error_spy = sandbox.stub(harper_logger, 'error').callsFake(fake);
    logger_fatal_spy = sandbox.stub(harper_logger, 'fatal').callsFake(fake);
    signalChildStarted_stub = sandbox.stub(signalling, 'signalChildStarted').callsFake(fake);
    setup_stub = sandbox.stub().callsFake(fake);
    setUsersToGlobal_stub = sandbox.stub(user_schema, 'setUsersToGlobal').resolves();
    setSchemaGlobal_stub = sandbox.stub(global_schema, 'setSchemaDataToGlobal').callsArg(0);
    serverClose_stub = sandbox.stub().resolves();
    customFunctionsServer_stub = { close: serverClose_stub };
    serverChild_rw = rewire('../../../server/customFunctions/serverChild');
    serverChild_rw.__set__('IPCClient', ipc_client_stub);
    serverChild_rw.__set__('setUp', setup_stub);
    serverChild_rw.__set__('customFunctionsServer', customFunctionsServer_stub);
    test_utils.preTestPrep();
    fs.mkdirpSync(KEYS_PATH);
    fs.mkdirpSync(ROUTES_PATH);

    fs.writeFileSync(PRIVATE_KEY_PATH, test_key_val);
    fs.writeFileSync(CERTIFICATE_PATH, test_cert_val);
  });

  afterEach(async () => {
    test_utils.preTestPrep();
    const server = serverChild_rw.__get__('customFunctionsServer');
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
    });
  });

  after(() => {
    fs.removeSync(KEYS_PATH);
    sandbox.restore();
    rewire('../../../server/customFunctions/serverChild');
  });

  describe('exported serverChild method', () => {

    it('should build HTTPS server when HTTPS_ON set to true', async () => {
      const test_config_settings = { https_enabled: true };
      test_utils.preTestPrep(test_config_settings);

      await serverChild_rw();
      const hdb_server = serverChild_rw.__get__('customFunctionsServer');

      expect(hdb_server).to.not.be.undefined;
      expect(hdb_server.server.constructor.name).to.equal('Server');
      expect(hdb_server.server.key).to.be.instanceOf(Buffer);
      expect(hdb_server.server.cert).to.be.instanceOf(Buffer);
      expect(hdb_server.initialConfig.https).to.be.true;
    });

    it('should build HTTPS server instance with started and listening state equal to true', async () => {
      const test_config_settings = { https_enabled: true };
      test_utils.preTestPrep(test_config_settings);

      await serverChild_rw();
      const hdb_server = serverChild_rw.__get__('customFunctionsServer');

      const state_key = Object.getOwnPropertySymbols(hdb_server).find((
        s => String(s) === 'Symbol(fastify.state)'
      ));
      expect(hdb_server[state_key].started).to.be.true;
      expect(hdb_server[state_key].listening).to.be.true;
    });

    it('should register 1 fastify plugin by default - fastify-helmet', async () => {
      await serverChild_rw();
      const hdb_server = serverChild_rw.__get__('customFunctionsServer');
      const plugin_key = Object.getOwnPropertySymbols(hdb_server).find((
        s => String(s) === 'Symbol(fastify.pluginNameChain)'
      ));

      expect(hdb_server[plugin_key]).to.deep.equal(DEFAULT_FASTIFY_PLUGIN_ARR);
    });

    it('should build HTTPS server instance with default config settings', async () => {
      await serverChild_rw();
      const hdb_server = serverChild_rw.__get__('customFunctionsServer');

      expect(hdb_server.initialConfig.connectionTimeout).to.equal(DEFAULT_CONFIG.SERVER_TIMEOUT_MS);
      expect(hdb_server.initialConfig.keepAliveTimeout).to.equal(DEFAULT_CONFIG.SERVER_KEEP_ALIVE_TIMEOUT);
      hdb_server.close();
    });

    it('should build HTTPS server instances with provided config settings', async () => {
      const test_config_settings = {
        https_on: true, server_timeout: 3333, keep_alive_timeout: 2222, headers_timeout: 1111,
      };
      test_utils.preTestPrep(test_config_settings);

      await serverChild_rw();
      const hdb_server = serverChild_rw.__get__('customFunctionsServer');

      expect(hdb_server.server.timeout).to.equal(test_config_settings.server_timeout);
      expect(hdb_server.server.keepAliveTimeout).to.equal(test_config_settings.keep_alive_timeout);
      expect(hdb_server.server.headersTimeout).to.equal(test_config_settings.headers_timeout);
      hdb_server.close();
      test_utils.preTestPrep({ server_timeout: DEFAULT_CONFIG.SERVER_TIMEOUT_MS, keep_alive_timeout: DEFAULT_CONFIG.SERVER_KEEP_ALIVE_TIMEOUT});
    });

    it('should not register fastify-cors if cors is not enabled', async () => {
      test_utils.preTestPrep();
      await serverChild_rw();
      const hdb_server = serverChild_rw.__get__('customFunctionsServer');

      const plugin_key = Object.getOwnPropertySymbols(hdb_server).find((
        s => String(s) === 'Symbol(fastify.pluginNameChain)'
      ));

      expect(hdb_server[plugin_key].length).to.equal(1);
      expect(hdb_server[plugin_key]).to.deep.equal(['fastify-helmet']);
    });

    it('should register fastify-cors if cors is enabled', async () => {
      const test_config_settings = {
        cors_enabled: true, cors_whitelist: 'harperdb.io, sam-johnson.io',
      };
      test_utils.preTestPrep(test_config_settings);
      await serverChild_rw();
      const hdb_server = serverChild_rw.__get__('customFunctionsServer');

      const plugin_key = Object.getOwnPropertySymbols(hdb_server).find((
        s => String(s) === 'Symbol(fastify.pluginNameChain)'
      ));

      expect(hdb_server[plugin_key].length).to.equal(2);
      expect(hdb_server[plugin_key]).to.deep.equal(['fastify-cors', ...DEFAULT_FASTIFY_PLUGIN_ARR]);
    });

    it('should return 500 error for request from origin not included in CORS whitelist', async () => {
      const test_config_settings = {
        cors_enabled: true, cors_whitelist: 'https://harperdb.io',
      };

      test_utils.preTestPrep(test_config_settings);

      await serverChild_rw();
      const hdb_server = serverChild_rw.__get__('customFunctionsServer');

      const test_headers = Object.assign({
        origin: 'https://google.com',
      }, test_req_options.headers);

      const test_response = await hdb_server.inject({
        method: 'POST', url: '/', headers: test_headers, body: test_req_options.body,
      });

      expect(test_response.statusCode).to.equal(500);
      expect(test_response.json().error).to.equal('domain https://google.com is not whitelisted');
    });

    it('should return resp with 200 for request from origin included in CORS whitelist', async () => {
      const test_config_settings = {
        cors_enabled: true, cors_whitelist: 'https://harperdb.io',
      };

      test_utils.preTestPrep(test_config_settings);

      await serverChild_rw();
      const hdb_server = serverChild_rw.__get__('customFunctionsServer');

      const test_headers = Object.assign({
        origin: 'https://harperdb.io',
      }, test_req_options.headers);

      const test_response = await hdb_server.inject({
        method: 'POST', url: '/', headers: test_headers, body: test_req_options.body,
      });

      expect(test_response.statusCode).to.equal(404);
    });

    it('should catch and log an error and exit process if thrown from app.listen()', async () => {
      const process_stub = sandbox.stub(process, 'exit').callsFake(fake);
      const test_err = 'This is a test error.';
      signalChildStarted_stub.throws(new Error(test_err));

      test_utils.preTestPrep();
      await serverChild_rw();

      expect(logger_error_spy.calledThrice).to.be.true;
      expect(logger_error_spy.args[0][0]).to.equal('Custom Functions childServer.listen() error: Error: This is a test error.');
      expect(logger_error_spy.args[1][0]).to.equal(`Custom Functions ${process.pid} Error: Error: This is a test error.`);
      expect(process_stub.calledOnce).to.be.true;
      expect(process_stub.args[0][0]).to.equal(1);

      process_stub.restore();
    });
  });

  describe('buildServer() method', () => {
    let buildServer_rw;
    let test_result;

    beforeEach(() => {
      buildServer_rw = serverChild_rw.__get__('buildServer');
    });

    afterEach(async () => {
      if (test_result.server) {
        await test_result.close();
      }
      test_result = undefined;
    });

    it('should return an http server', async () => {
      const test_is_https = false;
      test_result = await buildServer_rw(test_is_https);

      expect(test_result.server.constructor.name).to.equal('Server');
      expect(test_result.initialConfig.https).to.be.undefined;
    });

    it('should return an https server', async () => {
      const test_is_https = true;
      test_result = await buildServer_rw(test_is_https);

      expect(test_result.server.constructor.name).to.equal('Server');
      expect(test_result.initialConfig.https).to.be.true;
    });
  });

  describe('setUp() method', () => {
    let spawn_cluster_conns_stub;
    let getLicense_stub;
    let setUp_rw;

    before(() => {
      spawn_cluster_conns_stub = sandbox.stub().callsFake(fake);
      getLicense_stub = sandbox.stub(hdb_license, 'getLicense').resolves();
      serverChild_rw = rewire('../../../server/customFunctions/serverChild');
      serverChild_rw.__set__('spawn_cluster_connection', spawn_cluster_conns_stub);
      setUp_rw = serverChild_rw.__get__('setUp');
    });

    afterEach(() => {
      sandbox.resetHistory();
    });

    it('NOMINAL - should call initial setup methods', async () => {
      await setUp_rw();

      expect(setSchemaGlobal_stub.calledOnce).to.be.true;
      expect(setUsersToGlobal_stub.calledOnce).to.be.true;
      expect(spawn_cluster_conns_stub.calledOnce).to.be.true;
    });
  });

  describe('Test shutDown function', () => {
    const timeout_stub = sandbox.stub();
    let timeout_rw;
    let shutDown;
    let signal_stopped_stub;
    let test_event = {
      "type": "restart",
      "message": {
        "force": false,
        "originator":1234
      }
    };

    before(() => {
      serverChild_rw.__set__('customFunctionsServer', customFunctionsServer_stub);
      timeout_rw = serverChild_rw.__set__('setTimeout', timeout_stub);
      shutDown = serverChild_rw.__get__('shutDown');
      signal_stopped_stub = sandbox.stub(signalling, 'signalChildStopped');
    });

    afterEach(() => {
      sandbox.resetHistory();
    });

    after(() => {
        timeout_rw();
    });

    it('Test child stop signal it sent and server close is called', async () => {
      const expected_obj = {
        "originator": process.pid,
        "service": "custom_functions"
      };
      await shutDown(test_event);
      expect(serverClose_stub.called).to.be.true;
      expect(signal_stopped_stub.args[0][0]).to.eql(expected_obj);
    });
    
    it('Test validation error is handled as expected', async () => {
        const bad_event = {
          "Type": "restart",
          "message": ""
        };
        await shutDown(bad_event);
        expect(serverClose_stub.called).to.be.false;
        expect(logger_error_spy.args[0][0]).to.equal("IPC event missing 'type'");
    });
  });
});
