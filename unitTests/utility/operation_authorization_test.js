"use strict";
/**
 * Test the operation_authorization module.
 */
const test_utils = require('../test_utils');
test_utils.preTestPrep();
const assert = require('assert');
const rewire = require('rewire');
const op_auth = require('../../utility/operation_authorization');
const op_auth_rewire = rewire('../../utility/operation_authorization');
const Permission_rw = op_auth_rewire.__get__('permission');
const write = require('../../data_layer/insert');
const user = require('../../security/user');
const alasql = require('alasql');
const search = require('../../data_layer/search');
const jobs = require('../../server/jobs');

const test_terms = test_utils.COMMON_TEST_TERMS
const crud_keys = test_terms.TEST_CRUD_PERM_KEYS;

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
};

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

let TEST_ATTRIBUTES = ['name', 'breed', 'id', 'age'];
let RESTRICTED_ATTRIBUTES = ['breed', 'age'];
let RESTRICTED_ATTRIBUTES_2 = ['name', 'id'];
let AFFECTED_ATTRIBUTES_SET = new Set(TEST_ATTRIBUTES);

let ROLE_RESTRICTION_KEY = 'name';

function generateAttrPerms(crud_key, crud_value) {
    const attr_perms = {
        "read": false,
        "insert": true,
        "update": false,
        "delete": false
    };
    if (crud_key) {
        attr_perms[crud_key] = crud_value;
    }
    return attr_perms
}

let ATTRIBUTE_RESTRICTION_BASE = (attrs, crud_key, crud_value) => {
    const final_attribute_restrictions = [];
    attrs.forEach(attr => {
        const attr_perms = generateAttrPerms(crud_key, crud_value);
        final_attribute_restrictions.push({
            attribute_name: attr,
            ...attr_perms
        })
    })
    return final_attribute_restrictions;
};

const DEFAULT_ATTRIBUTE_RESTRICTION_BASE = () => ATTRIBUTE_RESTRICTION_BASE([ROLE_RESTRICTION_KEY]);

let ROLE_ATTRIBUTE_RESTRICTIONS = new Map();
ROLE_ATTRIBUTE_RESTRICTIONS.set(ROLE_RESTRICTION_KEY, DEFAULT_ATTRIBUTE_RESTRICTION_BASE);

const test_attrs = [];
AFFECTED_ATTRIBUTES_SET.forEach(attr => test_attrs.push({ attribute: attr }));

/*
    This is a simple, naive clone implementation.  It should never, ever! be used in prod.
 */
function clone(a) {
    return JSON.parse(JSON.stringify(a));
};

let roleUpdatedTimeCounter = 12345;
function getRequestJson(req_obj) {
    const final_req_obj = clone(req_obj);
    final_req_obj.hdb_user.role.__updatedtime__ = roleUpdatedTimeCounter += 1;
    return final_req_obj;
}

