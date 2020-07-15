"use strict";

const chai = require('chai');
const sinon = require('sinon');
const { expect } = chai;

const rewire = require('rewire');
const clonedeep = require('lodash.clonedeep');
const permissionsTranslator_rw = rewire('../../security/permissionsTranslator');
const { TEST_NON_SU_ROLE, TEST_SCHEMA_DOG_BREED } = require('../test_data');
const terms = require('../../utility/hdbTerms');

const TEST_SCHEMA = 'dev';
const TEST_PERMS_ENUM = {
    READ: 'read',
    INSERT: 'insert',
    UPDATE: 'update',
    DELETE: 'delete'
};

const createTablePermsObj = (read_perm = true, insert_perm = true, update_perm = true, delete_perm = true) => ({
    ...createPermsObj(read_perm, insert_perm, update_perm, delete_perm),
    attribute_restrictions: []
});

const createAttrPermission = (attr_name, perms = {read: true, insert: true, update: true, delete: true }) => ({
    attribute_name: attr_name,
    ...perms
});

const createPermsObj = (read_perm, insert_perm, update_perm, delete_perm) => ({
    read: read_perm,
    insert: insert_perm,
    update: update_perm,
    delete: delete_perm
});

const getUpdatedRoleObj = () => {
    const test_role = clonedeep(TEST_NON_SU_ROLE);
    test_role.__updatedtime__ = Math.random() * 10000;
    return test_role;
};

const validateTablePerms = (final_perms, initial_perms) => {
    Object.values(TEST_PERMS_ENUM).forEach(key => {
        if (!initial_perms) {
            //if there are no initial perms for table in role, all table perms should be set to false
            if (final_perms[key]) {
                return false;
            }
        } else {
            //if there are perms for table in role, the final perms should match
            if (final_perms[key] !== initial_perms[key]) {
                return false;
            }
        }
    });
    return true;
};

const validateAttrPerms = (final_perms, initial_perms) => {
    if (!initial_perms || initial_perms.attribute_restrictions.length === 0) {
        if (final_perms.length !== 0) {
            return false;
        };
    } else {
        const initial_perms_map = initial_perms.attribute_restrictions.reduce((acc, perm_obj) => {
            acc[perm_obj.attribute_name] = perm_obj;
            return acc;
        }, {});
        final_perms.forEach(final_perm => {
            if (!!initial_perms_map[final_perm.attribute_restrictions]) {
                if (initial_perms_map[final_perm.attribute_restrictions] !== final_perm) {
                    return false
                }
            }  else {
                Object.values(TEST_PERMS_ENUM).forEach(key => {
                    if (final_perm[key]) {
                        return false;
                    }
                })
            }
        })
    }
    return true;
};

const sandbox = sinon.createSandbox();
const translateRolePerms_rw =  permissionsTranslator_rw.__get__('translateRolePermissions');
const translateRolePerms_spy =  sandbox.spy(translateRolePerms_rw);
permissionsTranslator_rw.__set__('translateRolePermissions', translateRolePerms_spy);

