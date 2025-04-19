'use strict';
const test_util = require('../test_utils');
test_util.preTestPrep();

// I temporarily change HDB_ROOT to the unit test folder for testing schema and table create/delete functions.
// Afterwards root is set back to original value and temp test folder is deleted.
// This needs to be done before schema.js is called by rewire.
const HDB_ROOT_TEST = '../unitTests/dataLayer';
const env = require('../../utility/environment/environmentManager');
const HDB_ROOT_ORIGINAL = env.get('HDB_ROOT');
env.setProperty('HDB_ROOT', HDB_ROOT_TEST);

const chai = require('chai');
const sinon = require('sinon');
const sinon_chai = require('sinon-chai');
const { expect } = chai;
chai.use(sinon_chai);
const signalling = require('../../utility/signalling');
let insert = require('../../dataLayer/insert');
const logger = require('../../utility/logging/harper_logger');
const schema_metadata_validator = require('../../validation/schemaMetadataValidator');
const util = require('util');
const { cloneDeep } = require('lodash');
const harperBridge = require('../../dataLayer/harperBridge/harperBridge');
const nats_utils = require('../../server/nats/utility/natsUtils');

// Rewire is used at times as stubbing alone doesn't work when stubbing a function
// being called inside another function declared within the same file.
const rewire = require('rewire');
let schema = rewire('../../dataLayer/schema');

const SCHEMA_NAME_TEST = 'dogsrule';
const TABLE_NAME_TEST = 'catsdrool';
const HASH_ATT_TEST = 'id';
const TRASH_PATH_TEST = `${HDB_ROOT_TEST}/trash`;
const SCHEMA_CREATE_OBJECT_TEST = { operation: 'create_schema', schema: SCHEMA_NAME_TEST };
const CREATE_TABLE_OBJECT_TEST = {
	operation: 'create_table',
	schema: SCHEMA_NAME_TEST,
	table: TABLE_NAME_TEST,
	hash_attribute: HASH_ATT_TEST,
	residence: ['*'],
};
const DROP_SCHEMA_OBJECT_TEST = { operation: 'drop_schema', schema: SCHEMA_NAME_TEST };
const DROP_TABLE_OBJECT_TEST = { operation: 'drop_table', schema: SCHEMA_NAME_TEST, table: TABLE_NAME_TEST };
const DROP_ATTR_OBJECT_TEST = {
	operation: 'drop_attribute',
	schema: SCHEMA_NAME_TEST,
	table: TABLE_NAME_TEST,
	attribute: 'id',
};
const CREATE_ATTR_OBJECT_TEST = {
	schema: SCHEMA_NAME_TEST,
	table: TABLE_NAME_TEST,
	attribute: 'name',
	delegated: false,
};
const GLOBAL_SCHEMA_FAKE = {
	dogsrule: {
		catsdrool: {
			hash_attribute: 'id',
		},
	},
};

let global_schema_original = cloneDeep(global.hdb_schema);

/**
 * Cleans up any leftover structure built by buildSchemaTableStruc.
 */
function deleteSchemaTableStruc() {
	test_util.cleanUpDirectories(`${HDB_ROOT_TEST}/schema`);
	test_util.cleanUpDirectories(TRASH_PATH_TEST);
}

/**
 * Unit tests for all functions in schema.js
 */
