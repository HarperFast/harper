"use strict";

const assert = require('assert');
const sinon = require('sinon');
const auth = require('../../security/auth');
const user_functions = require('../../security/user');
const password_function = require('../../utility/password');

global.hdb_users = [
    {
        username: 'nook',
        active: true,
        password: password_function.hash('1234!'),
    },
    {
        username: 'unactivenook',
        active: false,
        password: password_function.hash('1234!'),
    }
];


let activeBasicRequest = {
    headers: {
        authorization: 'Basic ' + Buffer.from("nook:1234!").toString('base64')
    }
}

let invalidPasswordBasicRequest = {
    headers: {
        authorization: 'Basic ' + Buffer.from("nook:1234").toString('base64')
    }
}

let unactiveBasicRequest = {
    headers: {
        authorization: 'Basic ' + Buffer.from("unactivenook:1234!").toString('base64')

    }
}

let invalidBasicUser = {
    headers: {
        authorization: 'Basic ' + Buffer.from("nonook:1234").toString('base64')
    }
}

let activeOtherRequest = {
    body: {
        username: 'nook',
        password: '1234!'
    }
}

let invalidPasswordOtherRequest = {
    body: {
        username: 'nook',
        password: '1234'
    }
}

let unactiveOtherRequest = {
    body: {
        username: 'unactivenook',
        password: '1234!'
    }
}

let invalidOtherUser = {
    body: {
        username: 'nouser',
        password: '1234!'
    }
}


describe('Test authorize function', function () {
    it('Cannot complete request Basic authorization: User not found ', function (done) {
        auth.authorize(invalidBasicUser, null, function (err, user) {            
            assert.equal(err, "Cannot complete request: User 'nonook' not found", "Cannot complete request: User 'nonook' not found");
            done();
        });
    });

    it('Cannot complete request Basic authorization: User is inactive', function (done) {
        auth.authorize(unactiveBasicRequest, null, function (err, user) {
            assert.equal(err, "Cannot complete request: User is inactive", 'Cannot complete request: User is inactive');
            done();
        });
    });

    it('Cannot complete request Basic authorization:  Invalid password', function (done) {
        auth.authorize(invalidPasswordBasicRequest, null, function (err, user) {
            assert.equal(err, 'Cannot complete request:  Invalid password', 'Cannot complete request:  Invalid password');
            done();
        });
    });

    it('Can authorize with correct username and password Basic authorization', function (done) {
        auth.authorize(activeBasicRequest, null, function (err, user) {            
            assert.deepEqual(user, { username: 'nook', active: true }, 'equal object');
            assert.equal(err, null, 'no error');
            done();
        });
    });


    //other authorization
    it('Cannot complete request Other authorization: User not found ', function (done) {
        auth.authorize(invalidBasicUser, null, function (err, user) {            
            assert.equal(err, "Cannot complete request: User 'nonook' not found", "Cannot complete request: User 'nonook' not found");
            done();
        });
    });

    it('Cannot complete request Other authorization: User is inactive', function (done) {
        auth.authorize(unactiveBasicRequest, null, function (err, user) {
            assert.equal(err, 'Cannot complete request: User is inactive', 'Cannot complete request: User is inactive');
            done();
        });
    });

    it('Cannot complete request Other authorization:  Invalid password', function (done) {
        auth.authorize(invalidPasswordBasicRequest, null, function (err, user) {
            assert.equal(err, 'Cannot complete request:  Invalid password', 'Cannot complete request:  Invalid password');
            done();
        });
    });

    it('Can authorize with correct username and password Other authorization', function (done) {
        auth.authorize(activeOtherRequest, null, function (err, user) {
            assert.deepEqual(user, { username: 'nook', active: true }, 'equal object');
            assert.equal(err, null, 'no error');
            done();
        });
    });
});


let checkPermissionEmptyObject = {
    user: {
    },
    schema: {
    },
    table: {
    }

}
let noSchemaUser = {
    role: {
        permission: JSON.stringify({
            super_user: false,
        })
    }
}

