"use strict";
const test_utils = require('../test_utils');
test_utils.preTestPrep();
const assert = require('assert');
const sinon = require('sinon');
const rewire = require('rewire');
const user = rewire('../../security/user');

const insert = require('../../data_layer/insert'),
    delete_ = require('../../data_layer/delete'),
    validation = require('../../validation/user_validation'),
    search = require('../../data_layer/search'),
    signalling = require('../../utility/signalling');

const TEST_ADD_USER_JSON = {
    "operation": "add_user",
    "role": "057540eb-3e93-4fab-8397-a4545f850b18",
    "username": "test_user",
    "password": "test1234!",
    "active": "true"
};

const TEST_ALTER_USER_JSON = {
    "operation": "alter_user",
    "role": "057540eb-3e93-4fab-8397-a4545f850b18",
    "username": "test_user",
    "password": "test1234!",
};

const TEST_ALTER_USER_NO_USERNAME_JSON = {
    "operation": "alter_user",
    "role": "057540eb-3e93-4fab-8397-a4545f850b18",
    "password": "test1234!",
};

const TEST_ALTER_USER_NOTHING_TO_UPDATE_JSON = {
    "operation": "alter_user",
    "username": "test_user"
};

const TEST_ALTER_USER_NOTHING_TO_UPDATE_JSON2 = {
    "operation": "alter_user",
    "username": "test_user",
    "role":"",
    "password":""
};

const TEST_ALTER_USER_EMPTY_ROLE_JSON = {
    "operation": "alter_user",
    "username": "test_user",
    "active":true,
    "role":""
};

const TEST_ALTER_USER_EMPTY_PASSWORD_JSON = {
    "operation": "alter_user",
    "username": "test_user",
    "active":true,
    "password":""
};

const TEST_ALTER_USER_ACTIVE_NOT_BOOLEAN_JSON = {
    "operation": "alter_user",
    "username": "test_user",
    "active":"stuff"
};

const TEST_DROP_USER_JSON = {
    "operation":"drop_user",
    "username":"test_user"
};

const TEST_ADD_USER_SEARCH_OBJ = {
    "schema": "system",
    "table": "hdb_role",
    "hash_values": [
        "057540eb-3e93-4fab-8397-a4545f850b18"
    ],
    "hash_attribute": "id",
    "get_attributes": [
        "id"
    ]
};

const TEST_USER_INFO_JSON = {
    "operation": "user_info",
    "hdb_user": {
        "active": true,
        "role": {
            "id": "dc52dc65-efc7-4cc4-b3ed-04a98602c0b2",
            "permission": {
                "super_user": true
            },
            "role": "super_user"
        },
        "username": "blah"
    }
};

const TEST_USER_INFO_SEARCH_RESPONSE = [
    {
        "permission": {
            "super_user": true
        },
        "role": "super_user",
        "id": "dc52dc65-efc7-4cc4-b3ed-04a98602c0b2"
    }
];

const TEST_USER_INFO_RESPONSE = {
    "active": true,
    "username": "blah"
}

const TEST_LIST_USER_JSON = {
    "operation": "list_users",
};

const TEST_LIST_USER_ROLE_SEARCH_RESPONSE = {
    "id": "9c9aae33-4d1d-40b5-a52e-bbbc1b2e2ba6",
    "permission": {
        "super_user": false,
    },
    "role": "some_role"
};

const TEST_LIST_USER_SEARCH_RESPONSE = {
    "active": true,
    "password": "tester",
    "role": "9c9aae33-4d1d-40b5-a52e-bbbc1b2e2ba6",
    "username": "bad_user"
};

const TEST_UPDATE_RESPONSE = {
    message: `updated 1 of 1 records`,
    update_hashes: '[test_user]',
    skipped_hashes: ''
}

const TEST_USER_INFO_SEARCH_FAIL_RESPONSE = "Role Not Found";

const ADD_USER_RESULT = 'test_user successfully added';
const BAD_ROLE_SEARCH_RESULT = 'Role not found.';
const ADD_USER_INSERT_FAILED_RESULT = 'Insert Failed.';
const FAILED_VALIDATE_MESSAGE = "Failed Validation";
const DROP_USER_RESULT = 'test_user successfully deleted';
const USER_SEARCH_FAILED_RESULT = 'User not found';

// Naive clone, never ever do this in prod code.
function clone(a) {
    return JSON.parse(JSON.stringify(a));
}

