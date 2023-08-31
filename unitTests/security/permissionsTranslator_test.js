'use strict';

const chai = require('chai');
const sinon = require('sinon');
const { expect } = chai;

const rewire = require('rewire');
const { cloneDeep } = require('lodash');
const permissionsTranslator_rw = rewire('../../security/permissionsTranslator');
const { TEST_NON_SU_ROLE, TEST_SCHEMA_DOG_BREED, TEST_TWO_SCHEMAS } = require('../test_data');
const terms = require('../../utility/hdbTerms');
const { TEST_ROLE_PERMS_ERROR, HTTP_STATUS_CODES, TEST_DEFAULT_ERROR_RESP } = require('../commonTestErrors');

const TEST_SCHEMA = 'dev';
const TEST_PERMS_ENUM = {
	READ: 'read',
	INSERT: 'insert',
	UPDATE: 'update',
	DELETE: 'delete',
};

const test_attr_perm_keys = [TEST_PERMS_ENUM.READ, TEST_PERMS_ENUM.INSERT, TEST_PERMS_ENUM.UPDATE];

const SUPER_STRUCTURE_USER_ROLE = {
	__createdtime__: 1593546681121,
	__updatedtime__: Date.now(),
	id: '12345',
	permission: {
		super_user: false,
		structure_user: true,
	},
	role: 'test_role',
};

const createTablePermsObj = (read_perm = true, insert_perm = true, update_perm = true, delete_perm = true) => ({
	read: read_perm,
	insert: insert_perm,
	update: update_perm,
	delete: delete_perm,
	attribute_permissions: [],
});

const createAttrPermission = (attr_name, perms) => ({
	attribute_name: attr_name,
	...perms,
});

const createAttrPermsObj = (read_perm, insert_perm, update_perm) => ({
	read: read_perm,
	insert: insert_perm,
	update: update_perm,
});

const getUpdatedRoleObj = () => {
	const test_role = cloneDeep(TEST_NON_SU_ROLE);
	test_role.__createdtime__ = terms.PERMS_UPDATE_RELEASE_TIMESTAMP;
	test_role.__updatedtime__ = terms.PERMS_UPDATE_RELEASE_TIMESTAMP + Math.round(Math.random() * 1000000);
	return test_role;
};

const validateTablePerms = (final_perms, initial_perms) => {
	//Used to check if table `describe` value should be TRUE
	let table_has_crud_perm = false;
	Object.values(TEST_PERMS_ENUM).forEach((key) => {
		if (!initial_perms) {
			//if there are no initial perms for table in role, all table perms should be set to false
			if (final_perms[key] || final_perms.describe) {
				return false;
			}
		} else {
			//if there are perms for table in role, the final perms should match
			if (final_perms[key] !== initial_perms[key]) {
				return false;
			}
			if (final_perms[key]) {
				table_has_crud_perm = true;
			}
		}
	});

	return table_has_crud_perm === final_perms.describe;
};

const isSystemTimestampAttr = (attr_name) => {
	return terms.TIME_STAMP_NAMES.includes(attr_name);
};

