"use strict";
const test_utils = require('../test_utils');
test_utils.preTestPrep();
const assert = require('assert');
const sinon = require('sinon');
const rewire = require('rewire');
const user = rewire('../../security/user');
const insert = require('../../data_layer/insert');
const validation = require('../../validation/user_validation');
const signalling = require('../../utility/signalling');
const util = require('util');
let license = require('../../utility/registration/hdb_license');
const { TEST_USER_ERROR_MSGS } = require('../commonTestErrors');

let USER_SEARCH_RESULT = new Map([
    [
        "cluster_user",
        {
            "active": true,
            "hash": "blahbblah",
            "password": "somepass",
            "role": {
                "id": "58aa0e11-b761-4ade-8a7d-e90f1d99d246",
                "permission": {
                    "cluster_user": true
                },
                "role": "cluster_role"
            },
            "username": "cluster_user"
        }
    ],
    [
        "su_1",
        {
            "active": true,
            "password": "somepass",
            "role": {
                "id": "08fec166-bbfb-4822-ab3d-9cb4baeff86f",
                "permission": {
                    "super_user": true
                },
                "role": "super_user"
            },
            "username": "su_1"
        }
    ],
    [
        "su_2",
        {
            "active": true,
            "password": "somepass",
            "role": {
                "id": "08fec166-bbfb-4822-ab3d-9cb4baeff86f",
                "permission": {
                    "super_user": true
                },
                "role": "super_user"
            },
            "username": "su_2"
        }
    ],
    [
        "nonsu_1",
        {
            "active": true,
            "password": "somepass",
            "role": {
                "id": "123a0e11-b761-4ade-8a7d-e90f1d99d246",
                "permission": {
                    "super_user": false
                },
                "role": "nonsu_role"
            },
            "username": "nonsu_1"
        }
    ]
]);

const TEST_USER = {
    "active": true,
    "username": "test_user",
    "role": {
        "id": "08fec166-bbfb-4822-ab3d-9cb4baeff86f",
        "permission": {
            "super_user": true
        },
        "role": "super_user"
    }
}

const TEST_ADD_USER_JSON = {
    "operation": "add_user",
    "role": "test_role",
    "username": "test_user",
    "password": "test1234!",
    "active": "true"
};

const TEST_ALTER_USER_JSON = {
    "operation": "alter_user",
    "role": "test_role",
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

const TEST_ADD_USER_SEARCH_OBJ = [{
    "schema": "system",
    "table": "hdb_role",
    "search_attribute": "role",
    "search_value": "super_user",
    "get_attributes": [
        "id", "role", "permission"
    ]
}];

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
    skipped_hashes: '[]'
};

const VALID_ROLE = {
    "permission": {
        "super_user": true
    },
    "id": "c7035e09-5f5b-43b1-8ba9-c945f8c9da35",
    "role": "super_user"
};

const TEST_USER_INFO_SEARCH_FAIL_RESPONSE = "Role Not Found";

const ADD_USER_RESULT = 'test_user successfully added';
const BAD_ROLE_SEARCH_RESULT = '057540eb-3e93-4fab-8397-a4545f850b18 role not found';
const ADD_USER_INSERT_FAILED_RESULT = 'Insert Failed.';
const FAILED_VALIDATE_MESSAGE = "Failed Validation";
const DROP_USER_RESULT = 'test_user successfully deleted';
const USER_SEARCH_FAILED_RESULT = 'User not found';

// Naive clone, never ever do this in prod code.
function clone(a) {
    return JSON.parse(JSON.stringify(a));
}

let search_hash_stub = undefined;
let search_value_stub = undefined;
let search_val_orig = user.__get__('p_search_search_by_value');
let insert_stub = undefined;
let update_stub = undefined;
let validate_stub = undefined;
let signal_spy = undefined;
let search_orig = user.__get__('p_search_search_by_hash');