describe('Test addUser', function () {
    let search_stub = undefined;
    let insert_stub = undefined;
    let validate_stub = undefined;
    let signal_spy = undefined;
    let search_orig = user.__get__('p_search_search_by_hash');
    beforeEach( function() {
        // We are not testing these other functions, so we stub them.
        //search_stub = sinon.stub(search, "searchByHash").yields("", TEST_ADD_USER_SEARCH_OBJ);
        search_stub = sinon.stub().resolves(TEST_ADD_USER_SEARCH_OBJ);
        user.__set__('p_search_search_by_hash', search_stub);
        insert_stub = sinon.stub(insert, "insert").resolves(true);
        validate_stub = sinon.stub(validation, "addUserValidation").callsFake(function() {
            return null;
        });
        signal_spy = sinon.spy(signalling, "signalUserChange");
    });
    afterEach( function() {
        insert_stub.restore();
        validate_stub.restore();
        signal_spy.restore();
        user.__set__('p_search_search_by_hash', search_orig);
    });

    it('Nominal path, add a user', function (done) {
        user.addUser(TEST_ADD_USER_JSON, function(err, results) {
            assert.equal(results, ADD_USER_RESULT, 'Expected success result not returned.');
            assert.equal(signal_spy.called, true);
            done();
        });
    });
    it('Test bad role', function (done) {
        // inject a failed role search
        search_stub.resolves(null);
        user.addUser(TEST_ADD_USER_JSON, function(err, results) {
            assert.equal(err.message, BAD_ROLE_SEARCH_RESULT, 'Expected success result not returned.');
            assert.equal(signal_spy.called, false);
            done();
        });
    });
    it('Test failed insert', function (done) {
        // inject a failed insert
        insert_stub.throws(new Error(ADD_USER_INSERT_FAILED_RESULT));
        user.addUser(TEST_ADD_USER_JSON, function(err, results) {
            assert.equal(err.message, ADD_USER_INSERT_FAILED_RESULT, 'Expected success result not returned.');
            assert.equal(signal_spy.called, false);
            done();
        });
    });
    it('Test failed validation', function (done) {
        // inject a failed insert
        validate_stub.callsFake(function() {
            return FAILED_VALIDATE_MESSAGE;
        });
        user.addUser(TEST_ADD_USER_JSON, function(err, results) {
            assert.equal(err.message, FAILED_VALIDATE_MESSAGE, 'Expected success result not returned.');
            assert.equal(signal_spy.called, false);
            done();
        });
    });
});

describe('Test alterUser', function () {
    let insert_stub = undefined;
    let role_search_stub = undefined;
    let validate_stub = undefined;
    let signal_spy = undefined;
    let search_orig = user.__get__('p_search_search_by_hash');
    beforeEach( function() {

        // We are not testing these other functions, so we stub them.
        insert_stub = sinon.stub(insert, "update").resolves(TEST_UPDATE_RESPONSE);
        validate_stub = sinon.stub(validation, "alterUserValidation").callsFake(function() {
            return null;
        });
        signal_spy = sinon.spy(signalling, "signalUserChange");
        role_search_stub = sinon.stub().resolves([TEST_LIST_USER_ROLE_SEARCH_RESPONSE]);
        user.__set__('p_search_search_by_hash', role_search_stub);
    });
    afterEach( function() {
        insert_stub.restore();
        validate_stub.restore();
        signal_spy.restore();
    });
    it('Nominal path, alter a user', function (done) {
        // We are not testing these other functions, so we stub them.
        user.alterUser(TEST_ALTER_USER_JSON, function(err, results) {
            assert.equal(results, TEST_UPDATE_RESPONSE, 'Expected success result not returned.');
            assert.equal(signal_spy.called, true);
            done();
        });
    });
    it('Test failed validation no username', function (done) {
        // inject a failed insert
        validate_stub.callsFake(function() {
            return FAILED_VALIDATE_MESSAGE;
        });
        user.alterUser(TEST_ALTER_USER_NO_USERNAME_JSON, function(err, results) {
            assert.equal(err.message, user.USERNAME_REQUIRED, 'Expected success result not returned.');
            assert.equal(signal_spy.called, false);
            done();
        });
    });
    it('Test failed validation nothing to update', function (done) {
        // inject a failed insert
        validate_stub.callsFake(function() {
            return FAILED_VALIDATE_MESSAGE;
        });
        user.alterUser(TEST_ALTER_USER_NOTHING_TO_UPDATE_JSON, function(err, results) {
            assert.equal(err.message, user.ALTERUSER_NOTHING_TO_UPDATE, 'Expected success result not returned.');
            assert.equal(signal_spy.called, false);
            done();
        });
    });
    it('Test failed validation nothing to update 2', function (done) {
        // inject a failed insert
        validate_stub.callsFake(function() {
            return FAILED_VALIDATE_MESSAGE;
        });
        user.alterUser(TEST_ALTER_USER_NOTHING_TO_UPDATE_JSON2, function(err, results) {
            assert.equal(err.message, user.ALTERUSER_NOTHING_TO_UPDATE, 'Expected success result not returned.');
            assert.equal(signal_spy.called, false);
            done();
        });
    });
    it('Test failed validation empty role', function (done) {
        // inject a failed insert
        validate_stub.callsFake(function() {
            return FAILED_VALIDATE_MESSAGE;
        });
        user.alterUser(TEST_ALTER_USER_EMPTY_ROLE_JSON, function(err, results) {
            assert.equal(err.message, user.EMPTY_ROLE, 'Expected success result not returned.');
            assert.equal(signal_spy.called, false);
            done();
        });
    });
    it('Test failed validation empty password', function (done) {
        // inject a failed insert
        validate_stub.callsFake(function() {
            return FAILED_VALIDATE_MESSAGE;
        });
        user.alterUser(TEST_ALTER_USER_EMPTY_PASSWORD_JSON, function(err, results) {
            assert.equal(err.message, user.EMPTY_PASSWORD, 'Expected success result not returned.');
            assert.equal(signal_spy.called, false);
            done();
        });
    });
    it('Test failed validation active not boolean', function (done) {
        // inject a failed insert
        validate_stub.callsFake(function() {
            return FAILED_VALIDATE_MESSAGE;
        });
        user.alterUser(TEST_ALTER_USER_ACTIVE_NOT_BOOLEAN_JSON, function(err, results) {
            assert.equal(err.message, user.ACTIVE_BOOLEAN, 'Expected success result not returned.');
            assert.equal(signal_spy.called, false);
            done();
        });
    });
    it('Test no role found', function (done) {
        role_search_stub = sinon.stub().resolves([]);
        user.__set__('p_search_search_by_hash', role_search_stub);
        user.alterUser(TEST_ALTER_USER_JSON, function(err, results) {
            assert.equal(err.message, `Update failed.  Requested role id ${TEST_ALTER_USER_NO_USERNAME_JSON.role} not found.`, 'Expected success result not returned.');
            assert.equal(signal_spy.called, false);
            done();
        });
    });
    it('Test exception during role search', function (done) {
        role_search_stub = sinon.stub().throws(new Error('Role Search Error'));
        user.__set__('p_search_search_by_hash', role_search_stub);
        user.alterUser(TEST_ALTER_USER_JSON, function(err, results) {
            assert.equal(err.message, 'Role Search Error', 'Expected success result not returned.');
            assert.equal(signal_spy.called, false);
            done();
        });
    });
});

