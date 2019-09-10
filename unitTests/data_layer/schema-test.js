'use strict';
const test_util = require('../test_utils');
test_util.preTestPrep();

// I temporarily change HDB_ROOT to the unit test folder for testing schema and table create/delete functions.
// Afterwards root is set back to original value and temp test folder is deleted.
// This needs to be done before schema.js is called by rewire.
const HDB_ROOT_TEST = '../unitTests/data_layer';
const env = require('../../utility/environment/environmentManager');
const HDB_ROOT_ORIGINAL = env.get('HDB_ROOT');
env.setProperty('HDB_ROOT', HDB_ROOT_TEST);

const chai = require('chai');
const sinon = require('sinon');
const sinon_chai = require('sinon-chai');
const { expect } = chai;
chai.use(sinon_chai);
const fs = require('fs-extra');
const signalling = require('../../utility/signalling');
let insert = require('../../data_layer/insert');
const uuidV4 = require('uuid/v4');
const logger = require('../../utility/logging/harper_logger');
const common = require('../../utility/common_utils');
const schema_validator = require('../../validation/schema_validator');
const util = require('util');
const clonedeep = require('lodash.clonedeep');
const harperBridge = require('../../data_layer/harperBridge/harperBridge');

// Rewire is used at times as stubbing alone doesn't work when stubbing a function
// being called inside another function declared within the same file.
const rewire = require('rewire');
let schema = rewire('../../data_layer/schema');

const SCHEMA_NAME_TEST = 'dogsrule';
const TABLE_NAME_TEST = 'catsdrool';
const HASH_ATT_TEST = 'id';
const FULL_SCHEMA_PATH_TEST = env.get('HDB_ROOT') + '/schema/' + SCHEMA_NAME_TEST;
const TRASH_PATH_TEST = `${HDB_ROOT_TEST}/trash`;
const SCHEMA_CREATE_OBJECT_TEST = {operation: 'create_schema', schema: SCHEMA_NAME_TEST};
const CREATE_TABLE_OBJECT_TEST = {operation: 'create_table', schema: SCHEMA_NAME_TEST, table: TABLE_NAME_TEST, hash_attribute: HASH_ATT_TEST, residence: ''};
const DROP_SCHEMA_OBJECT_TEST = {operation: 'drop_schema', schema: SCHEMA_NAME_TEST};
const DROP_TABLE_OBJECT_TEST = {operation: 'drop_table', schema: SCHEMA_NAME_TEST, table: TABLE_NAME_TEST};
const DROP_ATTR_OBJECT_TEST = {operation: 'drop_attribute', schema: SCHEMA_NAME_TEST, table: TABLE_NAME_TEST, attribute: 'id'};
const CREATE_ATTR_OBJECT_TEST = {schema: SCHEMA_NAME_TEST, table: TABLE_NAME_TEST, attribute: 'name', delegated: false};
const GLOBAL_SCHEMA_FAKE = {
    'dogsrule': {
        'catsdrool': {
            'hash_attribute': 'id'
        }
    }
};

