'use strict';

const test_util = require('../../test_utils');
test_util.preTestPrep();
const fs = require('fs-extra');
const path = require('path');
const assert = require('assert');
const sinon = require('sinon');
const sandbox = sinon.createSandbox();
const rewire = require('rewire');
const token_auth = rewire('../../security/tokenAuthentication');

const KEYS_PATH = path.join(test_util.getMockFSPath(), 'keys');
const PRIVATE_KEY_PATH = path.join(KEYS_PATH, '.jwtPrivate.key');
const PUBLIC_KEY_PATH = path.join(KEYS_PATH, '.jwtPublic.key');
const PRIVATE_KEY_VALUE = 'SHHH.PRIVATE.KEY';
const PUBLIC_KEY_VALUE = 'HEY.PUBLIC.KEY';
const getJWTRSAKeys = token_auth;

describe('test getJWTRSAKeys function', ()=>{
    let get_hdb_base_path_stub;

    beforeEach(()=>{
        fs.mkdirpSync(KEYS_PATH);
        let env = token_auth.__get__('env');
        get_hdb_base_path_stub = sinon.stub(env, 'getHdbBasePath').returns(test_util.getMockFSPath());
    });

    afterEach(()=> {
        fs.removeSync(test_util.getMockFSPath());
        get_hdb_base_path_stub.restore();
    });
    it('test rsa_keys is undefined', ()=>{

    });
});