describe('Test dropUser', function () {
    let delete_stub = undefined;
    let validate_stub = undefined;
    let signal_spy = undefined;
    let delete_orig = user.__get__('p_delete_delete');
    beforeEach( function() {
        // We are not testing these other functions, so we stub them.
        delete_stub = sinon.stub().resolves(true);
        user.__set__('p_delete_delete', delete_stub);
        validate_stub = sinon.stub(validation, "dropUserValidation").callsFake(function() {
            return null;
        });
        signal_spy = sinon.spy(signalling, "signalUserChange");
    });
    afterEach( function() {
        validate_stub.restore();
        signal_spy.restore();
        user.__set__('p_delete_delete', delete_orig);
    });
    it('Nominal path, drop a user', function (done) {
        // We are not testing these other functions, so we stub them.
        user.dropUser(TEST_DROP_USER_JSON, function(err, results) {
            assert.equal(results, DROP_USER_RESULT, 'Expected success result not returned.');
            assert.equal(signal_spy.called, true);
            done();
        });
    });
    it('Test failed validation', function (done) {
        // inject a failed insert
        validate_stub.callsFake(function() {
            return FAILED_VALIDATE_MESSAGE;
        });
        user.dropUser(TEST_ALTER_USER_JSON, function(err, results) {
            assert.equal(err.message, FAILED_VALIDATE_MESSAGE, 'Expected success result not returned.');
            assert.equal(signal_spy.called, false);
            done();
        });
    });
});

describe('Test user_info', function () {
    let search_stub = undefined;
    let search_orig = user.__get__('p_search_search_by_hash');
    beforeEach( function() {
        // We are not testing these other functions, so we stub them.
        search_stub = sinon.stub().resolves(TEST_USER_INFO_SEARCH_RESPONSE);
        user.__set__('p_search_search_by_hash', search_stub);
    });
    afterEach( function() {
        user.__set__('p_search_search_by_hash', search_orig);
    });
    it('Nominal path, get user info', function (done) {
        // We are not testing these other functions, so we stub them.
        user.userInfo(TEST_USER_INFO_JSON, function(err, results) {
            assert.ok(results.role !== undefined);
            assert.equal(results.role.role, TEST_USER_INFO_SEARCH_RESPONSE[0].role);
            assert.equal(results.role.id, TEST_USER_INFO_SEARCH_RESPONSE[0].id);
            assert.equal(results.role.permission.super_user, TEST_USER_INFO_SEARCH_RESPONSE[0].permission.super_user);
            assert.ok(results.username === 'blah');
            assert.ok(results.password === undefined);
            done();
        });
    });
    it('bad search result in user info', function (done) {
        // We are not testing these other functions, so we stub them.
        search_stub.throws(new Error(TEST_USER_INFO_SEARCH_FAIL_RESPONSE));
        user.userInfo(TEST_USER_INFO_JSON, function(err, results) {
            assert.equal(err.message, TEST_USER_INFO_SEARCH_FAIL_RESPONSE, 'Expected success result not returned.');
            done();
        });
    });
});