let global_schema_original = clonedeep(global.hdb_schema);

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
describe('Test schema module', function() {
    let signal_schema_change_stub;
    let insert_stub;
    let logger_error_stub;
    let logger_info_stub;
    let schema_validator_stub;
    let search_by_value_stub = sinon.stub();
    let search_by_value_rewire;
    let delete_delete_stub = sinon.stub().resolves();
    let delete_delete_rewire;
    let attr_validator_stub;
    let move_attr_to_trash_rewire;
    let move_folder_to_trash_stub = sinon.stub();
    let move_folder_to_trash_rewire;
    global.hdb_schema = {};
    let sandbox = sinon.createSandbox();

    before(function() {
        env.setProperty('HDB_ROOT', HDB_ROOT_TEST);
        insert_stub = sinon.stub(insert, 'insert');
        signal_schema_change_stub = sinon.stub(signalling, 'signalSchemaChange');
        logger_error_stub = sinon.stub(logger, 'error');
        logger_info_stub = sinon.stub(logger, 'info');
        schema_validator_stub = sinon.stub(schema_validator, 'schema_object');
        search_by_value_rewire = schema.__set__('p_search_search_by_value', search_by_value_stub);
        delete_delete_rewire = schema.__set__('p_delete_delete', delete_delete_stub);
        attr_validator_stub = sinon.stub(schema_validator, 'attribute_object');
    });

    afterEach(function() {
        sinon.resetHistory();
        insert_stub.resolves();
        schema_validator_stub.returns();
    });

    after(function() {
        schema = rewire('../../data_layer/schema');
        sinon.restore();
        test_util.cleanUpDirectories(`${HDB_ROOT_TEST}/schema`);
        test_util.cleanUpDirectories(TRASH_PATH_TEST);
        deleteSchemaTableStruc();
        env.setProperty('HDB_ROOT', HDB_ROOT_ORIGINAL);
        global.schema = global_schema_original;
        search_by_value_rewire();
        delete_delete_rewire();
        sandbox.restore();
    });

    /**
     * Tests for createSchema function.
     */
    describe('Create schema', function() {
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

        it('should catch thrown error from createSchemaStructure', async function() {
            let create_schema_structure_err = `schema ${SCHEMA_NAME_TEST} already exists`;
            create_schema_structure_stub.throws(new Error(create_schema_structure_err));
            let error;

            try {
                await schema.createSchema(SCHEMA_CREATE_OBJECT_TEST);
            } catch(err) {
                error = err;
            }

            expect(error.message).to.equal(create_schema_structure_err);
            expect(create_schema_structure_stub).to.have.been.calledOnce;
            expect(logger_error_stub).to.have.been.calledOnce;
            expect(logger_error_stub).to.have.been.calledWith(error);
        });
    });

    /**
     * Tests for createSchemaStructure function.
     */
    describe('Create schema structure',function() {
        let create_schema_stub = sinon.stub(harperBridge, 'createSchema');

        it('should throw a validation error', async function() {
            let validation_err = 'Schema is required';
            schema_validator_stub.throws(new Error(validation_err));
            let error;

            try {
                await schema.createSchemaStructure(SCHEMA_CREATE_OBJECT_TEST);
            } catch(err) {
              error = err;
            }

            expect(error).to.be.instanceOf(Error);
            expect(error.message).to.equal(validation_err);
            expect(schema_validator_stub).to.have.been.calledOnce;
        });

        it('should throw schema already exists error', async function() {
            global.hdb_schema = clonedeep(GLOBAL_SCHEMA_FAKE);
            let error;

            try {
                await schema.createSchemaStructure(SCHEMA_CREATE_OBJECT_TEST);
            } catch(err) {
                error = err;
            }

            expect(error.message).to.equal(`schema ${SCHEMA_CREATE_OBJECT_TEST.schema} already exists`);
        });

        it('should call bridge and return success message', async () => {
            global.hdb_schema = {schema: 'notDogs'};
            let result = await schema.createSchemaStructure(SCHEMA_CREATE_OBJECT_TEST);

            expect(create_schema_stub).to.have.been.calledWith(SCHEMA_CREATE_OBJECT_TEST);
            expect(result).to.equal(`schema ${SCHEMA_CREATE_OBJECT_TEST.schema} successfully created`)
        });
    });

    /**
     * Tests for createTable function.
     */
    describe('Create table',function() {
        let create_table_struc_stub = sinon.stub();
        schema.__set__('createTableStructure', create_table_struc_stub);

        it('should return valid stub from createTableStructure', async function() {
            let create_table_struc_fake = `table ${CREATE_TABLE_OBJECT_TEST.schema}.${CREATE_TABLE_OBJECT_TEST.table} successfully created.`;
            create_table_struc_stub.resolves(create_table_struc_fake);
            let result = await schema.createTable(CREATE_TABLE_OBJECT_TEST);

            expect(result).to.equal(create_table_struc_fake);
            expect(create_table_struc_stub).to.have.been.calledOnce;
            expect(signal_schema_change_stub).to.have.been.calledOnce;
        });

        it('should catch thrown error from createTableStructure', async function() {
            let create_table_struc_err = 'schema does not exist';
            create_table_struc_stub.throws(new Error(create_table_struc_err));
            let error;

            try {
                await schema.createTable(CREATE_TABLE_OBJECT_TEST);
            } catch(err) {
                error = err;
            }

            expect(error).to.be.instanceOf(Error);
            expect(error.message).to.equal(create_table_struc_err);
            expect(create_table_struc_stub).to.have.been.calledOnce;
            expect(logger_error_stub).to.have.been.calledOnce;
            expect(logger_error_stub).to.have.been.calledWith(error);
        });
    });

    /**
     * Tests for createTableStructure function.
     */
    describe('Create table structure', function() {
        let create_table_validator_stub = sinon.stub(schema_validator, 'create_table_object');
        let residence_validator_stub = sinon.stub(schema_validator, 'validateTableResidence');
        let harper_bridge_stub;


        before(() => {
            harper_bridge_stub = sinon.stub(harperBridge, 'createTable');
            global.hdb_schema = {};
        });


        after(function() {
            CREATE_TABLE_OBJECT_TEST.residence = '';
        });

        afterEach(function () {
            global.clustering_on = true;
            create_table_validator_stub.returns();
        });

        it('should catch thrown error from validation.create_table_object', async function() {
            let create_table_validator_err = 'Table is required';
            create_table_validator_stub.throws(new Error(create_table_validator_err));
            let error;

            try {
                await schema.createTableStructure(CREATE_TABLE_OBJECT_TEST);
            } catch(err) {
                error = err;
            }

            expect(error).to.be.instanceOf(Error);
            expect(error.message).to.equal(create_table_validator_err);
            expect(create_table_validator_stub).to.have.been.calledOnce;
        });

        it('should throw schema does not exist error message', async function() {
            let error;

            try {
                await schema.createTableStructure(CREATE_TABLE_OBJECT_TEST);
            } catch(err) {
               error = err;
            }

            expect(error.message).to.equal(`schema ${CREATE_TABLE_OBJECT_TEST.schema} does not exist`);
            expect(create_table_validator_stub).to.have.been.calledOnce;
            expect(residence_validator_stub).to.have.been.calledOnce;
        });

        it('should throw table already exists error message', async function() {
            let error;
            global.hdb_schema = clonedeep(GLOBAL_SCHEMA_FAKE);

            try {
                await schema.createTableStructure(CREATE_TABLE_OBJECT_TEST);
            } catch(err) {
                error = err;
            }

            expect(error.message).to.equal(`table ${CREATE_TABLE_OBJECT_TEST.table} already exists in schema ${CREATE_TABLE_OBJECT_TEST.schema}`);
            expect(create_table_validator_stub).to.have.been.calledOnce;
            expect(residence_validator_stub).to.have.been.calledOnce;
            global.hdb_schema.dogsrule = {};
        });

        it('should check that table has been inserted with clustering on', async function () {
            CREATE_TABLE_OBJECT_TEST.residence = ['*'];
            global.clustering_on = true;
            let result = await schema.createTableStructure(CREATE_TABLE_OBJECT_TEST);

            expect(result).to.equal(`table ${CREATE_TABLE_OBJECT_TEST.schema}.${CREATE_TABLE_OBJECT_TEST.table} successfully created.`);
        });

        it('should throw clustering not enabled error', async function () {
            global.clustering_on = false;
            let error;

            try {
                await schema.createTableStructure(CREATE_TABLE_OBJECT_TEST);
            } catch(err) {
                error = err;
            }

            expect(error.message).to.equal(`Clustering does not appear to be enabled. Cannot insert table with property 'residence'.`);
            expect(create_table_validator_stub).to.have.been.calledOnce;
            expect(residence_validator_stub).to.have.been.calledOnce;
        });

        it('should call all stubs and return success message', async function() {
            let result = await schema.createTableStructure(CREATE_TABLE_OBJECT_TEST);

            expect(result).to.equal(`table ${CREATE_TABLE_OBJECT_TEST.schema}.${CREATE_TABLE_OBJECT_TEST.table} successfully created.`);
            expect(create_table_validator_stub).to.have.been.calledOnce;
            expect(residence_validator_stub).to.have.been.calledOnce;
        });

        it('should call createTable without setting table.residence', async function () {
            CREATE_TABLE_OBJECT_TEST.residence = null;
            let result = await schema.createTableStructure(CREATE_TABLE_OBJECT_TEST);

            expect(result).to.equal(`table ${CREATE_TABLE_OBJECT_TEST.schema}.${CREATE_TABLE_OBJECT_TEST.table} successfully created.`);
            expect(create_table_validator_stub).to.have.been.calledOnce;
            expect(residence_validator_stub).to.have.been.calledOnce;
        });
    });

    /**
     * Tests for dropSchema function.
     */
    describe('Drop Schema', function() {
        let bridge_drop_schema_stub = sinon.stub(harperBridge, 'dropSchema');

        it('Test that bridge stub is called as expected and success msg is returned', async () => {
            let result = await schema.dropSchema(DROP_SCHEMA_OBJECT_TEST);

            expect(bridge_drop_schema_stub).to.have.been.calledWith(DROP_SCHEMA_OBJECT_TEST);
            expect(signal_schema_change_stub).to.have.been.calledWith({type: 'schema'});
            expect(result).to.equal(`successfully deleted schema ${DROP_SCHEMA_OBJECT_TEST.schema}`);
        });

        it('Test error from bridge drop schema is caught, thrown and logged', async () => {
            let error_msg = 'We have an error on the bridge';
            bridge_drop_schema_stub.throws(new Error(error_msg));
            let test_err_result = await test_util.testError(schema.dropSchema(DROP_SCHEMA_OBJECT_TEST), error_msg);

            expect(test_err_result).to.be.true;
            expect(logger_error_stub).to.have.been.called;
        });

        it('Test schema obj validation catches and throws error', async () => {
            schema_validator_stub.returns('Youve got a problem with your schema object!');
            let error;
            try {
                await schema.dropSchema(DROP_SCHEMA_OBJECT_TEST);
            } catch(err) {
                error = err;
            }

            expect(error).to.equal('Youve got a problem with your schema object!');
        });
    });

    /**
     * Tests for dropTable function.
     */
    describe('Drop table', function() {
        let bridge_drop_table_stub;

        before(() => {
            bridge_drop_table_stub = sandbox.stub(harperBridge, 'dropTable');
        });

        it('Test that validation error is caught and thrown', async () => {
            let test_err_result = await test_util.testError(schema.dropTable({operation: 'drop_table', table: '', schema: "dogs"}), 'Table  is required');

            expect(test_err_result).to.be.true;
        });

        it('Test stubs are called as expected and success message is returned', async () => {
            let result = await schema.dropTable(DROP_TABLE_OBJECT_TEST);

            expect(bridge_drop_table_stub).to.have.been.calledWith(DROP_TABLE_OBJECT_TEST);
            expect(result).to.equal(`successfully deleted table ${DROP_TABLE_OBJECT_TEST.schema}.${DROP_TABLE_OBJECT_TEST.table}`);
        });

        it('Test that an error from bridge method drop table is caught and logged', async () => {
            let error_msg = 'Error dropping table';
            bridge_drop_table_stub.throws(new Error(error_msg));
            let test_err_result = await test_util.testError(schema.dropTable(DROP_TABLE_OBJECT_TEST), error_msg);

            expect(test_err_result).to.be.true;
            expect(logger_error_stub).to.have.been.called;
        });


    });

    /**
     * Tests for dropAttribute function.
     */
    describe('Drop attribute', function() {
        let bridge_drop_attr_stub;
        let drop_attr_from_global_stub = sandbox.stub();
        let drop_attr_from_global_rw;

        before(() => {
            bridge_drop_attr_stub = sandbox.stub(harperBridge, 'dropAttribute');
            drop_attr_from_global_rw = schema.__set__('dropAttributeFromGlobal', drop_attr_from_global_stub);
        });

        after(function() {
            sandbox.restore();
            drop_attr_from_global_rw();
            delete global.hdb_schema[GLOBAL_SCHEMA_FAKE];
        });

        it('should throw a validation error', async function() {
            let validation_err = 'Attribute is required';
            attr_validator_stub.returns(new Error(validation_err));
            let error;

            try {
                await schema.dropAttribute(DROP_ATTR_OBJECT_TEST);
            } catch(err) {
                error = err;
            }

            expect(error).to.be.instanceOf(Error);
            expect(error.message).to.equal(validation_err);
            expect(attr_validator_stub).to.have.been.calledOnce;
        });

        it('should throw cannot drop a hash attribute error', async function() {
            attr_validator_stub.returns();
            global.hdb_schema = clonedeep(GLOBAL_SCHEMA_FAKE);
            let error;

            try {
                await schema.dropAttribute(DROP_ATTR_OBJECT_TEST);
            } catch(err) {
                error = err;
            }

            expect(attr_validator_stub).to.have.been.calledOnce;
            expect(error).to.be.instanceOf(Error);
            expect(error.message).to.equal('You cannot drop a hash attribute');
        });

        it('should throw and log error from bridge drop attribute', async function() {
            // Set global schema hash_attribute to something different than test schema const after last test.
            global.hdb_schema = GLOBAL_SCHEMA_FAKE;
            global.hdb_schema.dogsrule.catsdrool.hash_attribute = 'notid';
            let move_attr_trash_err = 'There was problem moving attribute to trash';
            bridge_drop_attr_stub.throws(new Error(move_attr_trash_err));
            let error;

            try {
                await schema.dropAttribute(DROP_ATTR_OBJECT_TEST);
            } catch(err) {
              error = err;
            }

            expect(error).to.be.instanceOf(Error);
            expect(attr_validator_stub).to.have.been.calledOnce;
            expect(bridge_drop_attr_stub).to.have.been.calledWith(DROP_ATTR_OBJECT_TEST);
            expect(logger_error_stub).to.have.been.calledWith(`Got an error deleting attribute ${util.inspect(DROP_ATTR_OBJECT_TEST)}.`);
            expect(error.message).to.equal(move_attr_trash_err);
        });

        it('should call all functions and return a success message', async function() {
            bridge_drop_attr_stub.resolves();
            global.hdb_schema = GLOBAL_SCHEMA_FAKE;
            global.hdb_schema.dogsrule.catsdrool.hash_attribute = 'notid';
            let result = await schema.dropAttribute(DROP_ATTR_OBJECT_TEST);

            expect(bridge_drop_attr_stub).to.have.been.calledWith(DROP_ATTR_OBJECT_TEST);
            expect(result).to.equal(`successfully deleted attribute '${DROP_ATTR_OBJECT_TEST.attribute}'`);
        });
    });

    describe('Test dropAttributeFromGlobal function', () => {
        let drop_attr_from_global = schema.__get__('dropAttributeFromGlobal');

        before(() => {
            global.hdb_schema = {
                [DROP_ATTR_OBJECT_TEST.schema]: {
                    [DROP_ATTR_OBJECT_TEST.table]: {
                        attributes: [{attribute: 'id'}]
                    }
                }
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
    describe('Create attribute', function() {
        let bridge_create_attr_stub;
        let call_process_send_stub = sinon.stub(common, 'callProcessSend');
        let attribute_structure_fake = {message:'inserted 1 of 1 records', skipped_hashes:'', inserted_hashes:''};
        sinon.stub(process, 'pid').value('8877');
        let payload_fake = {
            "type": "clustering_payload",
            "pid": process.pid,
            "clustering_type": "broadcast",
            "id": attribute_structure_fake.id,
            "body": CREATE_ATTR_OBJECT_TEST
        };

        before(function() {
            bridge_create_attr_stub = sandbox.stub(harperBridge, 'createAttribute').resolves(attribute_structure_fake);
        });

        after(function() {
            sandbox.restore();
        });


        it('should call process send and return attribute structure with clustering on', async function() {
            global.clustering_on = true;

            let result = await schema.createAttribute(CREATE_ATTR_OBJECT_TEST);

            expect(bridge_create_attr_stub).to.have.been.calledOnce;
            expect(bridge_create_attr_stub).to.have.been.calledWith(CREATE_ATTR_OBJECT_TEST);
            expect(call_process_send_stub).to.have.been.calledOnce;
            expect(call_process_send_stub).to.have.been.calledWith(payload_fake);
            expect(signal_schema_change_stub).to.have.been.calledOnce;
            expect(result).to.equal(attribute_structure_fake);
        });

        it('should catch thrown error from callProcessSend', async function() {
            CREATE_ATTR_OBJECT_TEST.delegated = false;
            global.clustering_on = true;
            let call_process_send_err = 'Error with process send';
            call_process_send_stub.throws(new Error(call_process_send_err));
            let error;

            try {
                await schema.createAttribute(CREATE_ATTR_OBJECT_TEST);
            } catch(err) {
                error = err;
            }

            expect(error).to.be.instanceOf(Error);
            expect(error.message).to.equal(call_process_send_err);
            expect(logger_error_stub).to.have.been.calledWith(error);
        });

        it('should return attribute structure with clustering off', async function() {
            global.clustering_on = false;
            let result = await schema.createAttribute(CREATE_ATTR_OBJECT_TEST);
            expect(bridge_create_attr_stub).to.have.been.calledWith(CREATE_ATTR_OBJECT_TEST);
            expect(call_process_send_stub).to.have.been.callCount(0);
            expect(signal_schema_change_stub).to.have.been.calledOnce;
            expect(result).to.equal(attribute_structure_fake);
        });
    });
});
