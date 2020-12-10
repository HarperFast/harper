'use strict';

const test_utils = require('../test_utils');
test_utils.preTestPrep();

const rewire = require('rewire');
const fastify = require('fastify');
const fs = require('fs-extra');
const path = require('path');
const token_auth = rewire('../../security/tokenAuthentication');
const hdb_error = require('../../utility/errors/hdbError').handleHDBError;

const KEYS_PATH = path.join(test_utils.getMockFSPath(), 'utility/keys');
const PRIVATE_KEY_PATH = path.join(KEYS_PATH, 'privateKey.pem');
const CERTIFICATE_PATH = path.join(KEYS_PATH, 'certificate.pem');

fs.mkdirpSync(KEYS_PATH);
fs.writeFileSync(PRIVATE_KEY_PATH, '12345');
fs.writeFileSync(CERTIFICATE_PATH, '12345');

const chai = require('chai');
const { expect } = chai;
const sinon = require('sinon');
const sandbox = sinon.createSandbox();

const serverChild_rw = rewire('../../server/serverChild');

describe('Test serverChild.js', () => {

    after(() => {
        fs.removeSync(KEYS_PATH);
    })

    it('should do a thing', async() => {
        await serverChild_rw();
        const http_server = serverChild_rw.__get__('httpServer');
        expect(http_server).to.not.be.undefined
    })
})
