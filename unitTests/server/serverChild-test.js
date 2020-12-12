'use strict';

const test_utils = require('../test_utils');

const rewire = require('rewire');
const fastify = require('fastify');
const fs = require('fs-extra');
const path = require('path');
const token_auth = rewire('../../security/tokenAuthentication');
const hdb_error = require('../../utility/errors/hdbError').handleHDBError;

const KEYS_PATH = path.join(test_utils.getMockFSPath(), 'utility/keys');
const PRIVATE_KEY_PATH = path.join(KEYS_PATH, 'privateKey.pem');
const CERTIFICATE_PATH = path.join(KEYS_PATH, 'certificate.pem');

const chai = require('chai');
const { expect } = chai;
const sinon = require('sinon');
const sandbox = sinon.createSandbox();

let serverChild_rw;

describe('Test serverChild.js', () => {
    before(() => {
        test_utils.preTestPrep();
        fs.mkdirpSync(KEYS_PATH);
        fs.writeFileSync(PRIVATE_KEY_PATH, test_utils.getHTTPSOptsVals().key);
        fs.writeFileSync(CERTIFICATE_PATH, test_utils.getHTTPSOptsVals().cert);
    })

    beforeEach(() => {
        serverChild_rw = rewire('../../server/serverChild');
    })

    afterEach(async() => {
        const http = serverChild_rw.__get__('httpServer');
        if (http) await http.close();
        const https = serverChild_rw.__get__('secureServer');
        if (https) await https.close();
    })

    after(() => {
        fs.removeSync(KEYS_PATH);
        rewire('../../server/serverChild');
    })

    it('should do a thing', async() => {
        await serverChild_rw();
        const http_server = serverChild_rw.__get__('httpServer');
        expect(http_server).to.not.be.undefined;
    })
})