const validateAttrPerms = (final_perms, initial_perms, hash_key = 'id') => {
	let is_valid = true;
	console.log(final_perms, initial_perms);
	if (!initial_perms || initial_perms.attribute_permissions.length === 0) {
		if (final_perms.length !== 0) {
			return false;
		}
	} else {
		let expected_hash_perms = createAttrPermission(hash_key, createAttrPermsObj(false, false, false));
		let has_hash_perms = false;
		const initial_perms_map = initial_perms.attribute_permissions.reduce((acc, perm_obj) => {
			const attr_name = perm_obj.attribute_name;
			acc[attr_name] = perm_obj;
			if (!has_hash_perms) {
				if (attr_name === hash_key) {
					expected_hash_perms = perm_obj;
					has_hash_perms = true;
				} else {
					if (isSystemTimestampAttr(attr_name)) {
						if (perm_obj[TEST_PERMS_ENUM.READ] === true) {
							expected_hash_perms[TEST_PERMS_ENUM.READ] = true;
						}
					} else {
						test_attr_perm_keys.forEach((perm_key) => {
							if (perm_obj[perm_key] === true) {
								expected_hash_perms[perm_key] = true;
							}
						});
					}
				}
			}
			return acc;
		}, {});
		initial_perms_map[hash_key] = expected_hash_perms;
		final_perms.forEach((final_perm) => {
			if (initial_perms_map[final_perm.attribute_name]) {
				let attr_describe_value = false;
				if (isSystemTimestampAttr(final_perm.attribute_name)) {
					if (initial_perms_map[final_perm.attribute_name][TEST_PERMS_ENUM.READ] !== final_perm[TEST_PERMS_ENUM.READ]) {
						is_valid = false;
					}
					if (Object.keys(final_perm).length !== 3) {
						is_valid = false;
					}
					if (final_perm[TEST_PERMS_ENUM.READ] === true) {
						attr_describe_value = true;
					}
				} else {
					Object.keys(initial_perms_map[final_perm.attribute_name]).forEach((obj_key) => {
						if (initial_perms_map[final_perm.attribute_name][obj_key] !== final_perm[obj_key]) {
							is_valid = false;
						}
						if (final_perm[obj_key] === true) {
							attr_describe_value = true;
						}
					});
				}
				if (attr_describe_value !== final_perm.describe) {
					is_valid = false;
				}
			} else {
				if (final_perm.attribute_name === hash_key) {
					let attr_describe_value = false;
					const expected_hash_perms = initial_perms_map[hash_key];
					Object.keys(expected_hash_perms).forEach((obj_key) => {
						if (expected_hash_perms[obj_key] !== final_perm[obj_key]) {
							is_valid = false;
						}
						if (final_perm[obj_key] === true) {
							attr_describe_value = true;
						}
					});
					if (attr_describe_value !== final_perm.describe) {
						is_valid = false;
					}
				} else if (isSystemTimestampAttr(final_perm.attribute_name)) {
					if (final_perm[TEST_PERMS_ENUM.READ] || final_perm.describe) {
						is_valid = false;
					}
					if (Object.keys(final_perm).length !== 3) {
						is_valid = false;
					}
				} else {
					test_attr_perm_keys.forEach((key) => {
						if (final_perm[key]) {
							is_valid = false;
						}
					});
				}

				if (final_perm.describe) {
					is_valid = false;
				}
			}
		});
	}
	return is_valid;
};

const test_table_perms = {
	breed: {
		read: true,
		insert: true,
		update: true,
		delete: false,
		attribute_permissions: [
			{
				attribute_name: '__createdtime__',
				read: false,
				insert: true,
				update: true,
				delete: true,
			},
		],
	},
	dog: {
		read: true,
		insert: true,
		update: true,
		delete: true,
		attribute_permissions: [
			{
				attribute_name: 'id',
				read: true,
				insert: true,
				update: true,
			},
			{
				attribute_name: 'name',
				read: true,
				insert: true,
				update: true,
			},
			{
				attribute_name: '__createdtime__',
				read: true,
				insert: true,
				update: false,
				delete: false,
			},
			{
				attribute_name: '__updatedtime__',
				read: true,
				insert: true,
				update: true,
			},
		],
	},
};
const test_table_schema = {
	breed: {
		hash_attribute: 'id',
		name: 'breed',
		schema: 'dev',
		attributes: [
			{
				attribute: '__updatedtime__',
			},
			{
				attribute: '__createdtime__',
			},
			{
				attribute: 'id',
			},
			{
				attribute: 'name',
			},
			{
				attribute: 'image',
			},
		],
		record_count: 350,
	},
	dog: {
		hash_attribute: 'id',
		name: 'dog',
		schema: 'dev',
		attributes: [
			{
				attribute: 'dog_name',
			},
			{
				attribute: 'id',
			},
			{
				attribute: 'weight_lbs',
			},
			{
				attribute: '__createdtime__',
			},
			{
				attribute: 'name',
			},
			{
				attribute: '__updatedtime__',
			},
			{
				attribute: 'breed_id',
			},
		],
	},
};