describe('Test list_users', function () {
    let search_stub = undefined;
    let search_orig = user.__get__('p_search_search_by_value');
    beforeEach( function() {
        // reset search_stub just in case.
        search_stub = undefined;
        // We are not testing these other functions, so we stub them.
        // Need to clone these since the list_users function attaches the role into the user.
        let role_search_response_clone = clone(TEST_LIST_USER_ROLE_SEARCH_RESPONSE);
        let user_search_response_clone = clone(TEST_LIST_USER_SEARCH_RESPONSE);

        search_stub = sinon.stub().onFirstCall().resolves([role_search_response_clone]);
        search_stub.onSecondCall().resolves([user_search_response_clone]);
        user.__set__('p_search_search_by_value', search_stub);
    });
    afterEach( function() {
        user.__set__('p_search_search_by_value', search_orig);
    });
    it('Nominal path, list users', function (done) {
        user.listUsers(TEST_LIST_USER_JSON, function(err, results) {
            assert.ok(results[0].role !== undefined);
            assert.equal(results[0].role.role, TEST_LIST_USER_ROLE_SEARCH_RESPONSE.role);
            assert.equal(results[0].username, TEST_LIST_USER_SEARCH_RESPONSE.username);
            done();
        });
    });
    it('bad role search result', function (done) {
        search_stub = sinon.stub();
        search_stub.throws(new Error(BAD_ROLE_SEARCH_RESULT));
        user.__set__('p_search_search_by_value', search_stub);
        user.listUsers(TEST_LIST_USER_JSON, function(err, results) {
            assert.equal(err.message, BAD_ROLE_SEARCH_RESULT);
            done();
        });
    });
    it('bad user search result', function (done) {
        search_stub.onSecondCall().throws(new Error(USER_SEARCH_FAILED_RESULT));
        user.listUsers(TEST_LIST_USER_JSON, function(err, results) {
            assert.equal(err.message, USER_SEARCH_FAILED_RESULT);
            done();
        });
    });
});

describe('Test listUsersExternal', function () {
    let search_stub = undefined;
    let search_orig = user.__get__('p_search_search_by_value');
    beforeEach( function() {
        // reset search_stub just in case.
        search_stub = undefined;
        // We are not testing these other functions, so we stub them.
        // Need to clone these since the list_users function attaches the role into the user.
        let role_search_response_clone = clone(TEST_LIST_USER_ROLE_SEARCH_RESPONSE);
        let user_search_response_clone = clone(TEST_LIST_USER_SEARCH_RESPONSE);
        search_stub = sinon.stub().onFirstCall().resolves([role_search_response_clone]);
        search_stub.onSecondCall().resolves([user_search_response_clone]);
        user.__set__('p_search_search_by_value', search_stub);
    });
    afterEach( function() {
        user.__set__('p_search_search_by_value', search_orig);
    });
    it('Nominal path, listUsersExternal', function (done) {
        user.listUsersExternal(null, function(err, results) {
            assert.ok(results[0].role !== undefined);
            assert.equal(results[0].role.role, TEST_LIST_USER_ROLE_SEARCH_RESPONSE.role);
            assert.equal(results[0].username, TEST_LIST_USER_SEARCH_RESPONSE.username);
            assert.equal(results[0].password, undefined);
            done();
        });
    });
    it('bad role search result', function (done) {
        search_stub = sinon.stub();
        search_stub.onFirstCall().throws(new Error(BAD_ROLE_SEARCH_RESULT));
        user.__set__('p_search_search_by_value', search_stub);
        user.listUsersExternal(TEST_LIST_USER_JSON, function(err, results) {
            assert.equal(err.message, BAD_ROLE_SEARCH_RESULT);
            done();
        });
    });
    it('bad user search result', function (done) {
        search_stub.onSecondCall().throws(new Error(USER_SEARCH_FAILED_RESULT));
        user.__set__('p_search_search_by_value', search_stub);
        user.listUsersExternal(TEST_LIST_USER_JSON, function(err, results) {
            assert.equal(err.message, USER_SEARCH_FAILED_RESULT);
            done();
        });
    });
});
