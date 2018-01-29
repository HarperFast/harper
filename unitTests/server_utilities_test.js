/**
 * Test the server_utilities module.
 */

const assert = require('assert');
const sinon = require('sinon');
const fs = require('fs');
const rewire = require('rewire');
const server_utilities = rewire('../server/server_utilities');
const write = require('../data_layer/insert');

function test_func(test_valuse, callback) {
    return callback(null, true);
}

function test_func_error(test_valuse, callback) {
    return callback("This is bad!", null);
}

class fork_stub  {
    constructor(){}
    send(payload) {
        return;
    };
};

let FORK_STUB = new fork_stub();

let TEST_JSON = {
    "operation": "insert",
    "schema": "dev",
    "table": "dog",
    "records": [
        {
            "name": "Harper",
            "breed": "Mutt",
            "id": "111",
            "age": 5
        },
        {
            "name": "Penny",
            "breed": "Mutt",
            "id": "333",
            "age": 5
        }
    ],
    "hdb_user": {
        "active": true,
        "role": {
            "id": "9c9aae33-4d1d-40b5-a52e-bbbc1b2e2ba6",
            "permission": {
                "super_admin": false,
                "dev": {
                    "tables": {
                        "dog": {
                            "read": true,
                            "insert": true,
                            "update": true,
                            "delete": true,
                            "attribute_restrictions": []
                        }
                    }
                }
            },
            "role": "no_perms"
        },
        "username": "bad_user_2"
    }
}

let TEST_JSON_SUPER_USER = {
    "operation": "insert",
    "schema": "dev",
    "table": "dog",
    "records": [
        {
            "name": "Harper",
            "breed": "Mutt",
            "id": "111",
            "age": 5
        },
        {
            "name": "Penny",
            "breed": "Mutt",
            "id": "333",
            "age": 5
        }
    ],
    "hdb_user": {
        "active": true,
        "role": {
            "id": "9c9aae33-4d1d-40b5-a52e-bbbc1b2e2ba6",
            "permission": {
                "super_admin": true,
                "dev": {
                    "tables": {
                        "dog": {
                            "read": true,
                            "insert": true,
                            "update": true,
                            "delete": true,
                            "attribute_restrictions": []
                        }
                    }
                }
            },
            "role": "no_perms"
        },
        "username": "bad_user_2"
    }
}

let EMPTY_PERMISSION = {
    "super_admin": false
};

function clone(a) {
    return JSON.parse(JSON.stringify(a));
}

describe(`Test verify_perms`, function () {

    it('Pass in bad values, expect false', function () {
        let verifyParams = server_utilities.__get__('verify_perms');
        assert.equal(verifyParams(null, null), false);
    });
    it('Pass in bad values, expect false', function () {
        let verifyParams = server_utilities.__get__('verify_perms');
        assert.equal(verifyParams(TEST_JSON_SUPER_USER, write.insert.name), true);
    });
    it('Pass in JSON with no schemas restrictions defined, expect true', function () {
        let verifyParams = server_utilities.__get__('verify_perms');
        let test_copy = clone(TEST_JSON);
        test_copy.hdb_user.role.permission = EMPTY_PERMISSION;
        assert.equal(verifyParams(test_copy, write.insert.name), true);
    });
    it('Pass in JSON with schemas but no tables defined, expect true', function () {
        let verifyParams = server_utilities.__get__('verify_perms');
        let test_copy = clone(TEST_JSON);
        let perms = {
            "super_admin": false,
            "dev": {
                "tables": {
                }
            },
            "test": {
                "tables": {
                }
            }
        };
        test_copy.hdb_user.role.permission = perms;
        assert.equal(verifyParams(test_copy, write.insert.name), true);
    });
    it('Pass in JSON with schemas and table dog defined, insert not allowed, expect false', function () {
        let verifyParams = server_utilities.__get__('verify_perms');
        let test_copy = clone(TEST_JSON);
        let perms = {
            "super_admin": false,
            "dev": {
                "tables": {
                    "dog": {
                        "read": false,
                        "insert": false,
                        "update": false,
                        "delete": false,
                        "attribute_restrictions": []
                    }
                }
            },
        };
        test_copy.hdb_user.role.permission = perms;
        assert.equal(verifyParams(test_copy, write.insert.name), false);
    });
    it('(NOMINAL) - Pass in JSON with schemas and table dog defined, insert allowed, expect true', function () {
        let verifyParams = server_utilities.__get__('verify_perms');
        let test_copy = clone(TEST_JSON);
        let perms = {
            "super_admin": false,
            "dev": {
                "tables": {
                    "dog": {
                        "read": false,
                        "insert": true,
                        "update": false,
                        "delete": false,
                        "attribute_restrictions": []
                    }
                }
            },
        };
        test_copy.hdb_user.role.permission = perms;
        assert.equal(verifyParams(test_copy, write.insert.name), true);
    });
    it('Test operation with read & insert required, but user only has insert.  False expected', function () {
        let verifyParams = server_utilities.__get__('verify_perms');
        let required_permissions = server_utilities.__get__('required_permissions');
        required_permissions.set('test method', ['insert', 'read']);
        let test_copy = clone(TEST_JSON);
        let perms = {
            "super_admin": false,
            "dev": {
                "tables": {
                    "dog": {
                        "read": false,
                        "insert": true,
                        "update": false,
                        "delete": false,
                        "attribute_restrictions": []
                    }
                }
            },
        };
        test_copy.hdb_user.role.permission = perms;
        assert.equal(verifyParams(test_copy, 'test method'), false);
    });
    it('Test bad method.  False expected', function () {
        let verifyParams = server_utilities.__get__('verify_perms');
        let test_copy = clone(TEST_JSON);
        let perms = {
            "super_admin": false,
            "dev": {
                "tables": {
                    "dog": {
                        "read": false,
                        "insert": true,
                        "update": false,
                        "delete": false,
                        "attribute_restrictions": []
                    }
                }
            },
        };
        test_copy.hdb_user.role.permission = perms;
        assert.equal(verifyParams(test_copy, 'bad method'), false);
    });
    it('Test bad permission name.  False expected', function () {
        let verifyParams = server_utilities.__get__('verify_perms');
        let test_copy = clone(TEST_JSON);
        let perms = {
            "super_admin": false,
            "dev": {
                "tables": {
                    "dog": {
                        "read": false,
                        "fart": true,
                        "update": false,
                        "delete": false,
                        "attribute_restrictions": []
                    }
                }
            },
        };
        test_copy.hdb_user.role.permission = perms;
        assert.equal(verifyParams(test_copy, write.insert.name), false);
    });
});