let sandbox;
let translateRolePerms_rw;
let translateRolePerms_spy;
let createStructureUserPermissions_rw;
let createStructureUserPermissions_spy;

describe('Test permissionsTranslator module', function () {
	before(() => {
		sandbox = sinon.createSandbox();
		translateRolePerms_spy = sandbox.spy(permissionsTranslator_rw.__get__('translateRolePermissions'));
		translateRolePerms_rw = permissionsTranslator_rw.__set__('translateRolePermissions', translateRolePerms_spy);
		createStructureUserPermissions_spy = sandbox.spy(
			permissionsTranslator_rw.__get__('createStructureUserPermissions')
		);
		createStructureUserPermissions_rw = permissionsTranslator_rw.__set__(
			'createStructureUserPermissions',
			createStructureUserPermissions_spy
		);
		global.hdb_schema = cloneDeep(TEST_SCHEMA_DOG_BREED);
	});
	afterEach(() => {
		sandbox.resetHistory();
	});
	after(() => {
		global.hdb_schema = null;
		translateRolePerms_rw();
		createStructureUserPermissions_rw();
		sandbox.restore();
	});

	describe('test structure_user scenarios', () => {
		const true_schema_perms = {
			describe: true,
			tables: {
				breed: {
					attribute_permissions: [],
					describe: true,
					read: true,
					insert: true,
					update: true,
					delete: true,
				},
				dog: {
					attribute_permissions: [],
					describe: true,
					read: true,
					insert: true,
					update: true,
					delete: true,
				},
			},
		};

		const false_schema_perms = {
			describe: false,
			tables: {
				breed: {
					attribute_permissions: [],
					describe: false,
					read: false,
					insert: false,
					update: false,
					delete: false,
				},
				dog: {
					attribute_permissions: [],
					describe: false,
					read: false,
					insert: false,
					update: false,
					delete: false,
				},
			},
		};

		before(() => {
			global.hdb_schema = cloneDeep(TEST_TWO_SCHEMAS);
		});

		afterEach(() => {
			sandbox.resetHistory();
			permissionsTranslator_rw.__set__('translateRolePermissions', translateRolePerms_spy);
		});

		after(() => {
			global.hdb_schema = cloneDeep(TEST_SCHEMA_DOG_BREED);
		});

		it('test structure_user = true', () => {
			const test_result = permissionsTranslator_rw.getRolePermissions(SUPER_STRUCTURE_USER_ROLE);
			expect(test_result['dev']).to.eql(true_schema_perms);
			expect(test_result['prod']).to.eql(true_schema_perms);
			expect(test_result.super_user).to.equal(false);
			expect(translateRolePerms_spy.calledOnce).to.be.true;
			expect(createStructureUserPermissions_spy.calledTwice).to.be.true;
		});

		it('test structure_user = ["dev"]', () => {
			let role = cloneDeep(SUPER_STRUCTURE_USER_ROLE);
			role.permission.structure_user = ['dev'];
			role.__updatedtime__ = Date.now();
			const test_result = permissionsTranslator_rw.getRolePermissions(role);
			expect(test_result['dev']).to.eql(true_schema_perms);
			expect(test_result['prod']).to.eql(false_schema_perms);
			expect(test_result.super_user).to.equal(false);
			expect(translateRolePerms_spy.calledOnce).to.be.true;
			expect(createStructureUserPermissions_spy.calledOnce).to.be.true;
		});
	});

	describe('Test getRolePermissions method - translation cases', () => {
		it('All true table perms passed with one attribute_permissions object mixed values', () => {
			const test_role = getUpdatedRoleObj();
			delete test_role.permission[TEST_SCHEMA].tables.breed;

			const test_attr = 'owner_id';
			const test_attr_perm = createAttrPermission(test_attr, createAttrPermsObj(true, false, false));
			test_role.permission[TEST_SCHEMA].tables.dog.attribute_permissions.push(test_attr_perm);

			const test_result = permissionsTranslator_rw.getRolePermissions(cloneDeep(test_role));
			expect(test_result.super_user).to.deep.equal(test_role.permission.super_user);
			expect(test_result.system).to.deep.equal(test_role.permission.system);
			Object.keys(test_result[TEST_SCHEMA].tables).forEach((table) => {
				expect(
					validateTablePerms(test_result[TEST_SCHEMA].tables[table], test_role.permission[TEST_SCHEMA].tables[table])
				).to.be.true;
				expect(
					validateAttrPerms(
						test_result[TEST_SCHEMA].tables[table].attribute_permissions,
						test_role.permission[TEST_SCHEMA].tables[table]
					)
				).to.be.true;
			});
		});

		it('All true table perms passed with one attribute_permissions object all true', () => {
			const test_role = getUpdatedRoleObj();
			delete test_role.permission[TEST_SCHEMA].tables.breed;

			const test_attr = 'owner_id';
			const test_attr_perm = createAttrPermission(test_attr);
			test_role.permission[TEST_SCHEMA].tables.dog.attribute_permissions.push(test_attr_perm);

			const test_result = permissionsTranslator_rw.getRolePermissions(test_role);
			expect(test_result.super_user).to.deep.equal(test_role.permission.super_user);
			expect(test_result.system).to.deep.equal(test_role.permission.system);
			Object.keys(test_result[TEST_SCHEMA].tables).forEach((table) => {
				expect(
					validateTablePerms(test_result[TEST_SCHEMA].tables[table], test_role.permission[TEST_SCHEMA].tables[table])
				).to.be.true;
				expect(
					validateAttrPerms(
						test_result[TEST_SCHEMA].tables[table].attribute_permissions,
						test_role.permission[TEST_SCHEMA].tables[table]
					)
				).to.be.true;
			});
		});

		it('All true table perms passed with one attribute_permissions object all values false', () => {
			const test_role = getUpdatedRoleObj();
			delete test_role.permission[TEST_SCHEMA].tables.breed;

			const test_attr = 'owner_id';
			const test_attr_perm = createAttrPermission(test_attr, createAttrPermsObj(false, false, false));
			test_role.permission[TEST_SCHEMA].tables.dog.attribute_permissions.push(test_attr_perm);

			const test_result = permissionsTranslator_rw.getRolePermissions(test_role);
			expect(test_result.super_user).to.deep.equal(test_role.permission.super_user);
			expect(test_result.system).to.deep.equal(test_role.permission.system);
			Object.keys(test_result[TEST_SCHEMA].tables).forEach((table) => {
				expect(
					validateTablePerms(test_result[TEST_SCHEMA].tables[table], test_role.permission[TEST_SCHEMA].tables[table])
				).to.be.true;
				expect(
					validateAttrPerms(
						test_result[TEST_SCHEMA].tables[table].attribute_permissions,
						test_role.permission[TEST_SCHEMA].tables[table]
					)
				).to.be.true;
			});
		});

		it('Mixed table perms passed with one attribute_permissions object all values false', () => {
			const test_role = getUpdatedRoleObj();
			delete test_role.permission[TEST_SCHEMA].tables.breed;
			test_role.permission[TEST_SCHEMA].tables.dog = createTablePermsObj(true, false, false, false);

			const test_attr = 'owner_id';
			const test_attr_perm = createAttrPermission(test_attr, createAttrPermsObj(false, false, false));
			test_role.permission[TEST_SCHEMA].tables.dog.attribute_permissions.push(test_attr_perm);

			const test_result = permissionsTranslator_rw.getRolePermissions(test_role);
			expect(test_result.super_user).to.deep.equal(test_role.permission.super_user);
			expect(test_result.system).to.deep.equal(test_role.permission.system);
			Object.keys(test_result[TEST_SCHEMA].tables).forEach((table) => {
				expect(
					validateTablePerms(test_result[TEST_SCHEMA].tables[table], test_role.permission[TEST_SCHEMA].tables[table])
				).to.be.true;
				expect(
					validateAttrPerms(
						test_result[TEST_SCHEMA].tables[table].attribute_permissions,
						test_role.permission[TEST_SCHEMA].tables[table]
					)
				).to.be.true;
			});
		});

		it('Mixed table perms passed with one attribute_permissions object all values true', () => {
			const test_role = getUpdatedRoleObj();
			delete test_role.permission[TEST_SCHEMA].tables.breed;

			const test_attr = 'owner_id';
			const test_attr_perm = createAttrPermission(test_attr, createAttrPermsObj(true, true, true));
			test_role.permission[TEST_SCHEMA].tables.dog.attribute_permissions.push(test_attr_perm);

			const test_result = permissionsTranslator_rw.getRolePermissions(test_role);
			expect(test_result.super_user).to.deep.equal(test_role.permission.super_user);
			expect(test_result.system).to.deep.equal(test_role.permission.system);
			Object.keys(test_result[TEST_SCHEMA].tables).forEach((table) => {
				expect(
					validateTablePerms(test_result[TEST_SCHEMA].tables[table], test_role.permission[TEST_SCHEMA].tables[table])
				).to.be.true;
				expect(
					validateAttrPerms(
						test_result[TEST_SCHEMA].tables[table].attribute_permissions,
						test_role.permission[TEST_SCHEMA].tables[table]
					)
				).to.be.true;
			});
		});

		it('Mixed table perms passed with one attribute_permissions object with mixed values', () => {
			const test_role = getUpdatedRoleObj();
			delete test_role.permission[TEST_SCHEMA].tables.breed;

			const test_attr = 'owner_id';
			const test_attr_perm = createAttrPermission(test_attr, createAttrPermsObj(true, false, true));
			test_role.permission[TEST_SCHEMA].tables.dog.attribute_permissions.push(test_attr_perm);

			const test_result = permissionsTranslator_rw.getRolePermissions(test_role);
			expect(test_result.super_user).to.deep.equal(test_role.permission.super_user);
			expect(test_result.system).to.deep.equal(test_role.permission.system);
			Object.keys(test_result[TEST_SCHEMA].tables).forEach((table) => {
				expect(
					validateTablePerms(test_result[TEST_SCHEMA].tables[table], test_role.permission[TEST_SCHEMA].tables[table])
				).to.be.true;
				expect(
					validateAttrPerms(
						test_result[TEST_SCHEMA].tables[table].attribute_permissions,
						test_role.permission[TEST_SCHEMA].tables[table]
					)
				).to.be.true;
			});
		});

		it('Multiple tables perms passed with multiple attribute_permissions object with mixed values', () => {
			const test_role = getUpdatedRoleObj();
			const test_attr = 'name';
			const test_attr2 = 'id';
			const test_attr_perm = createAttrPermission(test_attr, createAttrPermsObj(true, true, true));
			const test_attr_perm2 = createAttrPermission(test_attr2, createAttrPermsObj(true, false, false));
			test_role.permission[TEST_SCHEMA].tables.breed.attribute_permissions.push(test_attr_perm);
			test_role.permission[TEST_SCHEMA].tables.breed.attribute_permissions.push(test_attr_perm2);

			const test_attr3 = 'owner_id';
			const test_attr_perm3 = createAttrPermission(test_attr3, createAttrPermsObj(true, false, true));
			test_role.permission[TEST_SCHEMA].tables.dog.attribute_permissions.push(test_attr_perm3);

			const test_result = permissionsTranslator_rw.getRolePermissions(test_role);
			expect(test_result.super_user).to.deep.equal(test_role.permission.super_user);
			expect(test_result.system).to.deep.equal(test_role.permission.system);
			Object.keys(test_result[TEST_SCHEMA].tables).forEach((table) => {
				expect(
					validateTablePerms(test_result[TEST_SCHEMA].tables[table], test_role.permission[TEST_SCHEMA].tables[table])
				).to.be.true;
				expect(
					validateAttrPerms(
						test_result[TEST_SCHEMA].tables[table].attribute_permissions,
						test_role.permission[TEST_SCHEMA].tables[table]
					)
				).to.be.true;
			});
		});

		it('All table perms passed are false with one attribute_permissions object all values false - schema.read perm should be false', () => {
			const test_role = getUpdatedRoleObj();
			delete test_role.permission[TEST_SCHEMA].tables.breed;
			test_role.permission[TEST_SCHEMA].tables.dog = createTablePermsObj(false, false, false, false);

			const test_attr = 'owner_id';
			const test_attr_perm = createAttrPermission(test_attr, createAttrPermsObj(false, false, false));
			test_role.permission[TEST_SCHEMA].tables.dog.attribute_permissions.push(test_attr_perm);

			const test_result = permissionsTranslator_rw.getRolePermissions(test_role);
			expect(test_result.super_user).to.deep.equal(test_role.permission.super_user);
			expect(test_result.system).to.deep.equal(test_role.permission.system);
			Object.keys(test_result[TEST_SCHEMA].tables).forEach((table) => {
				expect(
					validateTablePerms(test_result[TEST_SCHEMA].tables[table], test_role.permission[TEST_SCHEMA].tables[table])
				).to.be.true;
				expect(
					validateAttrPerms(
						test_result[TEST_SCHEMA].tables[table].attribute_permissions,
						test_role.permission[TEST_SCHEMA].tables[table]
					)
				).to.be.true;
			});
		});
	});

	describe('Test getRolePermissions method - edge cases', () => {
		it('All true table perms passed with no attribute_permissions - expect same perms returned', () => {
			const test_role = getUpdatedRoleObj();
			const test_result = permissionsTranslator_rw.getRolePermissions(test_role);
			expect(test_result[TEST_SCHEMA].describe).to.be.true;
			expect(test_result.tables).to.deep.equal(test_role.permission.tables);
			expect(test_result.super_user).to.deep.equal(test_role.permission.super_user);
			expect(test_result.system).to.deep.equal(test_role.permission.system);
			expect(translateRolePerms_spy.calledOnce).to.be.true;
		});

		it('translateRolePermissions step should only use non-system schema values', () => {
			const test_role = cloneDeep(TEST_NON_SU_ROLE);
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

		it('Pass same role twice and expect cached permission returned the 2nd time ', () => {
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

		it("Pass roles w/ diff '__updatedtime__' and expect new, non-cached permissions returned both times ", () => {
			const test_role = cloneDeep(TEST_NON_SU_ROLE);
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
			expect(test_result).to.deep.equal(test_result2);
		});

		it('Pass same role w/ diff schema and expect different, non-cached permissions returned both times ', () => {
			const test_role = getUpdatedRoleObj();
			const test_result = permissionsTranslator_rw.getRolePermissions(test_role);
			expect(test_result[TEST_SCHEMA].describe).to.be.true;
			expect(test_result.tables).to.deep.equal(test_role.permission.tables);
			expect(test_result.super_user).to.deep.equal(test_role.permission.super_user);
			expect(test_result.system).to.deep.equal(test_role.permission.system);
			expect(translateRolePerms_spy.calledOnce).to.be.true;

			const orig_global_schema = cloneDeep(global.hdb_schema);
			global.hdb_schema[TEST_SCHEMA].owners = orig_global_schema[TEST_SCHEMA].dog;

			const test_result2 = permissionsTranslator_rw.getRolePermissions(test_role);
			expect(test_result2[TEST_SCHEMA].describe).to.be.true;
			expect(test_result2.tables).to.deep.equal(test_role.permission.tables);
			expect(test_result2.super_user).to.deep.equal(test_role.permission.super_user);
			expect(test_result2.system).to.deep.equal(test_role.permission.system);
			expect(translateRolePerms_spy.calledTwice).to.be.true;
			expect(test_result[TEST_SCHEMA]).to.not.deep.equal(test_result2[TEST_SCHEMA]);

			global.hdb_schema = orig_global_schema;
		});
	});

	describe('Test old perms error handling', () => {
		it('Should return old perms error if attribute_restrictions key is found in perms', () => {
			const test_role = getUpdatedRoleObj();
			test_role.__updatedtime__ = terms.PERMS_UPDATE_RELEASE_TIMESTAMP - Math.round(Math.random() * 1000000);

			delete test_role.permission.dev.tables.breed.attribute_permissions;
			delete test_role.permission.dev.tables.dog.attribute_permissions;
			test_role.permission.dev.tables.breed.attribute_restrictions = [];
			test_role.permission.dev.tables.dog.attribute_restrictions = [];

			let test_result;
			try {
				permissionsTranslator_rw.getRolePermissions(test_role);
			} catch (err) {
				test_result = err;
			}

			expect(test_result.http_resp_msg).to.eql(TEST_ROLE_PERMS_ERROR.OUTDATED_PERMS_TRANSLATION_ERROR);
			expect(test_result.statusCode).to.eql(HTTP_STATUS_CODES.BAD_REQUEST);
		});

		it('Should return correct error message if missing attribute_permissions/restrictions', () => {
			const test_role = getUpdatedRoleObj();
			test_role.__updatedtime__ = terms.PERMS_UPDATE_RELEASE_TIMESTAMP - Math.round(Math.random() * 1000000);

			delete test_role.permission.dev.tables.breed.attribute_permissions;
			delete test_role.permission.dev.tables.dog.attribute_permissions;

			let test_result;
			try {
				permissionsTranslator_rw.getRolePermissions(test_role);
			} catch (err) {
				test_result = err;
			}

			expect(test_result.http_resp_msg).to.eql(TEST_ROLE_PERMS_ERROR.OUTDATED_PERMS_TRANSLATION_ERROR);
			expect(test_result.statusCode).to.eql(HTTP_STATUS_CODES.BAD_REQUEST);
		});

		it('Should return correct error message if error is thrown and updatedtime key does not exist on role.perms', () => {
			const test_role = getUpdatedRoleObj();
			delete test_role.__updatedtime__;

			delete test_role.permission.dev.tables.breed.attribute_permissions;
			delete test_role.permission.dev.tables.dog.attribute_permissions;

			let test_result;
			try {
				permissionsTranslator_rw.getRolePermissions(test_role);
			} catch (err) {
				test_result = err;
			}

			expect(test_result.http_resp_msg).to.eql(TEST_ROLE_PERMS_ERROR.OUTDATED_PERMS_TRANSLATION_ERROR);
			expect(test_result.statusCode).to.eql(HTTP_STATUS_CODES.BAD_REQUEST);
		});

		it('Should return generic error if updatedtime is after release date', () => {
			const test_role = getUpdatedRoleObj();

			delete test_role.permission.dev.tables.breed.attribute_permissions;
			delete test_role.permission.dev.tables.dog.attribute_permissions;

			let test_result;
			try {
				permissionsTranslator_rw.getRolePermissions(test_role);
			} catch (err) {
				test_result = err;
			}

			expect(test_result.http_resp_msg).to.eql(TEST_DEFAULT_ERROR_RESP);
			expect(test_result.statusCode).to.eql(HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR);
		});
	});

	describe('Test getTableAttrPerms function', function () {
		let getTableAttrPerms_rw;

		before(() => {
			getTableAttrPerms_rw = permissionsTranslator_rw.__get__('getTableAttrPerms');
		});

		it('NOMINAL - should return table perms with correct system time and other perms values', () => {
			const test_result = getTableAttrPerms_rw(test_table_perms.dog, test_table_schema.dog);

			expect(test_result.describe).to.be.true;
			expect(validateAttrPerms(test_result.attribute_permissions, test_table_perms.dog)).to.be.true;
		});

		it('Should ignore non-READ perms for system time when setting describe perm value', () => {
			const test_result = getTableAttrPerms_rw(test_table_perms.breed, test_table_schema.breed);

			expect(test_result.describe).to.be.true;
			expect(validateAttrPerms(test_result.attribute_permissions, test_table_perms.breed)).to.be.true;
		});
	});
});