describe('Test schema module', function () {
	let signal_schema_change_stub;
	let insert_stub;
	let logger_error_stub;
	let logger_info_stub;
	let attr_validator_stub;
	global.hdb_schema = {};
	let sandbox = sinon.createSandbox();

	before(function () {
		sinon.resetHistory();
		env.setProperty('HDB_ROOT', HDB_ROOT_TEST);
		insert_stub = sinon.stub(insert, 'insert');
		signal_schema_change_stub = sinon.stub(signalling, 'signalSchemaChange');
		logger_error_stub = sinon.stub(logger, 'error');
		logger_info_stub = sinon.stub(logger, 'info');
	});

	afterEach(function () {
		sinon.resetHistory();
		insert_stub.resolves();
	});

	after(function () {
		schema = rewire('../../dataLayer/schema');
		sinon.restore();
		test_util.cleanUpDirectories(`${HDB_ROOT_TEST}/schema`);
		test_util.cleanUpDirectories(TRASH_PATH_TEST);
		deleteSchemaTableStruc();
		env.setProperty('HDB_ROOT', HDB_ROOT_ORIGINAL);
		global.hdb_schema = global_schema_original;
		sandbox.restore();
	});

	/**
	 * Tests for createSchema function.
	 */
	describe('Create schema', function () {
		let create_schema_structure_stub = sinon.stub();
		schema.__set__('createSchemaStructure', create_schema_structure_stub);

		it('should return valid stub from createSchemaStructure', async () => {
			let schema_structure_fake = `schema ${SCHEMA_NAME_TEST} successfully created`;
			create_schema_structure_stub.resolves(schema_structure_fake);
			let result = await schema.createSchema(SCHEMA_CREATE_OBJECT_TEST);

			expect(result).to.equal(`schema ${SCHEMA_NAME_TEST} successfully created`);
			expect(create_schema_structure_stub).to.have.been.calledOnce;
			expect(signal_schema_change_stub).to.have.been.calledOnce;
		});

		it('should catch thrown error from createSchemaStructure', async function () {
			let create_schema_structure_err = `schema ${SCHEMA_NAME_TEST} already exists`;
			create_schema_structure_stub.throws(new Error(create_schema_structure_err));
			let error;

			try {
				await schema.createSchema(SCHEMA_CREATE_OBJECT_TEST);
			} catch (err) {
				error = err;
			}

			expect(error.message).to.equal(create_schema_structure_err);
			expect(create_schema_structure_stub).to.have.been.calledOnce;
		});
	});

	/**
	 * Tests for createSchemaStructure function.
	 */
	describe('Create schema structure', function () {
		let create_schema_stub = sinon.stub(harperBridge, 'createSchema');
		let schema_exists_stub;

		before(() => {
			schema_exists_stub = sandbox.stub(schema_metadata_validator, 'checkSchemaExists');
		});

		after(() => {
			schema_exists_stub.restore();
		});

		it('should throw schema already exists error', async function () {
			schema_exists_stub.resolves(false);
			global.hdb_schema = cloneDeep(GLOBAL_SCHEMA_FAKE);
			let error;

			try {
				await schema.createSchemaStructure(SCHEMA_CREATE_OBJECT_TEST);
			} catch (err) {
				error = err;
			}

			expect(error.message).to.equal(`database '${SCHEMA_CREATE_OBJECT_TEST.schema}' already exists`);
		});

		it('should call bridge and return success message', async () => {
			global.hdb_schema = { schema: 'notDogs' };
			schema_exists_stub.resolves(true);
			let result = await schema.createSchemaStructure(SCHEMA_CREATE_OBJECT_TEST);

			expect(create_schema_stub).to.have.been.calledWith(SCHEMA_CREATE_OBJECT_TEST);
			expect(result).to.equal(`database '${SCHEMA_CREATE_OBJECT_TEST.schema}' successfully created`);
		});
	});

	/**
	 * Tests for createTable function.
	 */
	describe('Create table', function () {
		let create_table_struc_stub = sinon.stub();
		schema.__set__('createTableStructure', create_table_struc_stub);

		it('should return valid stub from createTableStructure', async function () {
			let create_table_struc_fake = `table ${CREATE_TABLE_OBJECT_TEST.schema}.${CREATE_TABLE_OBJECT_TEST.table} successfully created.`;
			create_table_struc_stub.resolves(create_table_struc_fake);
			let result = await schema.createTable(CREATE_TABLE_OBJECT_TEST);

			expect(result).to.equal(create_table_struc_fake);
			expect(create_table_struc_stub).to.have.been.calledOnce;
		});

		it('should catch thrown error from createTableStructure', async function () {
			let create_table_struc_err = 'schema does not exist';
			create_table_struc_stub.throws(new Error(create_table_struc_err));
			let error;

			try {
				await schema.createTable(CREATE_TABLE_OBJECT_TEST);
			} catch (err) {
				error = err;
			}

			expect(error).to.be.instanceOf(Error);
			expect(error.message).to.equal(create_table_struc_err);
			expect(create_table_struc_stub).to.have.been.calledOnce;
		});
	});

	/**
	 * Tests for createTableStructure function.
	 */
	describe('Create table structure', function () {
		let harper_bridge_stub;
		let schema_exists_stub;
		let schema_table_exists_stub;

		before(() => {
			schema_exists_stub = sandbox.stub(schema_metadata_validator, 'checkSchemaExists').resolves(true);
			harper_bridge_stub = sinon.stub(harperBridge, 'createTable');
			schema_table_exists_stub = sinon.stub(schema_metadata_validator, 'checkSchemaTableExists').resolves(true);
			global.hdb_schema = {};
		});

		after(function () {
			schema_exists_stub.restore();
			schema_table_exists_stub.restore();
			CREATE_TABLE_OBJECT_TEST.residence = '';
		});

		afterEach(function () {
			schema_exists_stub.resolves(true);
			schema_table_exists_stub.resolves(true);
			global.clustering_on = true;
		});

		it('should catch thrown error from validation.create_table_object', async function () {
			let error;
			try {
				await schema.createTableStructure({
					operation: 'create_table',
					schema: SCHEMA_NAME_TEST,
					hash_attribute: HASH_ATT_TEST,
				});
			} catch (err) {
				error = err;
			}

			expect(error).to.be.instanceOf(Error);
			expect(error.message).to.equal("'table' is required");
		});

		it('should throw table already exists error message', async function () {
			let error;
			global.hdb_schema = cloneDeep(GLOBAL_SCHEMA_FAKE);
			schema_exists_stub.resolves(false);
			schema_table_exists_stub.resolves(false);

			try {
				await schema.createTableStructure(CREATE_TABLE_OBJECT_TEST);
			} catch (err) {
				error = err;
			}

			expect(error.message).to.equal(
				`Table '${CREATE_TABLE_OBJECT_TEST.table}' already exists in '${CREATE_TABLE_OBJECT_TEST.schema}'`
			);

			global.hdb_schema.dogsrule = {};
		});

		it('should check that table has been inserted with clustering on', async function () {
			CREATE_TABLE_OBJECT_TEST.residence = ['*'];
			global.clustering_on = true;
			let result = await schema.createTableStructure(CREATE_TABLE_OBJECT_TEST);

			expect(result).to.equal(
				`table '${CREATE_TABLE_OBJECT_TEST.schema}.${CREATE_TABLE_OBJECT_TEST.table}' successfully created.`
			);
		});

		it('should throw clustering not enabled error', async function () {
			global.clustering_on = false;
			let error;

			try {
				await schema.createTableStructure(CREATE_TABLE_OBJECT_TEST);
			} catch (err) {
				error = err;
			}

			expect(error.message).to.equal(
				`Clustering does not appear to be enabled. Cannot insert table with property 'residence'.`
			);
		});

		it('should call all stubs and return success message', async function () {
			let result = await schema.createTableStructure(CREATE_TABLE_OBJECT_TEST);

			expect(result).to.equal(
				`table '${CREATE_TABLE_OBJECT_TEST.schema}.${CREATE_TABLE_OBJECT_TEST.table}' successfully created.`
			);
		});

		it('should call createTable without setting table.residence', async function () {
			CREATE_TABLE_OBJECT_TEST.residence = undefined;
			let result = await schema.createTableStructure(CREATE_TABLE_OBJECT_TEST);

			expect(result).to.equal(
				`table '${CREATE_TABLE_OBJECT_TEST.schema}.${CREATE_TABLE_OBJECT_TEST.table}' successfully created.`
			);
		});

		it('should catch and throw validation error', async () => {
			let error;
			try {
				await schema.createTableStructure({ operation: 'create_table', schema: 'dogz' });
			} catch (err) {
				error = err;
			}

			expect(error.message).to.be.equal("'table' is required. 'primary_key' is required");
		});
	});

	/**
	 * Tests for dropSchema function.
	 */
	describe('Drop Schema', function () {
		let bridge_drop_schema_stub = sinon.stub(harperBridge, 'dropSchema');
		let schema_describe_rw;
		let purge_schema_table_stub;
		let check_exists_stub;

		before(() => {
			sandbox.restore();
			purge_schema_table_stub = sandbox.stub(nats_utils, 'purgeSchemaTableStreams').resolves();
			check_exists_stub = sandbox.stub().resolves(true);
		});

		beforeEach(() => {
			schema_describe_rw = schema.__set__('schemaMetadataValidator', {
				schema_describe: {
					describeSchema: async (describe_schema_object) => ({ ...GLOBAL_SCHEMA_FAKE.dogsrule }),
					describeTable: async (describe_table_object) => ({ ...GLOBAL_SCHEMA_FAKE.dogsrule.catsdrool }),
				},
				checkSchemaExists: check_exists_stub,
			});
		});

		afterEach(() => {
			schema_describe_rw();
		});

		it('Test that bridge stub is called as expected and success msg is returned', async () => {
			let schema_describe_rw = schema.__set__('schemaMetadataValidator', {
				schema_describe: {
					describeSchema: async (describe_schema_object) => ({ ...GLOBAL_SCHEMA_FAKE }),
					describeTable: async (describe_table_object) => ({ ...GLOBAL_SCHEMA_FAKE.dogsrule }),
				},
				checkSchemaExists: async (schema_name) => {
					global.hdb_schema[schema_name] = { ...GLOBAL_SCHEMA_FAKE[schema_name] };
				},
			});

			let result = await schema.dropSchema(DROP_SCHEMA_OBJECT_TEST);

			expect(bridge_drop_schema_stub).to.have.been.calledWith(DROP_SCHEMA_OBJECT_TEST);
			expect(signal_schema_change_stub.args[0][0].operation).to.equal('drop_schema');
			expect(signal_schema_change_stub.args[0][0].schema).to.equal('dogsrule');
			expect(result.message).to.equal(`successfully deleted '${DROP_SCHEMA_OBJECT_TEST.schema}'`);
			expect(purge_schema_table_stub.called).to.be.true;

			schema_describe_rw();
		});

		it('Test schema does not exist error is thrown', async () => {
			schema_describe_rw();

			let error;
			try {
				await schema.dropSchema(DROP_SCHEMA_OBJECT_TEST);
			} catch (err) {
				error = err;
			}

			expect(error.message).to.be.equal(`database '${DROP_SCHEMA_OBJECT_TEST.schema}' does not exist`);
		});

		it('Test error from bridge drop schema is caught, thrown and logged', async () => {
			check_exists_stub.resolves(false);
			global.hdb_schema = GLOBAL_SCHEMA_FAKE;
			let error_msg = 'We have an error on the bridge';
			bridge_drop_schema_stub.throws(new Error(error_msg));
			let test_err_result = await test_util.testError(schema.dropSchema(DROP_SCHEMA_OBJECT_TEST), error_msg);

			expect(test_err_result).to.be.true;
		});

		it('Test schema obj validation catches and throws error', async () => {
			let error;
			try {
				await schema.dropSchema({ operation: 'drop_schema' });
			} catch (err) {
				error = err;
			}

			expect(error.message).to.be.equal("'database' is required");
		});
	});

	/**
	 * Tests for dropTable function.
	 */
	describe('Drop table', function () {
		let bridge_drop_table_stub;
		let schema_describe_rw;
		let schema_val_stub;
		let purge_table_stream_stub;

		before(() => {
			bridge_drop_table_stub = sandbox.stub(harperBridge, 'dropTable');
			schema_val_stub = sandbox.stub(schema_metadata_validator, 'checkSchemaTableExists');
			purge_table_stream_stub = sandbox.stub(nats_utils, 'purgeTableStream');
		});

		beforeEach(() => {
			schema_describe_rw = schema.__set__('schemaMetadataValidator', {
				schema_describe: {
					describeSchema: async (describe_schema_object) => ({ ...GLOBAL_SCHEMA_FAKE.dogsrule }),
					describeTable: async (describe_table_object) => ({ ...GLOBAL_SCHEMA_FAKE.dogsrule.catsdrool }),
				},
				checkSchemaExists: async (schema_name) => {
					global.hdb_schema[schema_name] = { ...GLOBAL_SCHEMA_FAKE[schema_name] };
				},
				checkSchemaTableExists: async (schema_name, table_name) => {
					global.hdb_schema[schema_name] = { ...GLOBAL_SCHEMA_FAKE[schema_name] };
				},
			});
		});

		afterEach(() => {
			schema_describe_rw();
		});

		it('Test that validation error is caught and thrown', async () => {
			let error;
			try {
				await schema.dropTable({ operation: 'drop_table', table: '', schema: 'dogs' });
			} catch (err) {
				error = err;
			}

			expect(error.message).to.equal("'table' is not allowed to be empty");
		});

		it('Test stubs are called as expected and success message is returned', async () => {
			let result = await schema.dropTable(DROP_TABLE_OBJECT_TEST);

			expect(purge_table_stream_stub.called).to.be.true;
			expect(bridge_drop_table_stub).to.have.been.calledWith(DROP_TABLE_OBJECT_TEST);
			expect(result.message).to.equal(
				`successfully deleted table '${DROP_TABLE_OBJECT_TEST.schema}.${DROP_TABLE_OBJECT_TEST.table}'`
			);
		});

		it('Test that an error from bridge method drop table is caught and logged', async () => {
			let error_msg = 'Error dropping table';
			bridge_drop_table_stub.throws(new Error(error_msg));
			let test_err_result = await test_util.testError(schema.dropTable(DROP_TABLE_OBJECT_TEST), error_msg);

			expect(test_err_result).to.be.true;
		});

		it('Test table not found error thrown', async () => {
			schema_describe_rw();
			schema_val_stub.resolves('Table does not exist');
			const expected_err = test_util.generateHDBError('Table does not exist', 404);
			await test_util.assertErrorAsync(
				schema.dropTable,
				[{ operation: 'drop_table', schema: 'dog', table: 'cat' }],
				expected_err
			);
			schema_val_stub.restore();
		});
	});

	/**
	 * Tests for dropAttribute function.
	 */
	describe('Drop attribute', function () {
		let bridge_drop_attr_stub;
		let drop_attr_from_global_stub = sandbox.stub();
		let drop_attr_from_global_rw;
		let schema_describe_rw;
		let schema_val_stub;

		before(() => {
			bridge_drop_attr_stub = sandbox.stub(harperBridge, 'dropAttribute');
			drop_attr_from_global_rw = schema.__set__('dropAttributeFromGlobal', drop_attr_from_global_stub);
			schema_val_stub = sandbox.stub(schema_metadata_validator, 'checkSchemaTableExists');
		});

		beforeEach(() => {
			schema_describe_rw = schema.__set__('schemaMetadataValidator', {
				schema_describe: {
					describeSchema: async (describe_schema_object) => {
						({ ...GLOBAL_SCHEMA_FAKE.dogsrule });
					},
					describeTable: async (describe_table_object) => ({ ...GLOBAL_SCHEMA_FAKE.dogsrule.catsdrool }),
				},
				checkSchemaExists: async (schema_name) => {
					global.hdb_schema[schema_name] = { ...GLOBAL_SCHEMA_FAKE[schema_name] };
				},
				checkSchemaTableExists: async (schema_name, table_name) => {
					if (!global.hdb_schema[schema_name] || !global.hdb_schema[schema_name][table_name]) {
						global.hdb_schema[schema_name] = GLOBAL_SCHEMA_FAKE[schema_name];
					}
				},
			});
		});

		afterEach(() => {
			schema_describe_rw();
		});

		after(function () {
			sandbox.restore();
			drop_attr_from_global_rw();
		});

		it('should throw a validation error', async function () {
			let error;
			try {
				await schema.dropAttribute({
					operation: 'drop_attribute',
					schema: SCHEMA_NAME_TEST,
					table: TABLE_NAME_TEST,
				});
			} catch (err) {
				error = err;
			}

			expect(error).to.be.instanceOf(Error);
			expect(error.message).to.equal("'attribute' is required");
		});

		it('should throw cannot drop a hash attribute error', async function () {
			global.hdb_schema = cloneDeep(GLOBAL_SCHEMA_FAKE);
			let error;

			try {
				await schema.dropAttribute(DROP_ATTR_OBJECT_TEST);
			} catch (err) {
				error = err;
			}

			expect(error).to.be.instanceOf(Error);
			expect(error.message).to.equal('You cannot drop a hash attribute');
		});

		it('should call all functions and return a success message', async function () {
			bridge_drop_attr_stub.resolves();
			global.hdb_schema = GLOBAL_SCHEMA_FAKE;
			global.hdb_schema.dogsrule.catsdrool.hash_attribute = 'notid';
			let result = await schema.dropAttribute(DROP_ATTR_OBJECT_TEST);

			expect(bridge_drop_attr_stub).to.have.been.calledWith(DROP_ATTR_OBJECT_TEST);
			expect(result).to.equal(`successfully deleted attribute '${DROP_ATTR_OBJECT_TEST.attribute}'`);
		});

		it('Test error is thrown when trying to drop updated time', async function () {
			bridge_drop_attr_stub.resolves();
			global.hdb_schema = GLOBAL_SCHEMA_FAKE;
			global.hdb_schema.dogsrule.catsdrool.hash_attribute = 'notid';
			let test_obj = test_util.deepClone(DROP_ATTR_OBJECT_TEST);
			test_obj.attribute = '__updatedtime__';
			const expected_err = test_util.generateHDBError('cannot drop internal timestamp attribute: __updatedtime__', 400);
			await test_util.assertErrorAsync(schema.dropAttribute, [test_obj], expected_err);
		});

		it('Test table not found error thrown', async () => {
			schema_describe_rw();
			schema_val_stub.resolves('Table does not exist');
			const expected_err = test_util.generateHDBError('Table does not exist', 404);
			await test_util.assertErrorAsync(schema.dropAttribute, [DROP_ATTR_OBJECT_TEST], expected_err);
			schema_val_stub.restore();
		});
	});

	describe('Test dropAttributeFromGlobal function', () => {
		let drop_attr_from_global = schema.__get__('dropAttributeFromGlobal');

		before(() => {
			global.hdb_schema = {
				[DROP_ATTR_OBJECT_TEST.schema]: {
					[DROP_ATTR_OBJECT_TEST.table]: {
						attributes: [{ attribute: 'id' }],
					},
				},
			};
		});

		it('Test that attribute is removed from global schema', () => {
			drop_attr_from_global(DROP_ATTR_OBJECT_TEST);
			let exists_in_global = global.hdb_schema[DROP_ATTR_OBJECT_TEST.schema][DROP_ATTR_OBJECT_TEST.table]['attributes'];

			expect(exists_in_global.length).to.be.equal(0);
		});
	});

	/**
	 * Tests for createAttribute function.
	 */
	describe('Create attribute', function () {
		let bridge_create_attr_stub;
		let attribute_structure_fake = { message: 'inserted 1 of 1 records', skipped_hashes: '', inserted_hashes: '' };
		sinon.stub(process, 'pid').value('8877');
		let payload_fake = {
			type: 'clustering_payload',
			pid: process.pid,
			clustering_type: 'broadcast',
			id: attribute_structure_fake.id,
			body: CREATE_ATTR_OBJECT_TEST,
		};

		let get_db_stub = sandbox.stub().returns({ dogsrule: { catsdrool: { attributes: [] } } });

		before(function () {
			bridge_create_attr_stub = sandbox.stub(harperBridge, 'createAttribute').resolves(attribute_structure_fake);
			schema.__set__('getDatabases', get_db_stub);
		});

		after(function () {
			delete global.hdb_schema;
			sandbox.restore();
		});

		it('should return attribute structure with clustering off', async function () {
			global.clustering_on = false;
			let result = await schema.createAttribute(CREATE_ATTR_OBJECT_TEST);
			expect(bridge_create_attr_stub).to.have.been.calledWith(CREATE_ATTR_OBJECT_TEST);
			expect(signal_schema_change_stub).to.have.been.calledOnce;
			expect(result).to.equal("attribute 'dogsrule.catsdrool.name' successfully created.");
		});
	});
});
