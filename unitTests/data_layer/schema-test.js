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
const TABLE_NAME_TEST = 'catsdrool' ;
const HASH_ATT_TEST = 'id';
const FULL_SCHEMA_PATH_TEST = env.get('HDB_ROOT') + '/schema/' + SCHEMA_NAME_TEST;
const TRASH_PATH_TEST = `${HDB_ROOT_TEST}/trash`;
const FULL_TABLE_PATH_TEST = FULL_SCHEMA_PATH_TEST + '/' + TABLE_NAME_TEST;
const SCHEMA_CREATE_OBJECT_TEST = {operation: 'create_schema', schema: SCHEMA_NAME_TEST};
const CREATE_TABLE_OBJECT_TEST = {operation: 'create_table', schema: SCHEMA_NAME_TEST, table: TABLE_NAME_TEST, hash_attribute: HASH_ATT_TEST, residence: ''};
const TABLE_TEST = {name: CREATE_TABLE_OBJECT_TEST.table, schema: CREATE_TABLE_OBJECT_TEST.schema, id: uuidV4(), hash_attribute: CREATE_TABLE_OBJECT_TEST.hash_attribute};
const INSERT_OBJECT_TEST = {operation: 'insert', schema: 'system', table: 'hdb_table', hash_attribute: 'id', records: [TABLE_TEST]};
const DROP_SCHEMA_OBJECT_TEST = {operation: 'drop_schema', schema: SCHEMA_NAME_TEST};
const DROP_TABLE_OBJECT_TEST = {operation: 'drop_table', schema: SCHEMA_NAME_TEST, table: TABLE_NAME_TEST};
const DROP_ATTR_OBJECT_TEST = {operation: 'drop_attribute', schema: SCHEMA_NAME_TEST, table: TABLE_NAME_TEST, attribute: 'id'};
const CREATE_ATTR_OBJECT_TEST = {schema: SCHEMA_NAME_TEST, table: TABLE_NAME_TEST, attribute: 'name', delegated: false};
const DATE_SUBSTR_LENGTH = 19;
const GLOBAL_SCHEMA_FAKE = {
    'dogsrule': {
        'catsdrool': {
            'hash_attribute': 'id'
        }
    }
};

