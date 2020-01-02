"use strict"
/**
 * Test the server_utilities module.
 */

const assert = require('assert');
const sinon = require('sinon');
const rewire = require('rewire');
const server_utilities = rewire('../server/serverUtilities');

async function test_func(test_valuse) {
    return true;
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
                "super_user": false,
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
};

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
                "super_user": true,
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

// Naive clone, never ever do this in prod code.
function clone(a) {
    return JSON.parse(JSON.stringify(a));
}

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
        });
    });
    it('Invalid operation specified in json.', function (done) {
        let chooseOperation = server_utilities.__get__('chooseOperation');
        let test_copy = clone(TEST_JSON);
        test_copy.operation = 'blah';
        chooseOperation(test_copy, function(err, found) {
            assert.ok(err.response === 403);
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