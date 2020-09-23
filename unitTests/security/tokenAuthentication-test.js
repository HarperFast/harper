'use strict';

const test_util = require('../test_utils');
test_util.preTestPrep();
const fs = require('fs-extra');
const path = require('path');
const assert = require('assert');
const sinon = require('sinon');
const sandbox = sinon.createSandbox();
const rewire = require('rewire');
const token_auth = rewire('../../security/tokenAuthentication');
const JWTObjects = require('../../security/JWTObjects');
const get_jwt_keys_func = token_auth.__get__('getJWTRSAKeys');
const hdb_error = require('../../utility/errors/hdbError').handleHDBError;

const KEYS_PATH = path.join(test_util.getMockFSPath(), 'keys');
const PRIVATE_KEY_PATH = path.join(KEYS_PATH, '.jwtPrivate.key');
const PUBLIC_KEY_PATH = path.join(KEYS_PATH, '.jwtPublic.key');
const PRIVATE_KEY_VALUE = 'SHHH.PRIVATE.KEY';
const PUBLIC_KEY_VALUE = 'HEY.PUBLIC.KEY';


describe('test getJWTRSAKeys function', ()=>{
    //let get_hdb_base_path_stub;
    let path_join_spy;
    let fs_readfile_spy;

    before(()=>{
        fs_readfile_spy = sandbox.spy(fs, 'readFile');
        path_join_spy = sandbox.spy(path, 'join');
    });

    beforeEach(()=>{
        fs.mkdirpSync(KEYS_PATH);
        fs.writeFileSync(PRIVATE_KEY_PATH, PRIVATE_KEY_VALUE);
        fs.writeFileSync(PUBLIC_KEY_PATH, PUBLIC_KEY_VALUE);
    });

    afterEach(()=> {
        fs.removeSync(test_util.getMockFSPath());
        path_join_spy.resetHistory();
        fs_readfile_spy.resetHistory();
    });

    after(()=>{
        sandbox.restore();
    });

    it('test rsa_keys is undefined, happy path', async ()=>{
        let rw_rsa_keys = token_auth.__set__('rsa_keys', undefined);

        let results = await get_jwt_keys_func();
        assert.deepStrictEqual(results, new JWTObjects.JWTRSAKeys(PUBLIC_KEY_VALUE, PRIVATE_KEY_VALUE));

        assert(path_join_spy.callCount === 2);
        assert(fs_readfile_spy.callCount === 2);

        assert(fs_readfile_spy.threw() === false);
        assert(path_join_spy.threw() === false);

        let first_path_call = path_join_spy.getCall(0);
        assert(first_path_call.args = [test_util.getMockFSPath(), 'keys', '.jwtPrivate.key']);
        assert(first_path_call.returned(PRIVATE_KEY_PATH) === true);

        let second_path_call = path_join_spy.getCall(1);
        assert(second_path_call.args = [test_util.getMockFSPath(), 'keys', '.jwtPublic.key']);
        assert(second_path_call.returned(PUBLIC_KEY_PATH) === true);

        rw_rsa_keys();
    });

    it('test rsa_keys is undefined, private key file does not exist', async ()=>{
        let rw_rsa_keys = token_auth.__set__('rsa_keys', undefined);
        fs.unlinkSync(PRIVATE_KEY_PATH);

        let results = undefined;
        let error = undefined;
        try {
            results = await get_jwt_keys_func();
        }catch(e){
            error = e;
        }
        assert.deepStrictEqual(results, undefined);
        assert.deepStrictEqual(error.code, 'ENOENT');

        assert(path_join_spy.callCount === 2);
        assert(fs_readfile_spy.callCount === 1);

        rw_rsa_keys();
    });

    it('test rsa_keys is undefined, public key file does not exist', async ()=>{
        let rw_rsa_keys = token_auth.__set__('rsa_keys', undefined);
        fs.unlinkSync(PUBLIC_KEY_PATH);

        let results = undefined;
        let error = undefined;
        try {
            results = await get_jwt_keys_func();
        }catch(e){
            error = e;
        }
        assert.deepStrictEqual(results, undefined);
        assert.deepStrictEqual(error.code, 'ENOENT');

        assert(path_join_spy.callCount === 2);
        assert(fs_readfile_spy.callCount === 2);

        rw_rsa_keys();
    });

    it('test rsa_keys is defined', async ()=>{
        let rw_rsa_keys = token_auth.__set__('rsa_keys', new JWTObjects.JWTRSAKeys(PUBLIC_KEY_VALUE, PRIVATE_KEY_VALUE));

        let results = await get_jwt_keys_func();

        assert.deepStrictEqual(results, new JWTObjects.JWTRSAKeys(PUBLIC_KEY_VALUE, PRIVATE_KEY_VALUE));

        assert(path_join_spy.callCount === 0);
        assert(fs_readfile_spy.callCount === 0);

        rw_rsa_keys();
    });
});

describe('test createTokens', ()=>{

    it('test validation', async()=>{
        let error;
        let result;
        try {
            result = await token_auth.createTokens();
        }catch(e){
            error = e;
        }
        assert.deepStrictEqual(result, undefined);
        assert.deepStrictEqual(error, hdb_error(new Error(), 'invalid auth_object', 500));

        try {
            result = await token_auth.createTokens('bad');
        }catch(e){
            error = e;
        }
        assert.deepStrictEqual(result, undefined);
        assert.deepStrictEqual(error, hdb_error(new Error(), 'invalid auth_object', 500));

        try {
            result = await token_auth.createTokens({});
        }catch(e){
            error = e;
        }
        assert.deepStrictEqual(result, undefined);
        assert.deepStrictEqual(error, hdb_error(new Error(), 'username is required', 500));

        try {
            result = await token_auth.createTokens({username:'HDB_ADMIN'});
        }catch(e){
            error = e;
        }
        assert.deepStrictEqual(result, undefined);
        assert.deepStrictEqual(error, hdb_error(new Error(), 'password is required', 500));

        try {
            result = await token_auth.createTokens({username:'HDB_ADMIN', password: 1400});
        }catch(e){
            error = e;
        }
        assert.deepStrictEqual(result, undefined);
        assert.deepStrictEqual(error, hdb_error(new Error(), 'password is required', 500));
    });
});