describe('Test permissionsTranslator module', function () {
    before(() => {
        global.hdb_schema = clonedeep(TEST_SCHEMA_DOG_BREED);
    });
    afterEach(() => {
        sandbox.resetHistory();
        permissionsTranslator_rw.__set__('translateRolePermissions', translateRolePerms_spy);
    });
    after(() => {
        global.hdb_schema = null;
        rewire('../../security/permissionsTranslator');
    });

    describe('Test getRolePermissions method - translation cases', () => {
        it('All true table perms passed with one attribute_permissions object mixed values',() => {
            const test_role = getUpdatedRoleObj();
            delete test_role.permission[TEST_SCHEMA].tables.breed;

            const test_attr = 'owner_id';
            const test_attr_perm = createAttrPermission(test_attr, createPermsObj(true, false, false, true));
            test_role.permission[TEST_SCHEMA].tables.dog.attribute_restrictions.push(test_attr_perm);

            const test_result = permissionsTranslator_rw.getRolePermissions(test_role);
            expect(test_result[TEST_SCHEMA].describe).to.be.true;
            expect(test_result.super_user).to.deep.equal(test_role.permission.super_user);
            expect(test_result.system).to.deep.equal(test_role.permission.system);
            Object.keys(test_result[TEST_SCHEMA].tables).forEach(table => {
                expect(validateTablePerms(test_result[TEST_SCHEMA].tables[table], test_role.permission[TEST_SCHEMA].tables[table])).to.be.true;
                expect(validateAttrPerms(test_result[TEST_SCHEMA].tables[table].attribute_restrictions, test_role.permission[TEST_SCHEMA].tables[table])).to.be.true;
            })
        });

        it('All true table perms passed with one attribute_permissions object all true',() => {
            const test_role = getUpdatedRoleObj();
            delete test_role.permission[TEST_SCHEMA].tables.breed;

            const test_attr = 'owner_id';
            const test_attr_perm = createAttrPermission(test_attr)
            test_role.permission[TEST_SCHEMA].tables.dog.attribute_restrictions.push(test_attr_perm);

            const test_result = permissionsTranslator_rw.getRolePermissions(test_role);
            expect(test_result[TEST_SCHEMA].describe).to.be.true;
            expect(test_result.super_user).to.deep.equal(test_role.permission.super_user);
            expect(test_result.system).to.deep.equal(test_role.permission.system);
            Object.keys(test_result[TEST_SCHEMA].tables).forEach(table => {
                expect(validateTablePerms(table, test_role.permission[TEST_SCHEMA].tables[table])).to.be.true;
                expect(validateAttrPerms(test_result[TEST_SCHEMA].tables[table].attribute_restrictions, test_role.permission[TEST_SCHEMA].tables[table])).to.be.true;
            })
        });

        it('All true table perms passed with one attribute_permissions object all values false',() => {
            const test_role = getUpdatedRoleObj();
            delete test_role.permission[TEST_SCHEMA].tables.breed;

            const test_attr = 'owner_id';
            const test_attr_perm = createAttrPermission(test_attr, createPermsObj(false, false, false, false))
            test_role.permission[TEST_SCHEMA].tables.dog.attribute_restrictions.push(test_attr_perm);

            const test_result = permissionsTranslator_rw.getRolePermissions(test_role);
            expect(test_result[TEST_SCHEMA].describe).to.be.true;
            expect(test_result.super_user).to.deep.equal(test_role.permission.super_user);
            expect(test_result.system).to.deep.equal(test_role.permission.system);
            Object.keys(test_result[TEST_SCHEMA].tables).forEach(table => {
                expect(validateTablePerms(table, test_role.permission[TEST_SCHEMA].tables[table])).to.be.true;
                expect(validateAttrPerms(test_result[TEST_SCHEMA].tables[table].attribute_restrictions, test_role.permission[TEST_SCHEMA].tables[table])).to.be.true;
            })
        });

        it('Mixed table perms passed with one attribute_permissions object all values false',() => {
            const test_role = getUpdatedRoleObj();
            delete test_role.permission[TEST_SCHEMA].tables.breed;
            test_role.permission[TEST_SCHEMA].tables.dog = createTablePermsObj(true, false, false, false)

            const test_attr = 'owner_id';
            const test_attr_perm = createAttrPermission(test_attr, createPermsObj(false, false, false, false))
            test_role.permission[TEST_SCHEMA].tables.dog.attribute_restrictions.push(test_attr_perm);

            const test_result = permissionsTranslator_rw.getRolePermissions(test_role);
            expect(test_result[TEST_SCHEMA].describe).to.be.true;
            expect(test_result.super_user).to.deep.equal(test_role.permission.super_user);
            expect(test_result.system).to.deep.equal(test_role.permission.system);
            Object.keys(test_result[TEST_SCHEMA].tables).forEach(table => {
                expect(validateTablePerms(table, test_role.permission[TEST_SCHEMA].tables[table])).to.be.true;
                expect(validateAttrPerms(test_result[TEST_SCHEMA].tables[table].attribute_restrictions, test_role.permission[TEST_SCHEMA].tables[table])).to.be.true;
            })
        });

        it('Mixed table perms passed with one attribute_permissions object all values true',() => {
            const test_role = getUpdatedRoleObj();
            delete test_role.permission[TEST_SCHEMA].tables.breed;

            const test_attr = 'owner_id';
            const test_attr_perm = createAttrPermission(test_attr, createPermsObj(true, true, true, true))
            test_role.permission[TEST_SCHEMA].tables.dog.attribute_restrictions.push(test_attr_perm);

            const test_result = permissionsTranslator_rw.getRolePermissions(test_role);
            expect(test_result[TEST_SCHEMA].describe).to.be.true;
            expect(test_result.super_user).to.deep.equal(test_role.permission.super_user);
            expect(test_result.system).to.deep.equal(test_role.permission.system);
            Object.keys(test_result[TEST_SCHEMA].tables).forEach(table => {
                expect(validateTablePerms(table, test_role.permission[TEST_SCHEMA].tables[table])).to.be.true;
                expect(validateAttrPerms(test_result[TEST_SCHEMA].tables[table].attribute_restrictions, test_role.permission[TEST_SCHEMA].tables[table])).to.be.true;
            })
        });

        it('Mixed table perms passed with one attribute_permissions object with mixed values',() => {
            const test_role = getUpdatedRoleObj();
            delete test_role.permission[TEST_SCHEMA].tables.breed;

            const test_attr = 'owner_id';
            const test_attr_perm = createAttrPermission(test_attr, createPermsObj(true, false, true, false))
            test_role.permission[TEST_SCHEMA].tables.dog.attribute_restrictions.push(test_attr_perm);

            const test_result = permissionsTranslator_rw.getRolePermissions(test_role);
            expect(test_result[TEST_SCHEMA].describe).to.be.true;
            expect(test_result.super_user).to.deep.equal(test_role.permission.super_user);
            expect(test_result.system).to.deep.equal(test_role.permission.system);
            Object.keys(test_result[TEST_SCHEMA].tables).forEach(table => {
                expect(validateTablePerms(table, test_role.permission[TEST_SCHEMA].tables[table])).to.be.true;
                expect(validateAttrPerms(test_result[TEST_SCHEMA].tables[table].attribute_restrictions, test_role.permission[TEST_SCHEMA].tables[table])).to.be.true;
            })
        });

        it('Multiple tables perms passed with multiple attribute_permissions object with mixed values',() => {
            const test_role = getUpdatedRoleObj();
            const test_attr = 'name';
            const test_attr2 = 'id';
            const test_attr_perm = createAttrPermission(test_attr, createPermsObj(true, true, true, true))
            const test_attr_perm2 = createAttrPermission(test_attr2, createPermsObj(true, false, false, true))
            test_role.permission[TEST_SCHEMA].tables.breed.attribute_restrictions.push(test_attr_perm);
            test_role.permission[TEST_SCHEMA].tables.breed.attribute_restrictions.push(test_attr_perm2);

            const test_attr3 = 'owner_id';
            const test_attr_perm3 = createAttrPermission(test_attr3, createPermsObj(true, false, true, false))
            test_role.permission[TEST_SCHEMA].tables.dog.attribute_restrictions.push(test_attr_perm3);

            const test_result = permissionsTranslator_rw.getRolePermissions(test_role);
            expect(test_result[TEST_SCHEMA].describe).to.be.true;
            expect(test_result.super_user).to.deep.equal(test_role.permission.super_user);
            expect(test_result.system).to.deep.equal(test_role.permission.system);
            Object.keys(test_result[TEST_SCHEMA].tables).forEach(table => {
                expect(validateTablePerms(table, test_role.permission[TEST_SCHEMA].tables[table])).to.be.true;
                expect(validateAttrPerms(test_result[TEST_SCHEMA].tables[table].attribute_restrictions, test_role.permission[TEST_SCHEMA].tables[table])).to.be.true;
            })
        });

        it('All table perms passed are false with one attribute_permissions object all values false - schema.read perm should be false',() => {
            const test_role = getUpdatedRoleObj();
            delete test_role.permission[TEST_SCHEMA].tables.breed;
            test_role.permission[TEST_SCHEMA].tables.dog = createTablePermsObj(false, false, false, false)

            const test_attr = 'owner_id';
            const test_attr_perm = createAttrPermission(test_attr, createPermsObj(false, false, false, false))
            test_role.permission[TEST_SCHEMA].tables.dog.attribute_restrictions.push(test_attr_perm);

            const test_result = permissionsTranslator_rw.getRolePermissions(test_role);
            expect(test_result[TEST_SCHEMA].describe).to.be.false
            expect(test_result.super_user).to.deep.equal(test_role.permission.super_user);
            expect(test_result.system).to.deep.equal(test_role.permission.system);
            Object.keys(test_result[TEST_SCHEMA].tables).forEach(table => {
                expect(validateTablePerms(table, test_role.permission[TEST_SCHEMA].tables[table])).to.be.true;
                expect(validateAttrPerms(test_result[TEST_SCHEMA].tables[table].attribute_restrictions, test_role.permission[TEST_SCHEMA].tables[table])).to.be.true;
            })
        });
    })

    describe('Test getRolePermissions method - edge cases', () => {
        it('All true table perms passed with no attribute_permissions - expect same perms returned',() => {
            const test_role = getUpdatedRoleObj();
            const test_result = permissionsTranslator_rw.getRolePermissions(test_role);
            expect(test_result[TEST_SCHEMA].describe).to.be.true;
            expect(test_result.tables).to.deep.equal(test_role.permission.tables);
            expect(test_result.super_user).to.deep.equal(test_role.permission.super_user);
            expect(test_result.system).to.deep.equal(test_role.permission.system);
            expect(translateRolePerms_spy.calledOnce).to.be.true;
        });

        it('translateRolePermissions step should only use non-system schema values',() => {
            const test_role = clonedeep(TEST_NON_SU_ROLE);
            permissionsTranslator_rw.getRolePermissions(test_role);

            expect(translateRolePerms_spy.calledOnce).to.be.true;
            expect(Object.keys(translateRolePerms_spy.args[0][1])).to.not.include(terms.SYSTEM_SCHEMA_NAME);
        });

        it('Pass SU role - expect same permissions to be returned', () => {
            const test_role = getUpdatedRoleObj();
            test_role.permission.super_user = true;
            const test_result = permissionsTranslator_rw.getRolePermissions(test_role);
            expect(test_result.tables).to.deep.equal(test_role.permission.tables);
            expect(test_result.super_user).to.be.true;
            expect(test_result.system).to.deep.equal(test_role.permission.system);
            expect(translateRolePerms_spy.called).to.be.false;
        });

        it('Pass same role twice and expect cached permission returned the 2nd time ',() => {
            const test_role = getUpdatedRoleObj();
            const test_result = permissionsTranslator_rw.getRolePermissions(test_role);
            expect(test_result[TEST_SCHEMA].describe).to.be.true;
            expect(test_result.tables).to.deep.equal(test_role.permission.tables);
            expect(test_result.super_user).to.deep.equal(test_role.permission.super_user);
            expect(test_result.system).to.deep.equal(test_role.permission.system);
            expect(translateRolePerms_spy.calledOnce).to.be.true;

            const test_result2 = permissionsTranslator_rw.getRolePermissions(test_role);
            expect(test_result2[TEST_SCHEMA].describe).to.be.true;
            expect(test_result2.tables).to.deep.equal(test_role.permission.tables);
            expect(test_result2.super_user).to.deep.equal(test_role.permission.super_user);
            expect(test_result2.system).to.deep.equal(test_role.permission.system);
            expect(translateRolePerms_spy.calledOnce).to.be.true;
        });

        it("Pass roles w/ diff '__updatedtime__' and expect new, non-cached permissions returned both times ",() => {
            const test_role = clonedeep(TEST_NON_SU_ROLE);
            const test_result = permissionsTranslator_rw.getRolePermissions(test_role);
            expect(test_result[TEST_SCHEMA].describe).to.be.true;
            expect(test_result.tables).to.deep.equal(test_role.permission.tables);
            expect(test_result.super_user).to.deep.equal(test_role.permission.super_user);
            expect(test_result.system).to.deep.equal(test_role.permission.system);
            expect(translateRolePerms_spy.calledOnce).to.be.true;

            const test_role2 = getUpdatedRoleObj();
            const test_result2 = permissionsTranslator_rw.getRolePermissions(test_role2);
            expect(test_result2[TEST_SCHEMA].describe).to.be.true;
            expect(test_result2.tables).to.deep.equal(test_role2.permission.tables);
            expect(test_result2.super_user).to.deep.equal(test_role2.permission.super_user);
            expect(test_result2.system).to.deep.equal(test_role2.permission.system);
            expect(translateRolePerms_spy.calledTwice).to.be.true;
            expect(test_result).to.deep.equal(test_result2)
        });

        it("Pass same role w/ diff schema and expect different, non-cached permissions returned both times ",() => {
            const test_role = getUpdatedRoleObj();
            const test_result = permissionsTranslator_rw.getRolePermissions(test_role);
            expect(test_result[TEST_SCHEMA].describe).to.be.true;
            expect(test_result.tables).to.deep.equal(test_role.permission.tables);
            expect(test_result.super_user).to.deep.equal(test_role.permission.super_user);
            expect(test_result.system).to.deep.equal(test_role.permission.system);
            expect(translateRolePerms_spy.calledOnce).to.be.true;

            const orig_global_schema = clonedeep(global.hdb_schema);
            global.hdb_schema[TEST_SCHEMA].owners = orig_global_schema[TEST_SCHEMA].dog;

            const test_result2 = permissionsTranslator_rw.getRolePermissions(test_role);
            expect(test_result2[TEST_SCHEMA].describe).to.be.true;
            expect(test_result2.tables).to.deep.equal(test_role.permission.tables);
            expect(test_result2.super_user).to.deep.equal(test_role.permission.super_user);
            expect(test_result2.system).to.deep.equal(test_role.permission.system);
            expect(translateRolePerms_spy.calledTwice).to.be.true;
            expect(test_result[TEST_SCHEMA]).to.not.deep.equal(test_result2[TEST_SCHEMA])

            global.hdb_schema = orig_global_schema;
        });
    })
});
