"use strict";
const test_utils = require('../test_utils');
test_utils.preTestPrep();
const assert = require('assert');
const rewire = require('rewire');
const auth = rewire('../../security/auth');
const password_function = require('../../utility/password');

const VALID_ROLE = {
    "permission": {
        "super_user": true
    },
    "id": "c7035e09-5f5b-43b1-8ba9-c945f8c9da35",
    "role": "super_user"
};

global.hdb_users = [
    {
        username: 'nook',
        active: true,
        password: password_function.hash('1234!'),
        role: VALID_ROLE
    },
    {
        username: 'unactivenook',
        active: false,
        password: password_function.hash('1234!'),
        role: VALID_ROLE
    }
];

let active_basic_request = {
    headers: {
        authorization: 'Basic ' + Buffer.from("nook:1234!").toString('base64')
    }
}

let invalid_password_basic_request = {
    headers: {
        authorization: 'Basic ' + Buffer.from("nook:1234").toString('base64')
    }
}

let unactive_basic_request = {
    headers: {
        authorization: 'Basic ' + Buffer.from("unactivenook:1234!").toString('base64')

    }
}

let invalid_basic_user = {
    headers: {
        authorization: 'Basic ' + Buffer.from("nonook:1234").toString('base64')
    }
}

let active_other_request = {
    body: {
        username: 'nook',
        password: '1234!'
    }
}

let invalid_password_other_request = {
    body: {
        username: 'nook',
        password: '1234'
    }
}

let unactive_other_request = {
    body: {
        username: 'unactivenook',
        password: '1234!'
    }
}

let invalid_other_user = {
    body: {
        username: 'nouser',
        password: '1234!'
    }
}


describe('Test authorize function', function () {
    it('Cannot complete request Basic authorization: User not found ', function (done) {
        auth.authorize(invalid_basic_user, null, function (err, user) {            
            assert.equal(err, "Cannot complete request: User 'nonook' not found", "Cannot complete request: User 'nonook' not found");
            done();
        });
    });

    it('Cannot complete request Basic authorization: User is inactive', function (done) {
        auth.authorize(unactive_basic_request, null, function (err, user) {
            assert.equal(err, "Cannot complete request: User is inactive", 'Cannot complete request: User is inactive');
            done();
        });
    });

    it('Cannot complete request Basic authorization:  Invalid password', function (done) {
        auth.authorize(invalid_password_basic_request, null, function (err, user) {
            assert.equal(err, 'Cannot complete request:  Invalid password', 'Cannot complete request:  Invalid password');
            done();
        });
    });

    it('Can authorize with correct username and password Basic authorization', function (done) {
        auth.authorize(active_basic_request, null, function (err, user) {
            let role_temp = test_utils.deepClone(VALID_ROLE);
            let temp_append = auth.__get__('appendSystemTablesToRole');
            temp_append(role_temp);
            assert.deepEqual(user, { username: 'nook', active: true, role: role_temp }, 'equal object');
            assert.equal(err, null, 'no error');
            done();
        });
    });


    //other authorization
    it('Cannot complete request Other authorization: User not found ', function (done) {
        auth.authorize(invalid_other_user, null, function (err, user) {            
            assert.equal(err, "Cannot complete request: User 'nouser' not found", "Cannot complete request: User 'nouser' not found");
            done();
        });
    });

    it('Cannot complete request Other authorization: User is inactive', function (done) {
        auth.authorize(unactive_other_request, null, function (err, user) {
            assert.equal(err, 'Cannot complete request: User is inactive', 'Cannot complete request: User is inactive');
            done();
        });
    });

    it('Cannot complete request Other authorization:  Invalid password', function (done) {
        auth.authorize(invalid_password_other_request, null, function (err, user) {
            assert.equal(err, 'Cannot complete request:  Invalid password', 'Cannot complete request:  Invalid password');
            done();
        });
    });

    it('Can authorize with correct username and password Other authorization', function (done) {
        auth.authorize(active_other_request, null, function (err, user) {
            let role_temp = test_utils.deepClone(VALID_ROLE);
            let temp_append = auth.__get__('appendSystemTablesToRole');
            temp_append(role_temp);
            assert.deepEqual(user, { username: 'nook', active: true, role: role_temp }, 'equal object');
            assert.equal(err, null, 'no error');
            done();
        });
    });
});


let check_permission_empty_object = {
    user: {
    },
    schema: {
    },
    table: {
    }

}
let no_schema_user = {
    role: {
        permission: JSON.stringify({
            super_user: false,
        })
    }
}

let no_table_user = {
    role: {
        permission: JSON.stringify({
            super_user: false,
            dev: {
                tables: {
                }
            }
        })
    }
}

let no_insert_permission_user = {
    role: {
        permission: JSON.stringify({
            super_user: false,
            dev: {
                tables: {
                    dog: {
                        // insert: false
                    }
                }
            }
        })
    }
}

let missing_attribute_user = {
    role: {
        permission: JSON.stringify({
            super_user: false,
            dev: {
                tables: {
                    dog: {
                        insert: true,
                        read: true,
                        attribute_restrictions: [
                        ]
                    }
                }
            }
        })
    }
}

let attribute_read_all_false_user = {
    role: {
        permission: JSON.stringify({
            super_user: false,
            dev: {
                tables: {
                    dog: {
                        insert: true,
                        read: true,
                        attribute_restrictions: [
                            {
                                attribute_name: "name",
                                read: false
                            },
                            {
                                attribute_name: "id",
                                read: false
                            }
                        ]
                    }
                }
            }
        })
    }
}