describe(`Test chooseOperation`, function () {
    it('Pass in bad json, expect err in callback', function (done) {
        let chooseOperation = server_utilities.__get__('chooseOperation');
        chooseOperation(undefined, function(err, found) {
            assert.ok(err.length > 0);
            done();
        })
    });
    it('Nominal path with insert operation.', function (done) {
        let chooseOperation = server_utilities.__get__('chooseOperation');
        chooseOperation(TEST_JSON_SUPER_USER, function(err, found) {
            assert.ok(err === null );
            done();
        })
    });
    it('Invalid operation specified in json.', function (done) {
        let chooseOperation = server_utilities.__get__('chooseOperation');
        let test_copy = clone(TEST_JSON);
        test_copy.operation = 'blah';
        chooseOperation(test_copy, function(err, found) {
            assert.ok(err === null);
            done();
        })
    });
});

describe(`Test proccessDelegatedTransaction`, function () {
    it('Pass in operation, expect err in callback', function (done) {
        let proccessDelegatedTransaction = server_utilities.__get__('proccessDelegatedTransaction');
        global.forks = [FORK_STUB];
        proccessDelegatedTransaction(undefined, 'insert', function (err, found) {
            assert.ok(err.length > 0);
            done();
        })
    });
    it('Global.forks undefined', function (done) {
        let proccessDelegatedTransaction = server_utilities.__get__('proccessDelegatedTransaction');
        global.forks = undefined;
        proccessDelegatedTransaction('insert', 'insert', function (err, found) {
            assert.ok(err.length > 0);
            done();
        })
    });
    it('Nominal path Global.forks with fork stub "send" spy', function (done) {
        let proccessDelegatedTransaction_spy =  sinon.spy(FORK_STUB, 'send');
        let proccessDelegatedTransaction = server_utilities.__get__('proccessDelegatedTransaction');
        global.forks = [FORK_STUB];
        global.delegate_callback_queue = [];
        proccessDelegatedTransaction('insert', 'insert', function (err, found) {
            // Manually invoking the callback below will return us into here.
            assert.equal(proccessDelegatedTransaction_spy.called,true, "'send' function was not called.");
            done();
        });
        // Need to call the callback that was assigned in the queue in order to ensure it was called.
        for(var propertyName in global.delegate_callback_queue) {
            global.delegate_callback_queue[propertyName]();
        }
    });
});

describe(`Test processInThread`, function () {
    it('Test processInThread nominal path by using test_func declared above', function (done) {
        let processInThread = server_utilities.__get__('processInThread');
        //Use the test_func function above as an operation function stub
        processInThread('insert', test_func, function (err, found) {
            assert.equal(found.message,true);
            done();
        });
    });
    it('Test processInThread error path by using test_func_error declared above', function (done) {
        let processInThread = server_utilities.__get__('processInThread');
        //Use the test_func function above as an operation function stub
        processInThread('insert', test_func_error, function (err, found) {
            assert.ok(err.error.length > 0 );
            done();
        });
    });
    it('Test processInThread pass invalid operation', function (done) {
        let processInThread = server_utilities.__get__('processInThread');
        //Use the test_func function above as an operation function stub
        processInThread(undefined, test_func_error, function (err, found) {
            assert.ok(err.length > 0 );
            done();
        });
    });
    it('Test processInThread pass invalid operation_function', function (done) {
        let processInThread = server_utilities.__get__('processInThread');
        //Use the test_func function above as an operation function stub
        processInThread('insert', undefined, function (err, found) {
            assert.ok(err.length > 0 );
            done();
        });
    });
});

describe(`Test processLocalTransaction`, function () {
    let mock_request = {"body":"blah"};

    it('Test processLocalTransaction nominal path by using test_func declared above', function (done) {
        let processLocalTransaction = server_utilities.__get__('processLocalTransaction');
        let mock = {
            send: function(){ },
            json: function(stuff){
                this.json = stuff;
            },
            status: function(responseStatus) {
                this.status = responseStatus;
                // This next line makes it chainable
                return this;
            }
        }
        //Use the test_func function above as an operation function stub
        processLocalTransaction(mock_request, mock, test_func, function (err, found) {
            assert.equal(mock.status,200);
            assert.equal(mock.json.message,true);
            done();
        });
    });
    it('Test processLocalTransaction error path by using test_func_error declared above', function (done) {
        let processLocalTransaction = server_utilities.__get__('processLocalTransaction');
        let mock = {
            send: function(){ },
            json: function(stuff){
                this.json = stuff;
            },
            status: function(responseStatus) {
                this.status = responseStatus;
                // This next line makes it chainable
                return this;
            }
        }
        //Use the test_func function above as an operation function stub
        processLocalTransaction(mock_request, mock, test_func_error, function (err, found) {
            assert.equal(mock.status,500);
            assert.ok(mock.json.error.length > 0 );
            done();
        });
    });
});