let current_date = new Date().toISOString().substr(0, DATE_SUBSTR_LENGTH);
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
    let delete_attr_struct_stub = sinon.stub();
    let delete_attr_struct_rewire;
    let attr_validator_stub;
    let move_schema_to_trash_stub = sinon.stub();
    let move_schema_to_trash_rewire;
    let build_drop_table_obj_stub = sinon.stub();
    let build_drop_table_obj_rewire;
    let move_table_to_trash_stub = sinon.stub();
    let move_table_to_trash_rewire;
    let move_attr_to_trash_rewire;
    let move_folder_to_trash_stub = sinon.stub();
    let move_folder_to_trash_rewire;
    let harper_bridge_stub;
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
        delete_attr_struct_rewire = schema.__set__('deleteAttributeStructure', delete_attr_struct_stub);
        attr_validator_stub = sinon.stub(schema_validator, 'attribute_object');
        build_drop_table_obj_rewire = schema.__set__('buildDropTableObject', build_drop_table_obj_stub);
        move_table_to_trash_rewire = schema.__set__('moveTableToTrash', move_table_to_trash_stub);
        move_folder_to_trash_rewire = schema.__set__('moveFolderToTrash', move_folder_to_trash_stub);
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
        delete_attr_struct_rewire();
        build_drop_table_obj_rewire();
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
        let move_table_trash_stub = sinon.stub();
        let move_table_trash_rewire = schema.__set__('moveTableStructureToTrash', move_table_trash_stub);

        after(function() {
            move_table_trash_rewire();
        });

        it('should return successful stub from moveTableStructureToTrash', async function() {
            let move_table_trash_fake = `successfully deleted table ${TABLE_NAME_TEST}`;
            move_table_trash_stub.resolves(move_table_trash_fake);
            let result = await schema.dropTable(DROP_TABLE_OBJECT_TEST);

            expect(result).to.equal(move_table_trash_fake);
            expect(move_table_trash_stub).to.have.calledWith(DROP_TABLE_OBJECT_TEST);
            expect(move_table_trash_stub).to.have.been.calledOnce;
            expect(signal_schema_change_stub).to.have.been.calledOnce;
        });

        it('should catch thrown errors and send to log', async function() {
            let move_table_trash_err = `There was a problem deleting ${TABLE_NAME_TEST}`;
            move_table_trash_stub.throws(new Error(move_table_trash_err));
            let error;

            try {
                await schema.dropTable(DROP_TABLE_OBJECT_TEST);
            } catch(err) {
                error = err;
            }

            expect(error).to.be.instanceOf(Error);
            expect(error.message).to.equal(move_table_trash_err);
            expect(move_table_trash_stub).to.have.been.calledOnce;
            expect(logger_error_stub).to.have.been.calledOnce;
            expect(logger_error_stub).to.have.been.calledWith(error);
        });
    });

    /**
     * Tests for moveTableStructureToTrash function.
     */
    describe('Move table structure to trash', function() {
        let table_validator_stub = sinon.stub(schema_validator, 'table_object');

        after(function() {
            move_table_to_trash_rewire();
        });

        it('should throw a validation error', async function() {
            let validation_err = 'Table is required';
            table_validator_stub.returns(new Error(validation_err));
            let error;

            try {
                await schema.deleteTableStructure(DROP_TABLE_OBJECT_TEST);
            } catch(err) {
               error = err;
            }

            expect(error).to.be.instanceOf(Error);
            expect(error.message).to.equal(validation_err);
            expect(table_validator_stub).to.have.been.calledOnce;
        });

        it('should catch thrown error from search_value and send to log', async function() {
            let search_by_value_err = 'Error searching for value';
            table_validator_stub.returns();
            search_by_value_stub.throws(new Error(search_by_value_err));
            let error;

            try {
                await schema.deleteTableStructure(DROP_TABLE_OBJECT_TEST);
            } catch(err) {
                error = err;
            }

            expect(error).to.be.instanceOf(Error);
            expect(error.message).to.equal(search_by_value_err);
            expect(search_by_value_stub).to.have.been.calledOnce;
        });

        it('should call all async functions and return success message', async function() {
            let delete_table_object = {
                operation: 'drop_table',
                schema: SCHEMA_NAME_TEST,
                table: TABLE_NAME_TEST
            };
            let search_object = {
                schema: 'system',
                table: 'hdb_table',
                hash_attribute: 'id',
                search_attribute: 'name',
                search_value: TABLE_NAME_TEST  ,
                get_attributes: ['name', 'schema', 'id']
            };
            let search_value = [{name: TABLE_NAME_TEST, schema: SCHEMA_NAME_TEST, id: '123456'}];
            search_by_value_stub.resolves(search_value);
            build_drop_table_obj_stub.returns(delete_table_object);
            let result = await schema.deleteTableStructure(DROP_TABLE_OBJECT_TEST);

            expect(table_validator_stub).to.have.been.calledOnce;
            expect(search_by_value_stub).to.have.been.calledOnce;
            expect(search_by_value_stub).to.have.been.calledWith(search_object);
            expect(build_drop_table_obj_stub).to.have.been.calledOnce;
            expect(build_drop_table_obj_stub).to.have.been.calledWith(DROP_TABLE_OBJECT_TEST, search_value);
            expect(delete_delete_stub).to.have.been.calledOnce;
            expect(delete_delete_stub).to.have.been.calledWith(delete_table_object);
            expect(move_table_to_trash_stub).to.have.been.calledOnce;
            expect(move_table_to_trash_stub).to.have.been.calledWith(DROP_TABLE_OBJECT_TEST);
            expect(delete_attr_struct_stub).to.have.been.calledOnce;
            expect(delete_attr_struct_stub).to.have.been.calledWith(DROP_TABLE_OBJECT_TEST);
            expect(result).to.equal(`successfully deleted table ${SCHEMA_NAME_TEST}.${TABLE_NAME_TEST}`);
        });

    });

    /**
     * Tests for dropAttribute function.
     */
    describe('Drop attribute', function() {
        let bridge_drop_attr_stub;

        before(() => {
            bridge_drop_attr_stub = sandbox.stub(harperBridge, 'dropAttribute');
        });

        after(function() {
            sandbox.restore();
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

    /**
     * Tests for buildDropTableObject function.
     */
    describe('Build drop table object', function() {
        let build_drop_table_obj;
        let data_fake = [{
            name: TABLE_NAME_TEST,
            id: '123456',
            schema: SCHEMA_NAME_TEST
        }];
        let delete_table_object_fake = {
            table: 'hdb_table',
            schema: 'system',
            hash_attribute: 'id',
            hash_values: [ '123456' ]
        };

        before(function() {
            build_drop_table_obj_rewire();
            build_drop_table_obj = schema.__get__('buildDropTableObject');
        });

        it('should throw schema.table was not found error', function() {
            let error;

            try {
                build_drop_table_obj(DROP_TABLE_OBJECT_TEST, [{}]);
            } catch(err) {
               error = err;
            }

            expect(error.message).to.equal(`${DROP_TABLE_OBJECT_TEST.schema}.${DROP_TABLE_OBJECT_TEST.table} was not found`);
        });

        it('should return valid delete table object', function() {
            let result = build_drop_table_obj(DROP_TABLE_OBJECT_TEST, data_fake);

            expect(result).to.deep.equal(delete_table_object_fake);
        });
    });

    /**
     * Tests for moveTableToTrash function.
     */
    describe('Move table to trash', function() {
        let move_table_to_trash;

        before(function() {
            move_folder_to_trash_rewire();
            move_table_to_trash_rewire();
            move_table_to_trash = schema.__get__('moveTableToTrash');

        });

        after(function() {
            deleteSchemaTableStruc();
        });

        it('should catch thrown error', async function() {
            let error;

            try {
                await move_table_to_trash(DROP_TABLE_OBJECT_TEST);
            } catch(err) {
               error = err;
            }

            expect(error).to.be.instanceOf(Error);
            expect(error.message).to.include('no such file or directory');
        });
    });

    /**
     * Tests for moveFolderToTrash function.
     */
    describe('move folder to trash', function() {
        // this function is also tested through move table to trash plus move attribute to trash.
        let move_folder_to_trash;
        let fs_mkdirp_stub;
        let fs_move_stub;

        before(function() {
            move_folder_to_trash_rewire();
            fs_mkdirp_stub = sinon.stub(fs, 'mkdirp');
            fs_move_stub = sinon.stub(fs, 'move');
            move_folder_to_trash = schema.__get__('moveFolderToTrash');
        });

        it('should return false from empty origin_path parameter', async function () {
            let result = await move_folder_to_trash('', TRASH_PATH_TEST);

            expect(result).to.be.false;
        });

        it('should return false from empty trash_path parameter', async function () {
            let result = await move_folder_to_trash(FULL_SCHEMA_PATH_TEST, '');

            expect(result).to.be.false;
        });

        it('should catch and log error from fs.mkdirp', async function() {
            let fs_mkdirp_err = 'Unable to create directory';
            fs_mkdirp_stub.throws(new Error(fs_mkdirp_err));
            let error;

            try {
                await move_folder_to_trash(FULL_SCHEMA_PATH_TEST, TRASH_PATH_TEST);
            } catch(err) {
                error = err;
            }

            expect(error.message).to.equal(fs_mkdirp_err);
            expect(fs_mkdirp_stub).to.have.been.calledOnce;
            expect(logger_error_stub).to.have.been.calledOnce;
            expect(logger_error_stub).to.have.been.calledWith(`Failed to create the trash directory.`);
        });

        it('should catch and log error from fs.mkdirp', async function() {
            let fs_move_err = 'Directorey does not exist';
            fs_mkdirp_stub.resolves();
            fs_move_stub.throws(new Error(fs_move_err));
            let error;

            try {
                await move_folder_to_trash(FULL_SCHEMA_PATH_TEST, TRASH_PATH_TEST);
            } catch(err) {
                error = err;
            }

            expect(error.message).to.equal(fs_move_err);
            expect(fs_mkdirp_stub).to.have.been.calledOnce;
            expect(fs_move_stub).to.have.been.calledOnce;
            expect(logger_error_stub).to.have.been.calledOnce;
            expect(logger_error_stub).to.have.been.calledWith(`Got an error moving path ${FULL_SCHEMA_PATH_TEST} to trash path: ${TRASH_PATH_TEST}`);
        });

        it('should return true without any errors', async function() {
            fs_move_stub.resolves();
            let result = await move_folder_to_trash(FULL_SCHEMA_PATH_TEST, TRASH_PATH_TEST);

            expect(fs_mkdirp_stub).to.have.been.calledOnce;
            expect(fs_move_stub).to.have.been.calledOnce;
            expect(result).to.be.true;
        });
    });

    /**
     * Tests for createAttributeStructure function.
     */
    describe('Create attribute structure', function() {

        it('should throw a validation error', async function() {
            let validation_err = 'Attribute is required';
            attr_validator_stub.returns(validation_err);
            let error;

            try {
                await schema.createAttributeStructure(CREATE_ATTR_OBJECT_TEST);
            } catch(err) {
                error = err;
            }

            expect(error).to.equal(validation_err);
            expect(attr_validator_stub).to.have.been.calledOnce;
        });

        it('should throw attribute already exists error', async function() {
            attr_validator_stub.returns();
            search_by_value_stub.resolves([CREATE_ATTR_OBJECT_TEST]);
            let error;

            try {
                await schema.createAttributeStructure(CREATE_ATTR_OBJECT_TEST);
            } catch(err) {
                error = err;
            }

            expect(error.message).to.equal(`attribute already exists with id ${JSON.stringify(CREATE_ATTR_OBJECT_TEST)}`);
            expect(search_by_value_stub).to.have.been.calledOnce;
            expect(attr_validator_stub).to.have.been.calledOnce;
        });

        it('should log all necessary info and return insert response', async function() {
            search_by_value_stub.resolves();
            let insert_response_fake = {message: 'inserted 1 of 1 records - fake'};
            insert_stub.resolves(insert_response_fake);
            let result = await schema.createAttributeStructure(CREATE_ATTR_OBJECT_TEST);

            expect(attr_validator_stub).to.have.been.calledOnce;
            expect(search_by_value_stub).to.have.been.calledOnce;
            expect(insert_stub).to.have.been.calledOnce;
            expect(logger_info_stub).to.have.been.calledThrice;
            expect(result).to.equal(insert_response_fake);
        });

        it('should catch error from insert', async function () {
            let insert_err = 'Error inserting value';
            insert_stub.throws(new Error(insert_err));
            let error;

            try {
                await schema.createAttributeStructure(CREATE_ATTR_OBJECT_TEST);
            } catch(err) {
                error = err;
            }

            expect(error).to.be.instanceOf(Error);
            expect(error.message).to.equal(insert_err);
            expect(insert_stub).to.have.been.calledOnce;
        });
    });

    /**
     * Tests for createAttribute function.
     */
    describe('Create attribute', function() {
        let create_attr_struc_stub = sinon.stub();
        let call_process_send_stub = sinon.stub(common, 'callProcessSend');
        let create_attr_struc_rewire;
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
            create_attr_struc_rewire = schema.__set__('createAttributeStructure', create_attr_struc_stub);
            create_attr_struc_stub.resolves(attribute_structure_fake);
        });

        after(function() {
            create_attr_struc_rewire();
        });

        it('should call process send and return attribute structure with clustering on', async function() {
            global.clustering_on = true;

            let result = await schema.createAttribute(CREATE_ATTR_OBJECT_TEST);

            expect(create_attr_struc_stub).to.have.been.calledOnce;
            expect(create_attr_struc_stub).to.have.been.calledWith(CREATE_ATTR_OBJECT_TEST);
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
            expect(create_attr_struc_stub).to.have.been.calledOnce;
            expect(create_attr_struc_stub).to.have.been.calledWith(CREATE_ATTR_OBJECT_TEST);
            expect(call_process_send_stub).to.have.been.callCount(0);
            expect(signal_schema_change_stub).to.have.been.calledOnce;
            expect(result).to.equal(attribute_structure_fake);
        });
    });
});