describe('Test operation_authorization', function() {
    before(() => {
        global.hdb_schema = {
            [TEST_JSON.schema]: {
                [TEST_JSON.table]: {
                    hash_attribute: 'id',
                    attributes: [...test_attrs]
                }
            }
        };
    });

    after(() => {
        global.hdb_schema = undefined;
    });

    describe(`Test verifyPermsAst`, function () {
        it('NOMINAL, test verify with proper syntax, expect true', function () {
            let test_json = clone(TEST_INSERT_JSON);
            let temp_insert = new alasql.yy.Insert(test_json);
            let req_json = getRequestJson(TEST_JSON);
            req_json.hdb_user.role.permission.dev.tables.dog.insert = true;
            let att_base = DEFAULT_ATTRIBUTE_RESTRICTION_BASE;
            req_json.hdb_user.role.permission.dev.tables.dog.attribute_restrictions = att_base;
            let result = op_auth_rewire.verifyPermsAst(temp_insert, req_json.hdb_user, write.insert.name);
            assert.equal(result.length, 0);
        });

        it('Test verify AST with no insert perm, expect false', function () {
            let test_json = clone(TEST_INSERT_JSON);
            let temp_insert = new alasql.yy.Insert(test_json);
            let req_json = getRequestJson(TEST_JSON);
            req_json.hdb_user.role.permission.dev.tables.dog.insert = false;
            let result = op_auth_rewire.verifyPermsAst(temp_insert, req_json.hdb_user, write.insert.name);
            assert.equal(result.length, 1);
        });

        it('Test verify AST with role insert perm false, expect false', function () {
            let test_json = clone(TEST_INSERT_JSON);
            let temp_insert = new alasql.yy.Insert(test_json);
            let req_json = getRequestJson(TEST_JSON);
            req_json.hdb_user.role.permission.dev.tables.dog.insert = true;
            let att_base = DEFAULT_ATTRIBUTE_RESTRICTION_BASE();
            att_base[0].insert = false;
            req_json.hdb_user.role.permission.dev.tables.dog.attribute_restrictions = att_base;
            let result = op_auth_rewire.verifyPermsAst(temp_insert, req_json.hdb_user, write.insert.name);
            assert.equal(result.length, 2);
            result.forEach(perms_obj => {
                assert.equal(RESTRICTED_ATTRIBUTES_2.includes(perms_obj.required_attribute_permissions[0].attribute_name), true);
                assert.equal(perms_obj.required_attribute_permissions[0].required_permissions[0], test_terms.TEST_CRUD_PERM_KEYS.INSERT);
            })
        });

        it('Test with bad operations, expect false', function () {
            let test_json = clone(TEST_INSERT_JSON);
            let temp_insert = new alasql.yy.Insert(test_json);
            let req_json = getRequestJson(TEST_JSON);
            req_json.hdb_user.role.permission.dev.tables.dog.insert = true;
            let att_base = ATTRIBUTE_RESTRICTION_BASE([]);
            req_json.hdb_user.role.permission.dev.tables.dog.attribute_restrictions = att_base;
            assert.throws(function () {
                op_auth_rewire.verifyPermsAst(temp_insert, req_json.hdb_user, 'fart');
            }, Error);
        });

        it(`Test select wildcard with proper perms, expect true`, function () {
            let test_json = clone(TEST_SELECT_WILDCARD_JSON);
            let temp_select = new alasql.yy.Select(test_json);
            let req_json = getRequestJson(TEST_JSON);
            req_json.hdb_user.role.permission.dev.tables.dog.read = true;
            let att_base = DEFAULT_ATTRIBUTE_RESTRICTION_BASE();
            att_base[0].read = true;
            req_json.hdb_user.role.permission.dev.tables.dog.attribute_restrictions = att_base;
            let result = op_auth_rewire.verifyPermsAst(temp_select, req_json.hdb_user, search.search.name);
            assert.equal(result.length, 0);
        });

        it(`Test select wildcard with read attribute restriction false, expect false`, function () {
            let test_json = clone(TEST_SELECT_WILDCARD_JSON);
            let temp_select = new alasql.yy.Select(test_json);
            let req_json = getRequestJson(TEST_JSON);
            req_json.hdb_user.role.permission.dev.tables.dog.read = true;
            let att_base = DEFAULT_ATTRIBUTE_RESTRICTION_BASE();
            req_json.hdb_user.role.permission.dev.tables.dog.attribute_restrictions = att_base;
            let result = op_auth_rewire.verifyPermsAst(temp_select, req_json.hdb_user, search.search.name);
            assert.equal(result.length, 4);
            result.forEach(perms_obj => {
                assert.equal(TEST_ATTRIBUTES.includes(perms_obj.required_attribute_permissions[0].attribute_name), true);
                assert.equal(perms_obj.required_attribute_permissions[0].required_permissions[0], test_terms.TEST_CRUD_PERM_KEYS.READ);
            })
        });

        it('Test select wildcard with one attribute permission true, expect true', () => {
            let test_json = clone(TEST_SELECT_WILDCARD_JSON);
            let temp_select = new alasql.yy.Select(test_json);
            let req_json = getRequestJson(TEST_JSON);
            req_json.hdb_user.role.permission.dev.tables.dog.read = true;
            let att_base = ATTRIBUTE_RESTRICTION_BASE([ROLE_RESTRICTION_KEY], crud_keys.READ, true);
            req_json.hdb_user.role.permission.dev.tables.dog.attribute_restrictions = att_base;
            let result = op_auth_rewire.verifyPermsAst(temp_select, req_json.hdb_user, search.search.name);
            assert.equal(result.length, 0);
        })
    });

    describe(`Test verifyPerms`, function () {
        it('Pass in bad values, expect false', function () {
            let result = op_auth.verifyPerms(null, null);
            assert.equal(result.length, 1);
        });

        it('Check return if user has su.  Expect true', function () {
            let result = op_auth.verifyPerms(TEST_JSON_SUPER_USER, write.insert.name);
            assert.equal(result.length, 0);
        });

        it('Pass function instead of function name.  Expect empty array (no errors)', function () {
            let result = op_auth.verifyPerms(TEST_JSON, write.insert);
            assert.deepEqual(result, []);
        });

        it('Pass function name instead of function.  Expect empty array (no errors)', function () {
            assert.deepEqual(op_auth.verifyPerms(TEST_JSON, write.insert.name), []);
        });

        it('Pass in JSON with no schemas restrictions defined, expect table permissions error', function () {
            let req_json = getRequestJson(TEST_JSON);
            req_json.hdb_user.role.permission = EMPTY_PERMISSION;
            const restrictions = op_auth.verifyPerms(req_json, write.insert.name);
            assert.equal(restrictions.length, 1);
        });

        it('Pass in JSON with schemas but no tables defined, expect perms errors', function () {
            let req_json = getRequestJson(TEST_JSON);
            let perms = {
                "super_user": false,
                "dev": {
                    "tables": {}
                },
                "test": {
                    "tables": {}
                }
            };
            req_json.hdb_user.role.permission = perms;
            const restrictions = op_auth.verifyPerms(req_json, write.insert.name)
            assert.equal(restrictions.length,1);
            assert.equal(restrictions[0].required_table_permissions[0], test_terms.TEST_CRUD_PERM_KEYS.INSERT)
        });

        it('Pass in JSON with schemas and table dog defined, insert not allowed, expect table restriction result', function () {
            let req_json = getRequestJson(TEST_JSON);
            let perms = clone(PERMISSION_BASE);
            perms["dev"].tables["dog"].insert = false;
            req_json.hdb_user.role.permission = perms;
            let restrictions = op_auth_rewire.verifyPerms(req_json, write.insert.name);
            assert.equal(restrictions.length, 1);
            assert.equal(restrictions[0].required_table_permissions[0], test_terms.TEST_CRUD_PERM_KEYS.INSERT);
        });

        it('(NOMINAL) - Pass in JSON with schemas and table dog defined, insert allowed, expect true', function () {
            let req_json = getRequestJson(TEST_JSON);
            let perms = clone(PERMISSION_BASE);
            perms.dev.tables.dog.insert = true;
            let att_base = ATTRIBUTE_RESTRICTION_BASE(TEST_ATTRIBUTES, crud_keys.INSERT, true);
            perms.dev.tables.dog.attribute_restrictions = att_base;
            req_json.hdb_user.role.permission = perms;
            let restrictions = op_auth_rewire.verifyPerms(req_json, write.insert.name);
            assert.deepEqual(restrictions, []);
        });

        it('Pass in JSON with schemas and table dog defined, insert allowed, attr insert restriction false. expect false', function () {
            let req_json = getRequestJson(TEST_JSON);
            let perms = clone(PERMISSION_BASE);
            perms.dev.tables.dog.insert = true;
            let att_base = ATTRIBUTE_RESTRICTION_BASE([ROLE_RESTRICTION_KEY], crud_keys.INSERT, false);
            att_base[0].insert = true;
            perms.dev.tables.dog.attribute_restrictions = att_base;
            req_json.hdb_user.role.permission = perms;
            let result = op_auth_rewire.verifyPerms(req_json, write.insert.name);
            assert.equal(result.length, 2);
        });

        it('Pass in get_job request as non-super user. expect true', function () {
            let test_json = {
                operation: "get_job",
                id: "1234",
                hdb_user: getRequestJson(TEST_JSON).hdb_user
            };
            assert.deepEqual(op_auth.verifyPerms(test_json, jobs.handleGetJob.name), []);
        });

        it('Pass in search_jobs_by_start_date request as super user. expect true', function () {
            let test_json = {
                operation: "search_jobs_by_start_date",
                id: "1234",
                hdb_user: getRequestJson(TEST_JSON_SUPER_USER).hdb_user
            };
            assert.deepEqual(op_auth_rewire.verifyPerms(test_json, jobs.handleGetJobsByStartDate.name), []);
        });

        it('Pass in search_jobs_by_start_date request as non-super user. expect false', function () {
            let test_json = {
                operation: "search_jobs_by_start_date",
                id: "1234",
                hdb_user: getRequestJson(TEST_JSON).hdb_user
            };
            let result = op_auth_rewire.verifyPerms(test_json, jobs.handleGetJobsByStartDate.name)
            assert.strictEqual(result.length, 1);
        });

        it('Pass in get_job request as super user. expect true', function () {
            let test_json = {
                operation: "get_job",
                id: "1234",
                hdb_user: getRequestJson(TEST_JSON_SUPER_USER).hdb_user
            };
            assert.deepEqual(op_auth_rewire.verifyPerms(test_json, jobs.handleGetJob.name), []);
        });

        it('Test operation with read & insert required, but user only has insert.  False expected', function () {
            let required_permissions = op_auth_rewire.__get__('required_permissions');
            required_permissions.set('test method', new Permission_rw(false, ['insert', 'read']));
            op_auth_rewire.__set__('required_permissions', required_permissions);
            let req_json = getRequestJson(TEST_JSON);
            let perms = clone(PERMISSION_BASE);
            req_json.hdb_user.role.permission = perms;
            let result = op_auth_rewire.verifyPerms(req_json, 'test method');
            assert.strictEqual(result.length, 1);
        });

        it('Test bad method.  False expected', function () {
            let req_json = getRequestJson(TEST_JSON);
            let perms = clone(PERMISSION_BASE);
            perms.dev.tables.dog.insert = true;
            req_json.hdb_user.role.permission = perms;
            let result = op_auth_rewire.verifyPerms(req_json, 'bad method');
            assert.equal(result.length, 1);
        });

        it('Test bad permission name.  False expected', function () {
            let req_json = getRequestJson(TEST_JSON);
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
            req_json.hdb_user.role.permission = perms;
            let result = op_auth_rewire.verifyPerms(req_json, write.insert.name);
            assert.strictEqual(result.length, 1);
        });

        it('NOMINAL - Pass in JSON with su, function that requires su.  Expect true.', function () {
            let req_json = getRequestJson(TEST_JSON);
            let perms = clone(PERMISSION_BASE);
            perms.super_user = true;
            perms.dev.tables.dog.insert = true;
            req_json.hdb_user.role.permission = perms;
            let result = op_auth_rewire.verifyPerms(req_json, user.addUser);
            assert.strictEqual(result.length, 0);
        });

        it('Pass in JSON with no su, function that requires su.  Expect false.', function () {
            let req_json = getRequestJson(TEST_JSON);
            let perms = clone(PERMISSION_BASE);
            perms.dev.tables.dog.insert = true;
            req_json.hdb_user.role.permission = perms;
            let result = op_auth_rewire.verifyPerms(req_json, user.addUser);
            assert.strictEqual(result.length, 1);
        });
    });

    describe(`Test checkAttributePerms`, function () {
        it('Nominal path - Pass in JSON with insert attribute required.  Expect true.', function () {
            let checkAttributePerms = op_auth_rewire.__get__('checkAttributePerms');
            let result = checkAttributePerms(AFFECTED_ATTRIBUTES_SET, ROLE_ATTRIBUTE_RESTRICTIONS, write.insert.name);
            assert.equal(result.length, 0);
        });

        it('Pass in JSON with insert attribute required, but role does not have insert perm.  Expect false.', function () {
            let checkAttributePerms = op_auth_rewire.__get__('checkAttributePerms');
            let role_att = new Map(ROLE_ATTRIBUTE_RESTRICTIONS);
            role_att.get(ROLE_RESTRICTION_KEY).insert = false;
            let result = checkAttributePerms(AFFECTED_ATTRIBUTES_SET, role_att, write.insert.name);
            assert.equal(result.length, 1);
        });

        it('Pass invalid operation.  Expect false.', function () {
            let checkAttributePerms = op_auth_rewire.__get__('checkAttributePerms');
            assert.throws(function () {
                checkAttributePerms(AFFECTED_ATTRIBUTES_SET, ROLE_ATTRIBUTE_RESTRICTIONS, 'derp');
            }, Error);
        });

        it('Pass invalid json.  Expect false.', function () {
            let checkAttributePerms = op_auth_rewire.__get__('checkAttributePerms');
            assert.throws(function () {
                checkAttributePerms(null, null, write.insert.name);
            }, Error);
        });
    });

    describe(`Test getRecordAttributes`, function () {
        it('Nominal case, valid JSON with attributes.  Expect set with size of 4', function () {
            let getRecordAttributes = op_auth_rewire.__get__('getRecordAttributes');
            let req_json = getRequestJson(TEST_JSON);
            let result = getRecordAttributes(req_json);
            assert.equal(result.size, 4);
        });

        it('pass invalid JSON with attributes.  Expect empty set.', function () {
            let getRecordAttributes = op_auth_rewire.__get__('getRecordAttributes');
            let result = getRecordAttributes(null);
            assert.equal(result.size, 0);
        });

        it('Nominal case pass JSON with no records.  Expect empty set.', function () {
            let getRecordAttributes = op_auth_rewire.__get__('getRecordAttributes');
            let req_json = getRequestJson(TEST_JSON);
            req_json.records = null;
            let result = getRecordAttributes(req_json);
            assert.equal(result.size, 0);
        });
    });

    describe(`Test getAttributeRestrictions`, function () {
        it('Nominal case, valid JSON with attributes in the role.', function () {
            let getAttributeRestrictions = op_auth_rewire.__get__('getAttributeRestrictions');
            let req_json = getRequestJson(TEST_JSON);
            let perms = clone(PERMISSION_BASE);
            perms.dev.tables.dog.insert = true;
            let att_base = ATTRIBUTE_RESTRICTION_BASE([ROLE_RESTRICTION_KEY], crud_keys.INSERT, false);
            perms.dev.tables.dog.attribute_restrictions = att_base;
            req_json.hdb_user.role.permission = perms;
            let result = getAttributeRestrictions(req_json.hdb_user, 'dev', 'dog');
            assert.equal(result.size, 1);
            assert.equal(result.get('name').attribute_name, 'name');
        });

        it('invalid JSON, Expect zero length Map returned ', function () {
            let getAttributeRestrictions = op_auth_rewire.__get__('getAttributeRestrictions');
            let result = getAttributeRestrictions(null);
            assert.equal(result.size, 0);
        });

        it('JSON with no restrictions in the role. Expect false ', function () {
            let getAttributeRestrictions = op_auth_rewire.__get__('getAttributeRestrictions');
            let req_json = getRequestJson(TEST_JSON);
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
            req_json.hdb_user.role.permission = perms;
            let result = getAttributeRestrictions(req_json.hdb_user);
            assert.equal(result.size, 0);
        });

        it('JSON with super user. Expect zero length back ', function () {
            let getAttributeRestrictions = op_auth_rewire.__get__('getAttributeRestrictions');
            let req_json = getRequestJson(TEST_JSON);
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
            req_json.hdb_user.role.permission = perms;
            let result = getAttributeRestrictions(req_json.hdb_user);
            assert.equal(result.size, 0);
        });
    });

    describe(`Test hasPermissions`, function () {
        let test_map = new Map();
        test_map.set('dev', ['dog']);

        it('Test invalid parameter', function () {
            let hasPermissions = op_auth_rewire.__get__('hasPermissions');
            assert.throws(function () {
                hasPermissions(null, write.insert.name, new Map());
            }, Error);
        });

        it('Test nominal path, insert required.  Expect true', function () {
            let hasPermissions = op_auth_rewire.__get__('hasPermissions');
            let req_json = getRequestJson(TEST_JSON);
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
            req_json.hdb_user.role.permission = perms;
            let result = hasPermissions(req_json.hdb_user, write.insert.name, test_map);
            assert.equal(result.length, 0);
        });

        it('Test insert required but missing from perms.  Expect false.', function () {
            let hasPermissions = op_auth_rewire.__get__('hasPermissions');
            let req_json = getRequestJson(TEST_JSON);
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
            req_json.hdb_user.role.permission = perms;
            let result = hasPermissions(req_json.hdb_user, write.insert.name, test_map);
            assert.equal(result.length, 1);
        });
    });
});