describe('Test addUser', function () {
    beforeEach( function() {
        // We are not testing these other functions, so we stub them.
        //search_stub = sinon.stub(search, "searchByHash").yields("", TEST_ADD_USER_SEARCH_OBJ);
        search_hash_stub = sinon.stub().resolves(TEST_USER_INFO_SEARCH_RESPONSE);
        search_value_stub = sinon.stub().resolves(TEST_USER_INFO_SEARCH_RESPONSE);
        user.__set__('p_search_search_by_hash', search_hash_stub);
        user.__set__('p_search_search_by_value', search_value_stub);
        insert_stub = sinon.stub(insert, "insert").resolves({message: 'inserted 1 or 1 records', skipped_hashes : [], inserted_hashes: [`test_user`]});
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

    it('Nominal path, add a user', async function () {
        let res = await user.addUser(TEST_ADD_USER_JSON);
        assert.equal(res, ADD_USER_RESULT, 'Expected success result not returned.');
        assert.equal(signal_spy.called, true);
    });

    it('Nominal path, user role updated with id value before being passed to insert', async function () {
        await user.addUser(TEST_ADD_USER_JSON);

        let cleaned_user_role = insert_stub.args[0][0].records[0].role;
        let expected_role_id = TEST_USER_INFO_SEARCH_RESPONSE[0].id;
        assert.equal(cleaned_user_role, expected_role_id, 'Expected role value to be updated with id.');
    });

    it('Test error thrown if no role exists', async function () {
        search_value_stub.resolves(null);
        let err = undefined;
        try {
            await user.addUser(TEST_ADD_USER_JSON);
        } catch(error) {
            err = error;
        }
        assert.equal(err.message, TEST_USER_ERROR_MSGS.ROLE_NAME_NOT_FOUND(TEST_ADD_USER_JSON.role), 'Expected success result not returned.');
        assert.equal(signal_spy.called, false);
    });

    it('Test error thrown if no role exists', async function () {
        search_value_stub.resolves([]);
        let err = undefined;
        try {
            await user.addUser(TEST_ADD_USER_JSON);
        } catch(error) {
            err = error;
        }
        assert.equal(err.message, TEST_USER_ERROR_MSGS.ROLE_NAME_NOT_FOUND(TEST_ADD_USER_JSON.role), 'Expected success result not returned.');
        assert.equal(signal_spy.called, false);
    });

    it('Test error thrown if more than 1 of same role exists', async function () {
        search_value_stub.resolves([ {}, {} ]);
        let err = undefined;
        try {
            await user.addUser(TEST_ADD_USER_JSON);
        } catch(error) {
            err = error;
        }
        assert.equal(err.message, TEST_USER_ERROR_MSGS.DUP_ROLES_FOUND(TEST_ADD_USER_JSON.role), 'Expected success result not returned.');
        assert.equal(signal_spy.called, false);
    });

    it('Test failed insert', async function () {
        // inject a failed insert
            insert_stub.throws(new Error(ADD_USER_INSERT_FAILED_RESULT));
            let err = undefined;
            try {
                let res = await user.addUser(TEST_ADD_USER_JSON);
            } catch(error) {
                err = error;
            }
            assert.equal(err.message, ADD_USER_INSERT_FAILED_RESULT, 'Expected success result not returned.');
            assert.equal(signal_spy.called, false);
    });

    it('Test failed validation', async function () {
        // inject a failed insert
        validate_stub.callsFake(function() {
            return FAILED_VALIDATE_MESSAGE;
        });
        let err;
        try {
            let res = await user.addUser(TEST_ADD_USER_JSON);
        } catch(error) {
            err = error;
        }
        assert.equal(err.message, FAILED_VALIDATE_MESSAGE, 'Expected success result not returned.');
        assert.equal(signal_spy.called, false);
    });
});

describe('Test alterUser', function () {
    let insert_stub = undefined;
    let role_search_stub = undefined;
    let validate_stub = undefined;
    let signal_spy = undefined;
    let search_orig = user.__get__('p_search_search_by_hash');
    beforeEach( function() {
        update_stub = sinon.stub(insert, "update").resolves(TEST_UPDATE_RESPONSE);
        validate_stub = sinon.stub(validation, "alterUserValidation").callsFake(function() {
            return null;
        });
        signal_spy = sinon.spy(signalling, "signalUserChange");
        role_search_stub = sinon.stub().resolves([TEST_LIST_USER_ROLE_SEARCH_RESPONSE]);
        user.__set__('p_search_search_by_value', role_search_stub);
        global.hdb_users = new Map([[TEST_USER.username, TEST_USER]]);
    });
    afterEach( function() {
        update_stub.restore();
        validate_stub.restore();
        signal_spy.restore();
        global.hdb_users = undefined;
    });
    it('Nominal path, alter a user', async function () {
        // We are not testing these other functions, so we stub them.
        let res = await user.alterUser(TEST_ALTER_USER_JSON);
        assert.equal(res, TEST_UPDATE_RESPONSE, 'Expected success result not returned.');
        assert.equal(signal_spy.called, true);
    });

    it('Nominal path, user role updated with id value before being passed to update', async function () {
        await user.alterUser(TEST_ALTER_USER_JSON);

        let cleaned_user_role = update_stub.args[0][0].records[0].role;
        let expected_role_id = TEST_LIST_USER_ROLE_SEARCH_RESPONSE.id;
        assert.equal(cleaned_user_role, expected_role_id, 'Expected role value to be updated with id.');
    });

    it('Test failed validation no username', async function () {
        // inject a failed insert
        validate_stub.callsFake(function() {
            return FAILED_VALIDATE_MESSAGE;
        });
        let err = undefined;
        try {
            let res = await user.alterUser(TEST_ALTER_USER_NO_USERNAME_JSON);
        } catch(error) {
            err = error;
        }
        assert.equal(err.message, user.USERNAME_REQUIRED, 'Expected success result not returned.');
        assert.equal(signal_spy.called, false);
    });

    it('Test failed validation nothing to update', async function () {
        // inject a failed insert
        validate_stub.callsFake(function() {
            return FAILED_VALIDATE_MESSAGE;
        });
        let err = undefined;
        try {
            let res = await user.alterUser(TEST_ALTER_USER_NOTHING_TO_UPDATE_JSON);
        } catch(error) {
            err = error;
        }
        assert.equal(err.message, user.ALTERUSER_NOTHING_TO_UPDATE, 'Expected success result not returned.');
        assert.equal(signal_spy.called, false);
    });

    it('Test failed validation nothing to update 2', async function () {
        // inject a failed insert
        validate_stub.callsFake(function() {
            return FAILED_VALIDATE_MESSAGE;
        });
        let err = undefined;
        try {
            let res = await user.alterUser(TEST_ALTER_USER_NOTHING_TO_UPDATE_JSON2);
        } catch(error) {
            err = error;
        }
        assert.equal(err.message, user.ALTERUSER_NOTHING_TO_UPDATE, 'Expected success result not returned.');
        assert.equal(signal_spy.called, false);
    });

    it('Test failed validation empty role', async function () {
        // inject a failed insert
        validate_stub.callsFake(function() {
            return FAILED_VALIDATE_MESSAGE;
        });
        let err = undefined;
        try {
            let res = await user.alterUser(TEST_ALTER_USER_EMPTY_ROLE_JSON);
        } catch(error) {
            err = error;
        }
        assert.equal(err.message, user.EMPTY_ROLE, 'Expected success result not returned.');
        assert.equal(signal_spy.called, false);
    });

    it('Test failed validation empty password', async function () {
        // inject a failed insert
        validate_stub.callsFake(function() {
            return FAILED_VALIDATE_MESSAGE;
        });
        let err = undefined;
        try {
            let res = await user.alterUser(TEST_ALTER_USER_EMPTY_PASSWORD_JSON);
        } catch(error) {
            err = error;
        }
        assert.equal(err.message, user.EMPTY_PASSWORD, 'Expected success result not returned.');
        assert.equal(signal_spy.called, false);
    });

    it('Test failed validation active not boolean', async function () {
        // inject a failed insert
        validate_stub.callsFake(function() {
            return FAILED_VALIDATE_MESSAGE;
        });
        let err = undefined;
        try {
            let res = await user.alterUser(TEST_ALTER_USER_ACTIVE_NOT_BOOLEAN_JSON);
        } catch(error) {
            err = error;
        }
        assert.equal(err.message, user.ACTIVE_BOOLEAN, 'Expected success result not returned.');
        assert.equal(signal_spy.called, false);
    });

    it('Test null role found', async function () {
        role_search_stub = sinon.stub().resolves(null);
        user.__set__('p_search_search_by_value', role_search_stub);
        let err = undefined;
        try {
            await user.alterUser(TEST_ALTER_USER_JSON);
        } catch(error) {
            err = error;
        }
        assert.equal(err.message, TEST_USER_ERROR_MSGS.ALTER_USER_ROLE_NOT_FOUND(TEST_ALTER_USER_JSON.role), 'Expected success result not returned.');
        assert.equal(signal_spy.called, false);
    });

    it('Test no role found', async function () {
        role_search_stub = sinon.stub().resolves([]);
        user.__set__('p_search_search_by_value', role_search_stub);
        let err = undefined;
        try {
            await user.alterUser(TEST_ALTER_USER_JSON);
        } catch(error) {
            err = error;
        }
        assert.equal(err.message, TEST_USER_ERROR_MSGS.ALTER_USER_ROLE_NOT_FOUND(TEST_ALTER_USER_JSON.role), 'Expected success result not returned.');
        assert.equal(signal_spy.called, false);
    });

    it('Test multiple roles found', async function () {
        role_search_stub = sinon.stub().resolves([{}, {}]);
        user.__set__('p_search_search_by_value', role_search_stub);
        let err = undefined;
        try {
            await user.alterUser(TEST_ALTER_USER_JSON);
        } catch(error) {
            err = error;
        }
        assert.equal(err.message, TEST_USER_ERROR_MSGS.ALTER_USER_DUP_ROLES(TEST_ALTER_USER_JSON.role), 'Expected success result not returned.');
        assert.equal(signal_spy.called, false);
    });

    it('Test exception during role search', async function () {
        role_search_stub = sinon.stub().throws(new Error('Role Search Error'));
        user.__set__('p_search_search_by_value', role_search_stub);
        let err = undefined;
        try {
            let res = await user.alterUser(TEST_ALTER_USER_JSON);
        } catch(error) {
            err = error;
        }
        assert.equal(err.message, 'Role Search Error', 'Expected success result not returned.');
        assert.equal(signal_spy.called, false);
    });
});

describe('Test dropUser', function () {
    let delete_stub = undefined;
    let validate_stub = undefined;
    let signal_spy = undefined;
    let delete_orig = user.__get__('p_delete_delete');

    before(function() {
        user.__set__('p_search_search_by_value', search_val_orig)
    })

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

    it('Nominal path, drop a user', async function () {
        // We are not testing these other functions, so we stub them.
        let err = undefined;
        let res;
        try {
            res = await user.dropUser(TEST_DROP_USER_JSON);
        } catch(error) {
            err = error;
        }
        assert.equal(res, DROP_USER_RESULT, 'Expected success result not returned.');
        assert.equal(signal_spy.called, true);
    });

    it('Test failed validation', async function () {
        // inject a failed insert
        validate_stub.callsFake(function() {
            return FAILED_VALIDATE_MESSAGE;
        });
        let err = undefined;
        try {
            let res = await user.dropUser(TEST_ALTER_USER_JSON);
        } catch(error) {
            err = error;
        }
        assert.equal(err.message, FAILED_VALIDATE_MESSAGE, 'Expected success result not returned.');
        assert.equal(signal_spy.called, false);
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

    it('Nominal path, get user info', async function () {
        // We are not testing these other functions, so we stub them.
        let err = undefined;
        let res;
        try {
            res = await user.userInfo(TEST_USER_INFO_JSON);
        } catch(error) {
            err = error;
        }
        assert.ok(res.role !== undefined);
        assert.equal(res.role.role, TEST_USER_INFO_SEARCH_RESPONSE[0].role);
        assert.equal(res.role.id, TEST_USER_INFO_SEARCH_RESPONSE[0].id);
        assert.equal(res.role.permission.super_user, TEST_USER_INFO_SEARCH_RESPONSE[0].permission.super_user);
        assert.ok(res.username === 'blah');
        assert.ok(res.password === undefined);
    });

    it('bad search result in user info', async function () {
        // We are not testing these other functions, so we stub them.
        search_stub.throws(new Error(TEST_USER_INFO_SEARCH_FAIL_RESPONSE));
        let err = undefined;
        try {
            let res = await user.userInfo(TEST_USER_INFO_JSON);
        } catch(error) {
            err = error;
        }
        assert.equal(err.message, TEST_USER_INFO_SEARCH_FAIL_RESPONSE, 'Expected success result not returned.');
    });
});

describe('Test list_users', function () {
    let search_stub = undefined;
    let search_orig = user.__get__('p_search_search_by_value');
    let license_stub = undefined;
    let sandbox = undefined;

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
        sandbox = sinon.createSandbox();
        license_stub = sandbox.stub(license, "getLicense").resolves({enterprise: true});
    });

    afterEach( function() {
        user.__set__('p_search_search_by_value', search_orig);
        sandbox.restore();
    });

    it('Nominal path, list users', async function () {
        let err = undefined;
        let res;
        try {
            res = await user.listUsers(TEST_LIST_USER_JSON);
        } catch(error) {
            let err = error;
        }
        const usernames = Array.from(res.keys());
        assert.ok(res.get(usernames[0]).role !== undefined);
        assert.equal(res.get(usernames[0]).role.role, TEST_LIST_USER_ROLE_SEARCH_RESPONSE.role);
        assert.equal(res.get(usernames[0]).username, TEST_LIST_USER_SEARCH_RESPONSE.username);
    });

    it('bad role search result', async function () {
        search_stub = sinon.stub();
        search_stub.throws(new Error(BAD_ROLE_SEARCH_RESULT));
        user.__set__('p_search_search_by_value', search_stub);
        let err = undefined;
        let res;
        try {
            res = await user.listUsers(TEST_LIST_USER_JSON);
        } catch(error) {
            err = error;
        }
        assert.equal(err.message, BAD_ROLE_SEARCH_RESULT);
    });

    it('bad user search result', async function () {
        search_stub.onSecondCall().throws(new Error(USER_SEARCH_FAILED_RESULT));
        let err = undefined;
        let res;
        try {
            res = await user.listUsers(TEST_LIST_USER_JSON);
        } catch(error) {
            err = error;
        }
        assert.equal(err.message, USER_SEARCH_FAILED_RESULT);
    });
});

describe('Test listUsersExternal', function () {
    let search_stub = undefined;
    let search_orig = user.__get__('p_search_search_by_value');
    let license_stub = undefined;
    let sandbox = undefined;

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
        sandbox = sinon.createSandbox();
        license_stub = sandbox.stub(license, "getLicense").resolves({enterprise: true});
    });

    afterEach( function() {
        user.__set__('p_search_search_by_value', search_orig);
        sandbox.restore();
    });

    it('Nominal path, listUsersExternal', async function () {
        let err = undefined;
        let res;
        try {
            res = await user.listUsersExternal(TEST_LIST_USER_JSON);
        } catch(error) {
            err = error;
        }
        assert.ok(res[0].role !== undefined);
        assert.equal(res[0].role.role, TEST_LIST_USER_ROLE_SEARCH_RESPONSE.role);
        assert.equal(res[0].username, TEST_LIST_USER_SEARCH_RESPONSE.username);
        assert.equal(res[0].password, undefined);
    });

    it('bad role search result', async function () {
        search_stub = sinon.stub();
        search_stub.onFirstCall().throws(new Error(BAD_ROLE_SEARCH_RESULT));
        user.__set__('p_search_search_by_value', search_stub);
        let err = undefined;
        try {
            let res = await user.listUsersExternal(TEST_LIST_USER_JSON);
        } catch(error) {
            err = error;
        }
        assert.equal(err.message, BAD_ROLE_SEARCH_RESULT);
    });

    it('bad user search result', async function () {
        search_stub.onSecondCall().throws(new Error(USER_SEARCH_FAILED_RESULT));
        user.__set__('p_search_search_by_value', search_stub);
        let err = undefined;
        try {
            let res = await user.listUsersExternal(TEST_LIST_USER_JSON);
        } catch(error) {
            err = error;
        }
        assert.equal(err.message, USER_SEARCH_FAILED_RESULT);
    });
});

