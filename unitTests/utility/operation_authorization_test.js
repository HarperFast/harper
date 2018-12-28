"use strict"
/**
 * Test the operation_authorization module.
 */
const test_utils = require('../test_utils');
test_utils.preTestPrep();
const assert = require('assert');
const rewire = require('rewire');
const op_auth = require('../../utility/operation_authorization');
const op_auth_rewire = rewire('../../utility/operation_authorization');
const write = require('../../data_layer/insert');
const user = require('../../security/user');
const alasql = require('alasql');
const search = require('../../data_layer/search');

let EMPTY_PERMISSION = {
    "super_user": false
};

let TEST_SELECT_WILDCARD_JSON = {
    "columns": [
    {
        "columnid": "*"
    }
],
    "from": [
    {
        "databaseid": "dev",
        "tableid": "dog"
    }
],
    "where": {
    "expression": {
        "left": {
            "columnid": "id"
        },
        "op": "=",
            "right": {
            "value": 1
        }
    }
}
};

let TEST_INSERT_JSON = {
    "into": {
        "databaseid": "dev",
        "tableid": "dog"
    },
    "columns": [
        {
            "columnid": "id"
        },
        {
            "columnid": "name"
        }
    ],
    "values": [
        [
            {
                "value": 22
            },
            {
                "value": "Simon"
            }
        ]
    ]
};

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