let attribute_read_some_false_user = {
    role: {
        permission: JSON.stringify({
            super_user: false,
            dev: {
                tables: {
                    dog: {
                        insert: true,
                        read: true,
                        attribute_restrictions: [
                            {
                                attribute_name: "name",
                                insert: true
                            },
                            {
                                attribute_name: "id",
                                insert: false
                            }
                        ]
                    }
                }
            }
        })
    }
}

let user = {
    role: {
        permission: JSON.stringify({
            super_user: false,
            dev: {
                tables: {
                    dog: {
                        insert: true,
                        read: true,
                        attribute_restrictions: [
                            {
                                attribute_name: "name",
                                "insert": true,
                            },
                            {
                                attribute_name: "id",
                                "insert": true,
                            }
                        ]
                    }
                }
            }
        })
    }
}

let no_restrict_attribute_user = {
    role: {
        permission: JSON.stringify({
            super_user: false,
            dev: {
                tables: {
                    dog: {
                        insert: true,
                        read: true                        
                    }
                }
            }
        })
    }
}

let check_permission_no_attributes_object = {
    schema: "dev",
    table: "dog",
    operation: "insert",
    attributes: false
}

let check_permission_object = {

    schema: "dev",
    table: "dog",
    operation: "insert",
    attributes: [
        "name",
        "id"
    ]
}

let super_user = {
    role: {
        permission: JSON.stringify({
            super_user: true,
            dev: {
                tables: {
                    dog: {
                        insert: true,
                    }
                }
            }
        })
    }
}

let check_super_user_permission_object = {
    schema: "dev",
    table: "dog",
    operation: "insert"
}

let permission_object_no_role = {
    user: {
        role: {
        }
    },
    schema: {
        harper: {

        }
    },
    table: {
        dog: {

        }
    },
    operation: {
        insert: {
        }
    }
}

describe('Test appendSystemTablesToRole function', function () {
    it('validate permissions are added for system tables.', function (done) {
        let role_temp = test_utils.deepClone(VALID_ROLE);
        let temp_append = auth.__get__('appendSystemTablesToRole');
        temp_append(role_temp);
        assert.notEqual(role_temp.permission.system.tables, undefined, 'expected system tables to be created');
        assert.notEqual(role_temp.permission.system.tables.hdb_role, undefined, 'expected system tables to be created');
        done();
    });
});

describe('Test checkPermissions function', function () {
    it('validate permission object, should get error when object is incomplete ', function (done) {
        auth.checkPermissions(check_permission_empty_object, function (err, result) {
            assert.equal(err.message, "User can't be blank,Schema can't be blank,Table can't be blank,Operation can't be blank", 'no error');
            done();
        });
    });

    it('no permission role in object should error ', function (done) {
        auth.checkPermissions(permission_object_no_role, function (err, result) {
            assert.equal(err, 'Invalid role', 'Invalid role');
            done();
        });
    });

    it('super_user permission can authorized', function (done) {        
        check_super_user_permission_object.user = super_user;
        auth.checkPermissions(check_super_user_permission_object, function (err, result) {
            assert.equal(err, null, 'no error');
            assert.equal(result.authorized, true, "super user can has permission");
            done();
        });
    });

    it('Not authorized to access schema when no schema name', function (done) {
        check_permission_object.user = no_schema_user;
        auth.checkPermissions(check_permission_object, function (err, result) {
            assert.equal(err, null, 'no error');
            assert.equal(result.authorized, false, "Not authorized to access schema");
            done();
        });
    });

    it('Not authorized to access table when no table name', function (done) {
        check_permission_object.user = no_table_user;
        auth.checkPermissions(check_permission_object, function (err, result) {
            assert.equal(err, null, 'no error');
            assert.equal(result.authorized, false, "Not authorized to access table");
            done();
        });
    });

    it('Not authorized to insert table when tables no attribute', function (done) {
        check_permission_object.user = no_insert_permission_user;
        auth.checkPermissions(check_permission_object, function (err, result) {            
            assert.equal(err, null, 'no error');
            assert.equal(result.authorized, false, "Not authorized to insert table");
            done();
        });
    });

    it('Not authorized insert to table, missing restrict attribute ', function (done) {
        check_permission_no_attributes_object.user = missing_attribute_user;
        auth.checkPermissions(check_permission_no_attributes_object, function (err, result) {
            assert.equal(err, null, 'no error');
            assert.equal(result.authorized, false, "Not authorized insert restrict attribute to table");
            done();
        });
    });

    it('Not authorized insert restrict attribute name and id are false to table ', function (done) {
        check_permission_object.user = attribute_read_all_false_user;
        auth.checkPermissions(check_permission_object, function (err, result) {
            assert.equal(err, null, 'no error');
            assert.equal(result.authorized, false, "Not authorized restrict attribute name, id ");
            done();
        });
    });

    it('Not authorized insert restrict attribute name is ture and id is false to table ', function (done) {
        check_permission_object.user = attribute_read_some_false_user;
        auth.checkPermissions(check_permission_object, function (err, result) {
            assert.equal(err, null, 'no error');
            assert.equal(result.authorized, false, "Not authorized restrict attribute id ");
            done();
        });
    });

    it('can authorized with have restrict attribute true', function (done) {
        check_permission_object.user = user;
        auth.checkPermissions(check_permission_object, function (err, result) {
            assert.equal(err, null, 'no error');
            assert.equal(result.authorized, true, "authorized restrict attribute name, id ");
            done();
        });
    });

    it('can authorized with not have restrict attribute', function (done) {
        check_permission_object.user = no_restrict_attribute_user;
        auth.checkPermissions(check_permission_object, function (err, result) {            
            assert.equal(err, null, 'no error');
            assert.equal(result.authorized, true, "authorized with not have restrict attribute");
            done();
        });
    });
});