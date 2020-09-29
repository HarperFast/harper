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
const PRIVATE_KEY_VALUE = '-----BEGIN ENCRYPTED PRIVATE KEY-----\n' +
    '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\n' +
    '-----END ENCRYPTED PRIVATE KEY-----';
const PUBLIC_KEY_VALUE = '-----BEGIN PUBLIC KEY-----\n' +
    'MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAzET+m3dPmNEpOARAC3p+\n' +
    'iNILc9drGPaInEOHaOCd50Kt4muJbFip+MK4iB78wtKpO4q2c3rky4rxhYJl4dUr\n' +
    'Wa9Q80JVYQmkIyeiz7iPbeE0Y5hWnkDRrCs0k05ZQnFcHepASXiwSpu+aWHgsLrM\n' +
    'qA3Tj7UoVBAYwIB5JMH47+8kyBjnpFQRDnmqA9ZWpaXHgm7bcoOlorCn+zVJvfut\n' +
    'ZDsAEYF4lfCHCdTAWn83Nuv9VQaV8yhLH3RCHcMwIWVv0n1TVwkFS3KmkuUWilZD\n' +
    'celG4vfz/gc6XIFnZAVIStcpSmKSJbAP93t6noh2KWD/jQSzIrg+7jUITcYOCTsq\n' +
    'qpG2/2ixpS8kNlAiEgs0J+H2s+HexibWmA/JTrHfI3XBdW4B3XL66aGkVJH8RH8o\n' +
    'A3Kz4dtszhnHR/oVQ3reG3GmwBTrmqK8WYrJjzp/5qO8bJN6AGCSnIjiVZNkZ3s9\n' +
    '6Wm8mhR3hCyJu+eWO9exri1Z4y0mYLPfMsI+E5gNH7QZfvN5nK/RY1KabLUBrUur\n' +
    'eUIyGPtuOSjIPjQEimeApFrrnGYPv4EymrAjlk4rgT0hdSfH4Gl3iGN2+PeEwH7b\n' +
    'eZJM2rBg1YjEDwOd/huZVPyb0j/xIzoI+oDeSUJf9aLBcCJATjqT5bFVr0/A4dRm\n' +
    'c+fzWN6dcgYtVvVYk2jJ0h8CAwEAAQ==\n' +
    '-----END PUBLIC KEY-----';


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
    let rw_validate_user;
    beforeEach(()=>{
        rw_validate_user = token_auth.__set__('p_find_validate_user',
            (u, pw)=>({username: u}));
    });

    afterEach(()=>{
        rw_validate_user();
    });

    it('test validation', async()=>{
        let error;
        let result;
        //test null
        try {
            result = await token_auth.createTokens();
        }catch(e){
            error = e;
        }
        assert.deepStrictEqual(result, undefined);
        assert.deepStrictEqual(error, hdb_error(new Error(), 'invalid auth_object', 500));

        //test not object arg
        try {
            result = await token_auth.createTokens('bad');
        }catch(e){
            error = e;
        }
        assert.deepStrictEqual(result, undefined);
        assert.deepStrictEqual(error, hdb_error(new Error(), 'invalid auth_object', 500));

        //test no username
        try {
            result = await token_auth.createTokens({});
        }catch(e){
            error = e;
        }
        assert.deepStrictEqual(result, undefined);
        assert.deepStrictEqual(error, hdb_error(new Error(), 'username is required', 500));

        //test no password
        try {
            result = await token_auth.createTokens({username:'HDB_ADMIN'});
        }catch(e){
            error = e;
        }
        assert.deepStrictEqual(result, undefined);
        assert.deepStrictEqual(error, hdb_error(new Error(), 'password is required', 500));

        //test bad credentials
        rw_validate_user();
        rw_validate_user = token_auth.__set__('p_find_validate_user',
            (u, pw)=>{throw new Error("bad credentials");});
        try {
            result = await token_auth.createTokens({username:'BAD_USER', password: 'blerrrrg'});
        }catch(e){
            error = e;
        }
        assert.deepStrictEqual(result, undefined);
        assert.deepStrictEqual(error, hdb_error(new Error(), 'invalid credentials', 401));

        //test good credentials, no RSA keys
        rw_validate_user();
        rw_validate_user = token_auth.__set__('p_find_validate_user',
            (u, pw)=>({username:u}));
        try {
            result = await token_auth.createTokens({username:'HDB_USER', password: 'pass'});
        }catch(e){
            error = e;
        }
        assert.deepStrictEqual(result, undefined);
        assert.deepStrictEqual(error, hdb_error(new Error(), 'unable to generate JWT as there are no encryption keys.  please contact your administrator', 500));
    });

    it('test happy path', async()=>{
        let rw_get_tokens = token_auth.__set__('getJWTRSAKeys', async ()=>new JWTObjects.JWTRSAKeys(PUBLIC_KEY_VALUE, PRIVATE_KEY_VALUE));
        let result = await token_auth.createTokens({username:'HDB_USER', password: 'pass'});

        assert.deepStrictEqual(result, undefined);

        rw_get_tokens();
    });
});