let PERMISSION_BASE = {
    "super_user": false,
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

let ATTRIBUTE_RESTRICTION_BASE = {
    "attribute_restrictions": [{
        "attribute_name": "name",
        "read": false,
        "insert": true,
        "update": false,
        "delete": false
    }]
};

let AFFECTED_ATTRIBUTES_SET = new Set(['name', 'breed', 'id', 'age']);

let ROLE_RESTRICTION_KEY = 'name';

let ROLE_ATTRIBUTE_RESTRICTIONS = new Map();
ROLE_ATTRIBUTE_RESTRICTIONS.set(ROLE_RESTRICTION_KEY, ATTRIBUTE_RESTRICTION_BASE.attribute_restrictions[0]);

/*
    This is a simple, naive clone implementation.  It should never, ever! be used in prod.
 */
function clone(a) {
    return JSON.parse(JSON.stringify(a));
}

describe(`Test verifyPerms`, function () {
    it('Pass in bad values, expect false', function () {
        assert.equal(op_auth.verifyPerms(null, null), false);
    });
    it('Check return if user has su.  Expect true', function () {
        assert.equal(op_auth.verifyPerms(TEST_JSON_SUPER_USER, write.insertCB.name), true);
    });
    it('Pass function instead of function name.  Expect true (no errors)', function () {
        assert.equal(op_auth.verifyPerms(TEST_JSON, write.insertCB), true);
    });
    it('Pass function name instead of function.  Expect true (no errors)', function () {
        assert.equal(op_auth.verifyPerms(TEST_JSON, write.insertCB.name), true);
    });
    it('Pass in JSON with no schemas restrictions defined, expect true', function () {
        let test_copy = clone(TEST_JSON);
        test_copy.hdb_user.role.permission = EMPTY_PERMISSION;
        assert.equal(op_auth.verifyPerms(test_copy, write.insertCB.name), true);
    });
    it('Pass in JSON with schemas but no tables defined, expect true', function () {
        let test_copy = clone(TEST_JSON);
        let perms = {
            "super_user": false,
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
        assert.equal(op_auth.verifyPerms(test_copy, write.insertCB.name), true);
    });
    it('Pass in JSON with schemas and table dog defined, insert not allowed, expect false', function () {
        let test_copy = clone(TEST_JSON);
        let perms = clone(PERMISSION_BASE);
        test_copy.hdb_user.role.permission = perms;
        assert.equal(op_auth.verifyPerms(test_copy, write.insertCB.name), false);
    });
    it('(NOMINAL) - Pass in JSON with schemas and table dog defined, insert allowed, expect true', function () {
        let test_copy = clone(TEST_JSON);
        let perms = clone(PERMISSION_BASE);
        perms.dev.tables.dog.insert = true;
        let att_base = clone(ATTRIBUTE_RESTRICTION_BASE);
        att_base.attribute_restrictions[0].insert = true;
        perms.dev.tables.dog.attribute_restrictions.push(att_base.attribute_restrictions[0]);
        test_copy.hdb_user.role.permission = perms;
        assert.equal(op_auth.verifyPerms(test_copy, write.insertCB.name), true);
    });
    it('Pass in JSON with schemas and table dog defined, insert allowed, user insert restriction false. expect false', function () {
        let test_copy = clone(TEST_JSON);
        let perms = clone(PERMISSION_BASE);
        perms.dev.tables.dog.insert = true;
        let att_base = clone(ATTRIBUTE_RESTRICTION_BASE);
        att_base.attribute_restrictions[0].insert = false;
        perms.dev.tables.dog.attribute_restrictions.push(att_base.attribute_restrictions[0]);
        test_copy.hdb_user.role.permission = perms;
        assert.equal(op_auth.verifyPerms(test_copy, write.insertCB.name), false);
    });
    it('Test operation with read & insert required, but user only has insert.  False expected', function () {
        let required_permissions = op_auth_rewire.__get__('required_permissions');
        required_permissions.set('test method', ['insert', 'read']);
        let test_copy = clone(TEST_JSON);
        let perms = clone(PERMISSION_BASE);
        test_copy.hdb_user.role.permission = perms;
        assert.equal(op_auth.verifyPerms(test_copy, 'test method'), false);
    });
    it('Test bad method.  False expected', function () {
        let test_copy = clone(TEST_JSON);
        let perms = clone(PERMISSION_BASE);
        perms.dev.tables.dog.insert = true;
        test_copy.hdb_user.role.permission = perms;
        assert.equal(op_auth.verifyPerms(test_copy, 'bad method'), false);
    });
    it('Test bad permission name.  False expected', function () {
        let test_copy = clone(TEST_JSON);
        // Leaving the manual perms definition due to the bad permission name below.
        let perms = {
            "super_user": false,
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
        assert.equal(op_auth.verifyPerms(test_copy, write.insertCB.name), false);
    });
    it('NOMINAL - Pass in JSON with su, function that requires su.  Expect true.', function () {
        let test_copy = clone(TEST_JSON);
        let perms = clone(PERMISSION_BASE);
        perms.super_user = true;
        perms.dev.tables.dog.insert = true;
        test_copy.hdb_user.role.permission = perms;
        assert.equal(op_auth.verifyPerms(test_copy, user.addUser), true);
    });
    it('Pass in JSON with no su, function that requires su.  Expect false.', function () {
        let test_copy = clone(TEST_JSON);
        let perms = clone(PERMISSION_BASE);
        perms.dev.tables.dog.insert = true;
        test_copy.hdb_user.role.permission = perms;
        assert.equal(op_auth.verifyPerms(test_copy, user.addUser), false);
    });
});

describe(`Test verifyPermsAst`, function () {
    it('NOMINAL, test verify with proper syntax, expect true', function () {
        let test_json = clone(TEST_INSERT_JSON);
        let temp_insert = new alasql.yy.Insert(test_json);
        let perms_user = clone(TEST_JSON);
        perms_user.hdb_user.role.permission.dev.tables.dog.insert = true;
        let att_base = clone(ATTRIBUTE_RESTRICTION_BASE);
        att_base.attribute_restrictions[0].insert = true;
        perms_user.hdb_user.role.permission.dev.tables.dog.attribute_restrictions.push(att_base.attribute_restrictions[0]);
        assert.equal(op_auth.verifyPermsAst(temp_insert, perms_user.hdb_user, write.insertCB.name), true);
    });
    it('Test verify AST with no insert perm, expect false', function () {
        let test_json = clone(TEST_INSERT_JSON);
        let temp_insert = new alasql.yy.Insert(test_json);
        let perms_user = clone(TEST_JSON);
        perms_user.hdb_user.role.permission.dev.tables.dog.insert = false;
        assert.equal(op_auth.verifyPermsAst(temp_insert, perms_user.hdb_user, write.insertCB.name), false);
    });
    it('Test verify AST with role insert perm false, expect false', function () {
        let test_json = clone(TEST_INSERT_JSON);
        let temp_insert = new alasql.yy.Insert(test_json);
        let perms_user = clone(TEST_JSON);
        perms_user.hdb_user.role.permission.dev.tables.dog.insert = true;
        let att_base = clone(ATTRIBUTE_RESTRICTION_BASE);
        att_base.attribute_restrictions[0].insert = false;
        perms_user.hdb_user.role.permission.dev.tables.dog.attribute_restrictions.push(att_base.attribute_restrictions[0]);
        assert.equal(op_auth.verifyPermsAst(temp_insert, perms_user.hdb_user, write.insertCB.name), false);
    });
    it('Test with bad operations, expect false', function () {
        let test_json = clone(TEST_INSERT_JSON);
        let temp_insert = new alasql.yy.Insert(test_json);
        let perms_user = clone(TEST_JSON);
        perms_user.hdb_user.role.permission.dev.tables.dog.insert = true;
        let att_base = clone(ATTRIBUTE_RESTRICTION_BASE);
        att_base.attribute_restrictions[0].insert = true;
        perms_user.hdb_user.role.permission.dev.tables.dog.attribute_restrictions.push(att_base.attribute_restrictions[0]);
        assert.throws(function() {op_auth.verifyPermsAst(temp_insert, perms_user.hdb_user, 'fart');}, Error);
    });
    it(`Test select wildcard with proper perms, expect true`, function () {
        let test_json = clone(TEST_SELECT_WILDCARD_JSON);
        let temp_select = new alasql.yy.Select(test_json);
        let perms_user = clone(TEST_JSON);
        perms_user.hdb_user.role.permission.dev.tables.dog.read = true;
        let att_base = clone(ATTRIBUTE_RESTRICTION_BASE);
        att_base.attribute_restrictions[0].read = true;
        perms_user.hdb_user.role.permission.dev.tables.dog.attribute_restrictions.push(att_base.attribute_restrictions[0]);
        assert.equal(op_auth.verifyPermsAst(temp_select, perms_user.hdb_user, search.search.name), true);
    });
    it(`Test select wildcard with read attribute restriction false, expect false`, function () {
        let test_json = clone(TEST_SELECT_WILDCARD_JSON);
        let temp_select = new alasql.yy.Select(test_json);
        let perms_user = clone(TEST_JSON);
        perms_user.hdb_user.role.permission.dev.tables.dog.read = true;
        let att_base = clone(ATTRIBUTE_RESTRICTION_BASE);
        att_base.attribute_restrictions[0].read = false;
        perms_user.hdb_user.role.permission.dev.tables.dog.attribute_restrictions.push(att_base.attribute_restrictions[0]);
        assert.equal(op_auth.verifyPermsAst(temp_select, perms_user.hdb_user, search.search.name), false);
    });
});

describe(`Test checkAttributePerms`, function () {
    it('Nominal path - Pass in JSON with insert attribute required.  Expect true.', function () {
        let checkAttributePerms = op_auth_rewire.__get__('checkAttributePerms');
        let result = checkAttributePerms(AFFECTED_ATTRIBUTES_SET, ROLE_ATTRIBUTE_RESTRICTIONS, write.insertCB.name);
        assert.equal(result, true);
    });
    it('Pass in JSON with insert attribute required, but role does not have insert perm.  Expect false.', function () {
        let checkAttributePerms = op_auth_rewire.__get__('checkAttributePerms');
        let role_att = new Map(ROLE_ATTRIBUTE_RESTRICTIONS);
        role_att.get(ROLE_RESTRICTION_KEY).insert = false;
        let result = checkAttributePerms(AFFECTED_ATTRIBUTES_SET, role_att, write.insertCB.name);
        assert.equal(result, false);
    });
    it('Pass invalid operation.  Expect false.', function () {
        let checkAttributePerms = op_auth_rewire.__get__('checkAttributePerms');
        assert.throws(function() {checkAttributePerms(AFFECTED_ATTRIBUTES_SET, ROLE_ATTRIBUTE_RESTRICTIONS, 'derp');}, Error);
    });
    it('Pass invalid json.  Expect false.', function () {
        let checkAttributePerms = op_auth_rewire.__get__('checkAttributePerms');
        assert.throws(function() {checkAttributePerms(null, null, write.insertCB.name);}, Error);
    });
});

describe(`Test getRecordAttributes`, function () {
    it('Nominal case, valid JSON with attributes.  Expect set with size of 4', function () {
        let getRecordAttributes = op_auth_rewire.__get__('getRecordAttributes');
        let test_copy = clone(TEST_JSON);
        let result = getRecordAttributes(test_copy);
        assert.equal(result.size , 4);
    });
    it('pass invalid JSON with attributes.  Expect empty set.', function () {
        let getRecordAttributes = op_auth_rewire.__get__('getRecordAttributes');
        let result = getRecordAttributes(null);
        assert.equal(result.size, 0);
    });
    it('Nominal case pass JSON with no records.  Expect empty set.', function () {
        let getRecordAttributes = op_auth_rewire.__get__('getRecordAttributes');
        let test_copy = clone(TEST_JSON);
        test_copy.records = null;
        let result = getRecordAttributes(test_copy);
        assert.equal(result.size, 0);
    });
});

describe(`Test getAttributeRestrictions`, function () {
    it('Nominal case, valid JSON with attributes in the role.', function () {
        let getAttributeRestrictions = op_auth_rewire.__get__('getAttributeRestrictions');
        let test_copy = clone(TEST_JSON);
        let perms = clone(PERMISSION_BASE);
        perms.dev.tables.dog.insert = true;
        let att_base = clone(ATTRIBUTE_RESTRICTION_BASE);
        att_base.attribute_restrictions[0].insert = false;
        perms.dev.tables.dog.attribute_restrictions.push(att_base.attribute_restrictions[0]);
        test_copy.hdb_user.role.permission = perms;
        let result = getAttributeRestrictions(test_copy.hdb_user, 'dev', 'dog');
        assert.equal(result.size, 1);
        assert.equal(result.get('name').attribute_name,'name');
    });
    it('invalid JSON, Expect zero length Map returned ', function () {
        let getAttributeRestrictions = op_auth_rewire.__get__('getAttributeRestrictions');
        let result = getAttributeRestrictions(null);
        assert.equal(result.size, 0);
    });
    it('JSON with no restrictions in the role. Expect false ', function () {
        let getAttributeRestrictions = op_auth_rewire.__get__('getAttributeRestrictions');
        let test_copy = clone(TEST_JSON);
        // Leaving this manual definition of the JSON to omit attribute_restrictions
        let perms = {
            "super_user": false,
            "dev": {
                "tables": {
                    "dog": {
                        "read": false,
                        "insert": true,
                        "update": false,
                        "delete": false
                    }
                }
            },
        };
        test_copy.hdb_user.role.permission = perms;
        let result = getAttributeRestrictions(test_copy.hdb_user);
        assert.equal(result.size, 0);
    });
    it('JSON with super user. Expect zero length back ', function () {
        let getAttributeRestrictions = op_auth_rewire.__get__('getAttributeRestrictions');
        let test_copy = clone(TEST_JSON);
        // Leaving this manual definition of the JSON to omit attribute_restrictions
        let perms = {
            "super_user": true,
            "dev": {
                "tables": {
                    "dog": {
                        "read": false,
                        "insert": true,
                        "update": false,
                        "delete": false
                    }
                }
            },
        };
        test_copy.hdb_user.role.permission = perms;
        let result = getAttributeRestrictions(test_copy.hdb_user);
        assert.equal(result.size, 0);
    });
});
describe(`Test hasPermissions`, function () {
    let test_map = new Map();
    test_map.set('dev',['dog']);

    it('Test invalid parameter', function () {
        let hasPermissions = op_auth_rewire.__get__('hasPermissions');
        assert.throws(function() {hasPermissions(null, write.insertCB.name, new Map());}, Error);
    });

    it('Test nominal path, insert required.  Expect true', function () {
        let hasPermissions = op_auth_rewire.__get__('hasPermissions');
        let test_copy = clone(TEST_JSON);
        let perms = {
            "super_user": false,
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
        assert.equal(hasPermissions(test_copy.hdb_user, write.insertCB.name, test_map), true);
    });

    it('Test insert required but missing from perms.  Expect false.', function () {
        let hasPermissions = op_auth_rewire.__get__('hasPermissions');
        let test_copy = clone(TEST_JSON);
        let perms = {
            "super_user": false,
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
        assert.equal(hasPermissions(test_copy.hdb_user, write.insertCB.name, test_map), false);
    });
});