let noTableUser = {
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

let noInsertPermissionUser = {
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

let missingAttributeUser = {
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

let AttributeReadAllFalseUser = {
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

let AttributeReadSomeFalseUser = {
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

let noRestrictAttributeUser = {
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

let checkPermissionNoattributesObject = {
    schema: "dev",
    table: "dog",
    operation: "insert",
    attributes: false
}

let checkPermissionObject = {

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

let checkSuper_userPermissionObject = {
    schema: "dev",
    table: "dog",
    operation: "insert"
}

let permissionObjectNoRole = {
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

describe('Test checkPermissions function', function () {
    it('validate permission object, should get error when object is incomplete ', function (done) {
        auth.checkPermissions(checkPermissionEmptyObject, function (err, result) {
            assert.equal(err.message, "User can't be blank,Schema can't be blank,Table can't be blank,Operation can't be blank", 'no error');
            done();
        });
    });

    it('no permission role in object should error ', function (done) {
        auth.checkPermissions(permissionObjectNoRole, function (err, result) {
            assert.equal(err, 'Invalid role', 'Invalid role');
            done();
        });
    });

    it('super_user permission can authorized', function (done) {        
        checkSuper_userPermissionObject.user = super_user;
        auth.checkPermissions(checkSuper_userPermissionObject, function (err, result) {
            assert.equal(err, null, 'no error');
            assert.equal(result.authorized, true, "super user can has permission");
            done();
        });
    });

    it('Not authorized to access schema when no schema name', function (done) {
        checkPermissionObject.user = noSchemaUser;
        auth.checkPermissions(checkPermissionObject, function (err, result) {
            assert.equal(err, null, 'no error');
            assert.equal(result.authorized, false, "Not authorized to access schema");
            done();
        });
    });

    it('Not authorized to access table when no table name', function (done) {
        checkPermissionObject.user = noTableUser;
        auth.checkPermissions(checkPermissionObject, function (err, result) {
            assert.equal(err, null, 'no error');
            assert.equal(result.authorized, false, "Not authorized to access table");
            done();
        });
    });

    it('Not authorized to insert table when tables no attribute', function (done) {
        checkPermissionObject.user = noInsertPermissionUser;
        auth.checkPermissions(checkPermissionObject, function (err, result) {            
            assert.equal(err, null, 'no error');
            assert.equal(result.authorized, false, "Not authorized to insert table");
            done();
        });
    });

    it('Not authorized insert to table, missing restrict attribute ', function (done) {
        checkPermissionNoattributesObject.user = missingAttributeUser;
        auth.checkPermissions(checkPermissionNoattributesObject, function (err, result) {
            assert.equal(err, null, 'no error');
            assert.equal(result.authorized, false, "Not authorized insert restrict attribute to table");
            done();
        });
    });

    it('Not authorized insert restrict attribute name and id are false to table ', function (done) {
        checkPermissionObject.user = AttributeReadAllFalseUser;
        auth.checkPermissions(checkPermissionObject, function (err, result) {
            assert.equal(err, null, 'no error');
            assert.equal(result.authorized, false, "Not authorized restrict attribute name, id ");
            done();
        });
    });

    it('Not authorized insert restrict attribute name is ture and id is false to table ', function (done) {
        checkPermissionObject.user = AttributeReadSomeFalseUser;
        auth.checkPermissions(checkPermissionObject, function (err, result) {
            assert.equal(err, null, 'no error');
            assert.equal(result.authorized, false, "Not authorized restrict attribute id ");
            done();
        });
    });

    it('can authorized with have restrict attribute true', function (done) {
        checkPermissionObject.user = user;
        auth.checkPermissions(checkPermissionObject, function (err, result) {
            assert.equal(err, null, 'no error');
            assert.equal(result.authorized, true, "authorized restrict attribute name, id ");
            done();
        });
    });

    it('can authorized with not have restrict attribute', function (done) {
        checkPermissionObject.user = noRestrictAttributeUser;
        auth.checkPermissions(checkPermissionObject, function (err, result) {            
            assert.equal(err, null, 'no error');
            assert.equal(result.authorized, true, "authorized with not have restrict attribute");
            done();
        });
    });
        
});