describe('Test nonEnterpriseFilter', function () {
    let search_stub = undefined;
    let search_orig = user.__get__('p_search_search_by_value');
    let license_stub = undefined;
    let sandbox = undefined;
    let nonEnterpriseFilter = undefined;

    beforeEach(function () {
        // reset search_stub just in case.
        search_stub = undefined;
        // We are not testing these other functions, so we stub them.
        // Need to clone these since the list_users function attaches the role into the user.
        let role_search_response_clone = clone(TEST_LIST_USER_ROLE_SEARCH_RESPONSE);
        let user_search_response_clone = clone(TEST_LIST_USER_SEARCH_RESPONSE);
        search_stub = sinon.stub().onFirstCall().resolves([role_search_response_clone]);
        search_stub.onSecondCall().resolves([user_search_response_clone]);
        user.__set__('p_search_search_by_value', search_stub);
        sandbox = sinon.createSandbox();

        nonEnterpriseFilter = user.__get__('nonEnterpriseFilter');
    });

    afterEach(function () {
        user.__set__('p_search_search_by_value', search_orig);
        sandbox.restore();
    });

    it('Nominal test, expect non su user filtered', () => {
        let error, res;
        license_stub = sandbox.stub(license, "getLicense").resolves({enterprise: true});
        try {
            res = nonEnterpriseFilter(new Map(USER_SEARCH_RESULT));
        } catch(err) {
            error = err;
        }
        assert.strictEqual(res.size, USER_SEARCH_RESULT.size-1, "expected nothing filtered");
    });

    it('Nominal test, expect filtered', () => {
        let error, res;
        license_stub = sandbox.stub(license, "getLicense").resolves({enterprise: false});
        try {
            res = nonEnterpriseFilter(new Map(USER_SEARCH_RESULT));
        } catch(err) {
            error = err;
        }
        assert.strictEqual(res.size, USER_SEARCH_RESULT.size-1, "expected non su user filtered");
    });

    it('Invalid parameter, Expect empty array', () => {
        let error, res;
        license_stub = sandbox.stub(license, "getLicense").resolves({enterprise: true});
        try {
            res = nonEnterpriseFilter(null);
        } catch(err) {
            error = err;
        }
        assert.strictEqual(res.size, 0, "expected empty array");
    });
});

describe('Test appendSystemTablesToRole function', function () {
    it('validate permissions are added for system tables.', function (done) {
        let role_temp = test_utils.deepClone(VALID_ROLE);
        let temp_append = user.__get__('appendSystemTablesToRole');
        temp_append(role_temp);
        assert.notEqual(role_temp.permission.system.tables, undefined, 'expected system tables to be created');
        assert.notEqual(role_temp.permission.system.tables.hdb_role, undefined, 'expected system tables to be created');
        done();
    });
});
