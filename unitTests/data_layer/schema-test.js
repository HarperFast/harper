'use strict';
const test_util = require('../test_utils');
test_util.preTestPrep();

const chai = require('chai');
const sinon = require('sinon');
const sinon_chai = require('sinon-chai');
const fs = require('fs-extra');
const signalling = require('../../utility/signalling');
let insert = require('../../data_layer/insert');
const env = require('../../utility/environment/environmentManager');
const uuidV4 = require('uuid/v4');
const logger = require('../../utility/logging/harper_logger');

const clone = require('clone');
const global_schema = require('../../utility/globalSchema');
const util = require('util');
const validationWrapper = require('../../validation/validationWrapper');
// Rewire is used at times as stubbing alone doesn't work when stubbing a function
// being called inside another function in same file.
const rewire = require('rewire');
let schema = rewire('../../data_layer/schema');
let schema_validator = require('../../validation/schema_validator');
let search = require('../../data_layer/search');

const { expect } = chai;
chai.use(sinon_chai);

const HDB_ROOT_ORIGINAL = env.get('HDB_ROOT');
const HDB_ROOT_TEST = '../unitTests/data_layer';
// I temporarily change HDB_ROOT to the unit test folder for createSchemaStructure fs.mkdir test.
// Afterwards root is set back to original value and temp test folder is deleted.
env.setProperty('HDB_ROOT', HDB_ROOT_TEST);

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
const DATE_SUBSTR_LENGTH = 19;
let current_date = new Date().toISOString().substr(0, DATE_SUBSTR_LENGTH);

async function buildSchemaTableStruc(){
    let insert_table = schema.__get__('insertTable');
    try {
        fs.mkdir(`${HDB_ROOT_TEST}/schema`);
        await schema.createSchemaStructure(SCHEMA_CREATE_OBJECT_TEST);
        await insert_table(TABLE_TEST, CREATE_TABLE_OBJECT_TEST);
    } catch(err) {
        console.error(err);
    }
}

function deleteSchemaTableStruc() {
    test_util.cleanUpDirectories(`${HDB_ROOT_TEST}/schema`);
    test_util.cleanUpDirectories(TRASH_PATH_TEST);
}

describe('Test schema module', function() {
    let signal_schema_change_stub = sinon.stub(signalling, 'signalSchemaChange');
    let insert_stub = sinon.stub(insert, 'insert');
    let search_by_conditions_stub = sinon.stub();
    schema.__set__('p_search_by_conditions', search_by_conditions_stub);
    let search_for_schema_stub = sinon.stub();
    let search_for_schema_rewire = schema.__set__('searchForSchema', search_for_schema_stub);
    let search_for_table_stub = sinon.stub();
    let search_for_table_rewire = schema.__set__('searchForTable', search_for_table_stub);
    let insert_table_stub = sinon.stub();
    let insert_table_rewire = schema.__set__('insertTable', insert_table_stub);
    let logger_error_stub = sinon.stub(logger, 'error');
    let schema_validator_stub = sinon.stub(schema_validator, 'schema_object');
    let search_by_value_stub = sinon.stub();
    let search_by_value_rewire = schema.__set__('p_search_search_by_value', search_by_value_stub);
    let delete_delete_stub = sinon.stub().resolves();
    let delete_delete_rewire = schema.__set__('p_delete_delete', delete_delete_stub);
    let delete_attr_struct_stub = sinon.stub();
    let delete_attr_struct_rewire = schema.__set__('p_deleteAttributeStructure', delete_attr_struct_stub);
    let attr_validator_stub = sinon.stub(schema_validator, 'attribute_object');
    let move_schema_to_trash_stub = sinon.stub();
    let move_schema_to_trash_rewire = schema.__set__('moveSchemaToTrash', move_schema_to_trash_stub);
    let build_drop_table_obj_stub = sinon.stub();
    let build_drop_table_obj_rewire = schema.__set__('buildDropTableObject', build_drop_table_obj_stub);
    let move_table_to_tash_stub = sinon.stub();
    let move_table_to_trash_rewire = schema.__set__('moveTableToTrash', move_table_to_tash_stub);

    afterEach(function() {
        sinon.resetHistory();
        insert_stub.resolves();
        schema_validator_stub.returns();
    });

    after(function() {
        schema = rewire('../../data_layer/schema');
        sinon.restore();
        // test_util.cleanUpDirectories(`${HDB_ROOT_TEST}/schema`);
        // test_util.cleanUpDirectories(TRASH_PATH_TEST);
        env.setProperty('HDB_ROOT', HDB_ROOT_ORIGINAL);
        search_by_value_rewire();
        delete_delete_rewire();
        delete_attr_struct_rewire();
        move_schema_to_trash_rewire();
        build_drop_table_obj_rewire();
    });

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

            try {
                await schema.createSchema(SCHEMA_CREATE_OBJECT_TEST);
            } catch(error) {
                expect(error).to.be.instanceOf(Error);
                expect(error.message).to.equal(create_schema_structure_err);
                expect(create_schema_structure_stub).to.have.been.calledOnce;
            }
        });
    });

    describe('Create schema structure',  function() {

        it('should throw a validation error', async function() {
            let validation_err = 'Schema is required';
            schema_validator_stub.throws(new Error(validation_err));

            try {
                await schema.createSchemaStructure(SCHEMA_CREATE_OBJECT_TEST);
            } catch(error) {
                expect(error).to.be.instanceOf(Error);
                expect(error.message).to.equal(validation_err);
                expect(schema_validator_stub).to.have.been.calledOnce;
            }
        });

        it('should throw schema search error', async function() {
            let schema_search_fake = [{name: `${SCHEMA_NAME_TEST}`}];
            search_for_schema_stub.resolves(schema_search_fake);

            try {
                await schema.createSchemaStructure(SCHEMA_CREATE_OBJECT_TEST);
            } catch(error) {
                expect(error).to.equal(`Schema ${SCHEMA_NAME_TEST} already exists`);
                expect(search_for_schema_stub).to.have.been.calledOnce;
            }
        });

        it('should catch thrown error from insert insert', async function() {
            search_for_schema_stub.resolves([]);

            let insert_err = 'invalid operation, must be insert';
            insert_stub.throws(new Error(insert_err));

            try {
                await schema.createSchemaStructure(SCHEMA_CREATE_OBJECT_TEST);
            } catch(error) {
                expect(error).to.be.instanceOf(Error);
                expect(error.message).to.equal(insert_err);
                expect(insert_stub).to.have.been.calledOnce;
            }
        });

        it('should create directory with test schema name', async function() {
            try {
                // createSchemaStructure insert.insert expects schema dir to already exist
                // so I am creating a temporary one. All test dirs are removed after test completion.
                fs.mkdir(`${HDB_ROOT_TEST}/schema`);
                let result = await schema.createSchemaStructure(SCHEMA_CREATE_OBJECT_TEST);
                let exists = await fs.pathExists(FULL_SCHEMA_PATH_TEST);

                expect(result).to.equal(`schema ${SCHEMA_NAME_TEST} successfully created`);
                expect(exists).to.be.true;
            } catch(err) {
                console.error(err);
            }
        });

        it('should catch errno directory exists error from fs.mkdir', async function() {
            try {
                await schema.createSchemaStructure(SCHEMA_CREATE_OBJECT_TEST);
            } catch(error) {
                expect(error).to.equal('schema already exists')
            }
        });
    });

    describe('Create table',  function() {
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

            try {
                await schema.createTable(CREATE_TABLE_OBJECT_TEST);
            } catch(error) {
                expect(error).to.be.instanceOf(Error);
                expect(error.message).to.equal(create_table_struc_err);
                expect(create_table_struc_stub).to.have.been.calledOnce;
            }
        });
    });

    describe('Create table structure', function() {
        let create_table_validator_stub = sinon.stub(schema_validator, 'create_table_object');
        let residence_validator_stub = sinon.stub(schema_validator, 'validateTableResidence');

        after(function() {
            CREATE_TABLE_OBJECT_TEST.residence = '';

        })

        afterEach(function () {
            global.clustering_on = true;
            create_table_validator_stub.returns();
            search_for_table_stub.resolves([]);
        });

        it('should catch thrown error from validation.create_table_object', async function() {
            let create_table_validator_err = 'Table is required';
            create_table_validator_stub.throws(new Error(create_table_validator_err));

            try {
                await schema.createTableStructure(CREATE_TABLE_OBJECT_TEST);
            } catch(error) {
                expect(error).to.be.instanceOf(Error);
                expect(error.message).to.equal(create_table_validator_err);
                expect(create_table_validator_stub).to.have.been.calledOnce;
            }
        });

        it('should throw schema does not exist error message', async function() {
            search_for_schema_stub.resolves([]);

            try {
                await schema.createTableStructure(CREATE_TABLE_OBJECT_TEST);
            } catch(error) {
                expect(error).to.equal(`schema ${CREATE_TABLE_OBJECT_TEST.schema} does not exist`)
                expect(create_table_validator_stub).to.have.been.calledOnce;
                expect(residence_validator_stub).to.have.been.calledOnce;
            }
        });

        it('should throw table does not exist error message', async function() {
            search_for_schema_stub.resolves([{SCHEMA_NAME_TEST}]);
            search_for_table_stub.resolves([{TABLE_NAME_TEST}]);

            try {
                await schema.createTableStructure(CREATE_TABLE_OBJECT_TEST);
            } catch(error) {
                expect(error).to.equal(`table ${CREATE_TABLE_OBJECT_TEST.table} already exists in schema ${CREATE_TABLE_OBJECT_TEST.schema}`);
                expect(search_for_schema_stub).to.have.been.calledOnce;
                expect(create_table_validator_stub).to.have.been.calledOnce;
                expect(residence_validator_stub).to.have.been.calledOnce;
            }
        });

        it('should check that table has been inserted with clustering on', async function () {
            CREATE_TABLE_OBJECT_TEST.residence = ['*'];
            global.clustering_on = true;
            let result = await schema.createTableStructure(CREATE_TABLE_OBJECT_TEST);

            expect(insert_table_stub).to.have.been.calledOnce;
            expect(result).to.equal(`table ${CREATE_TABLE_OBJECT_TEST.schema}.${CREATE_TABLE_OBJECT_TEST.table} successfully created.`);
        });

        it('should throw clustering not enabled error', async function () {
            global.clustering_on = false;

            try {
                await schema.createTableStructure(CREATE_TABLE_OBJECT_TEST);
            } catch(error) {
                expect(error).to.equal(`Clustering does not appear to be enabled. Cannot insert table with property 'residence'.`);
                expect(search_for_schema_stub).to.have.been.calledOnce;
                expect(search_for_table_stub).to.have.been.calledOnce;
                expect(create_table_validator_stub).to.have.been.calledOnce;
                expect(residence_validator_stub).to.have.been.calledOnce;
            }
        });

        it('should call all stubs and return success message', async function() {
            let result = await schema.createTableStructure(CREATE_TABLE_OBJECT_TEST);
            expect(result).to.equal(`table ${CREATE_TABLE_OBJECT_TEST.schema}.${CREATE_TABLE_OBJECT_TEST.table} successfully created.`);
            expect(search_for_schema_stub).to.have.been.calledOnce;
            expect(search_for_table_stub).to.have.been.calledOnce;
            expect(create_table_validator_stub).to.have.been.calledOnce;
            expect(residence_validator_stub).to.have.been.calledOnce;
            expect(insert_table_stub).to.have.been.calledOnce;
        });
    });

    describe('Insert table', async function() {
        let insert_table;
        let fs_mkdir_stub;

        //TODO - move these
        const HDB_ROOT_ORIGINAL = env.get('HDB_ROOT');
        const HDB_ROOT_TEST = '../unitTests/data_layer';
        env.setProperty('HDB_ROOT', HDB_ROOT_TEST);

        before(function() {
            insert_table_rewire();
            insert_table = schema.__get__('insertTable');
            fs_mkdir_stub = sinon.stub(fs, 'mkdir');
        });

        it('should call insert.insert with insertObject', async function() {
            await insert_table(TABLE_TEST, CREATE_TABLE_OBJECT_TEST);

            expect(insert_stub).to.have.been.calledWith(INSERT_OBJECT_TEST);
            expect(fs_mkdir_stub).to.have.been.calledOnce;

        });

        it('should create directory with test table name', async function() {
            fs_mkdir_stub.restore();
            try {
                await insert_table(TABLE_TEST, CREATE_TABLE_OBJECT_TEST);

                expect(insert_stub).to.have.been.calledWith(INSERT_OBJECT_TEST);
                let exists = await fs.pathExists(FULL_TABLE_PATH_TEST);
                expect(exists).to.be.true;
            } catch(err) {
                console.error(err);
            }
        });

        it('should catch errno table directory already exists error from fs.mkdir', async function() {
            try {
                await insert_table(TABLE_TEST, CREATE_TABLE_OBJECT_TEST);
            } catch(error) {
                expect(error).to.equal('table already exists')
                expect(insert_stub).to.have.been.calledWith(INSERT_OBJECT_TEST);
            }
        });

        it('should catch errno schema does not exist error from fs.mkdir', async function() {
            // Putting this here as well as at start of file because when running npm test root was not being updated.
            const HDB_ROOT_TEST = '../unitTests/data_layer';
            env.setProperty('HDB_ROOT', HDB_ROOT_TEST);

            try {
                test_util.cleanUpDirectories(`${HDB_ROOT_TEST}/schema`);
                await insert_table(TABLE_TEST, CREATE_TABLE_OBJECT_TEST);
            } catch(error) {
                expect(error).to.equal('schema does not exist');
                expect(insert_stub).to.have.been.calledWith(INSERT_OBJECT_TEST);
            }
        });

        it('should catch thrown error from insert', async function() {
            let insert_err = 'invalid operation';
            insert_stub.throws(new Error(insert_err));
            try {
                await insert_table(TABLE_TEST, CREATE_TABLE_OBJECT_TEST);
            } catch(error) {
                expect(error).to.be.instanceOf(Error);
                expect(error.message).to.equal(insert_err);
            }
        });
    });

    describe('Drop Schema', function() {
        let move_schema_trash_stub = sinon.stub();
        let move_schema_trash_rewire = schema.__set__('moveSchemaStructureToTrash', move_schema_trash_stub);
        let global_hdb_schema_stub = sinon.stub();
        let global_hdb_schema_rewire = schema.__set__('global.hdb_schema', global_hdb_schema_stub);

        after(function() {
            global_hdb_schema_rewire();
            move_schema_trash_rewire();
        });

        it('should return successful stub from moveSchemaStructureToTrash', async function() {
            let move_schema_trash_fake = `successfully deleted schema ${SCHEMA_NAME_TEST}`;
            move_schema_trash_stub.resolves(move_schema_trash_fake);
            let result = await schema.dropSchema(DROP_SCHEMA_OBJECT_TEST);

            expect(result).to.equal(move_schema_trash_fake);
            expect(move_schema_trash_stub).to.have.calledWith(DROP_SCHEMA_OBJECT_TEST);
            expect(move_schema_trash_stub).to.have.been.calledOnce;
            expect(signal_schema_change_stub).to.have.been.calledOnce;
        });

        it('should catch thrown errors and send to log', async function() {
            let move_schema_trash_err = `There was a problem deleting ${SCHEMA_NAME_TEST}`;
            move_schema_trash_stub.throws(new Error(move_schema_trash_err));

            try {
                await schema.dropSchema(DROP_SCHEMA_OBJECT_TEST);
            } catch(error) {
                expect(error).to.be.instanceOf(Error);
                expect(error.message).to.equal(move_schema_trash_err);
                expect(move_schema_trash_stub).to.have.been.calledOnce;
                expect(logger_error_stub).to.have.been.calledOnce;
                expect(logger_error_stub).to.have.been.calledWith(error);
            }
        });
    });

    describe('Move Schema Structure to trash', function() {


        it('should throw a validation error', async function() {
            let validation_err = 'Schema is required';
            schema_validator_stub.returns(new Error(validation_err));

            try {
                await schema.deleteSchemaStructure(DROP_SCHEMA_OBJECT_TEST);
            } catch(error) {
                expect(error).to.be.instanceOf(Error);
                expect(error.message).to.equal(validation_err);
                expect(schema_validator_stub).to.have.been.calledOnce;
            }
        });

        it('should call all async functions as expected and return success message', async function () {
            let delete_schema_object = {
                table: "hdb_schema",
                schema: "system",
                hash_values: [DROP_SCHEMA_OBJECT_TEST.schema]
            };
            let search_object = {
                schema: 'system',
                table: 'hdb_table',
                hash_attribute: 'id',
                search_attribute: 'schema',
                search_value: DROP_SCHEMA_OBJECT_TEST.schema,
                get_attributes: ['id']
            };
            let search_value = [{id: '123456'}];
            // build_drop_schema_obj_stub.resolves(search_object);
            search_by_value_stub.resolves(search_value);
            let result = await schema.deleteSchemaStructure(DROP_SCHEMA_OBJECT_TEST);

            expect(schema_validator_stub).to.have.been.calledOnce;
            expect(delete_delete_stub).to.have.been.calledOnce;
            expect(delete_delete_stub).to.have.been.calledWith(delete_schema_object);
            expect(search_by_value_stub).to.have.been.calledOnce;
            expect(search_by_value_stub).to.have.been.calledWith(search_object);
            expect(move_schema_to_trash_stub).to.have.been.calledOnce;
            expect(move_schema_to_trash_stub).to.have.been.calledWith(DROP_SCHEMA_OBJECT_TEST, search_value);
            expect(delete_attr_struct_stub).to.have.been.calledOnce;
            expect(delete_attr_struct_stub).to.have.been.calledWith(DROP_SCHEMA_OBJECT_TEST);
            expect(result).to.equal(`successfully deleted schema ${DROP_SCHEMA_OBJECT_TEST.schema}`)

        });
    });

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

            try {
                await schema.dropTable(DROP_TABLE_OBJECT_TEST);
            } catch(error) {
                expect(error).to.be.instanceOf(Error);
                expect(error.message).to.equal(move_table_trash_err);
                expect(move_table_trash_stub).to.have.been.calledOnce;
                expect(logger_error_stub).to.have.been.calledOnce;
                expect(logger_error_stub).to.have.been.calledWith(error);
            }
        });

    });

    describe('Move table structure to trash', function() {
        let table_validator_stub = sinon.stub(schema_validator, 'table_object');

        after(function() {
            move_table_to_trash_rewire();
        });

        it('should throw a validation error', async function() {
            let validation_err = 'Table is required';
            table_validator_stub.returns(new Error(validation_err));

            try {
                await schema.deleteTableStructure(DROP_TABLE_OBJECT_TEST);
            } catch(error) {
                expect(error).to.be.instanceOf(Error);
                expect(error.message).to.equal(validation_err);
                expect(table_validator_stub).to.have.been.calledOnce;
            }
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
            table_validator_stub.returns();
            search_by_value_stub.resolves(search_value);
            build_drop_table_obj_stub.resolves(delete_table_object);
            let result = await schema.deleteTableStructure(DROP_TABLE_OBJECT_TEST);

            expect(table_validator_stub).to.have.been.calledOnce;
            expect(search_by_value_stub).to.have.been.calledOnce;
            expect(search_by_value_stub).to.have.been.calledWith(search_object);
            expect(build_drop_table_obj_stub).to.have.been.calledOnce;
            expect(build_drop_table_obj_stub).to.have.been.calledWith(DROP_TABLE_OBJECT_TEST, search_value);
            expect(delete_delete_stub).to.have.been.calledOnce;
            expect(delete_delete_stub).to.have.been.calledWith(delete_table_object);
            expect(move_table_to_tash_stub).to.have.been.calledOnce;
            expect(move_table_to_tash_stub).to.have.been.calledWith(DROP_TABLE_OBJECT_TEST);
            expect(delete_attr_struct_stub).to.have.been.calledOnce;
            expect(delete_attr_struct_stub).to.have.been.calledWith(DROP_TABLE_OBJECT_TEST);
            expect(result).to.equal(`successfully deleted table ${SCHEMA_NAME_TEST}.${TABLE_NAME_TEST}`);
        });

    });
    
    describe('Drop attribute', function() {
        let move_attr_to_trash_stub = sinon.stub();
        let move_attr_to_trash_rewire = schema.__set__('moveAttributeToTrash', move_attr_to_trash_stub);
        const global_schema_fake = {
            'dogsrule': {
                'catsdrool': {
                    'hash_attribute': 'id'
                }
            }
        };

        after(function() {
            move_attr_to_trash_rewire();
            delete global.hdb_schema[global_schema_fake];
        });

        it('should throw a validation error', async function() {
            let validation_err = 'Attribute is required';
            attr_validator_stub.returns(validation_err);

            try {
                await schema.dropAttribute(DROP_ATTR_OBJECT_TEST);
            } catch(error) {
                expect(error).to.be.instanceOf(Error);
                expect(error.message).to.equal(validation_err);
                expect(attr_validator_stub).to.have.been.calledOnce;
            }
        });

        it('should throw cannot drop a hash attribute error', async function() {
            attr_validator_stub.returns();

            global.hdb_schema = global_schema_fake;

            try {
                await schema.dropAttribute(DROP_ATTR_OBJECT_TEST);
            } catch(error) {
                expect(attr_validator_stub).to.have.been.calledOnce;
                expect(error).to.be.instanceOf(Error);
                expect(error.message).to.equal('You cannot drop a hash attribute');
            }
        });

        it('should throw and log error from moveAttributeToTrash', async function() {
            // Set global schema hash_attribute to something different than test schema const after last test.
            global.hdb_schema.dogsrule.catsdrool.hash_attribute = 'notid';
            let move_attr_trash_err = 'There was problem moving attribute to trash';
            move_attr_to_trash_stub.throws(new Error(move_attr_trash_err));

            try {
                await schema.dropAttribute(DROP_ATTR_OBJECT_TEST);
            } catch(error) {
                expect(error).to.be.instanceOf(Error);
                expect(attr_validator_stub).to.have.been.calledOnce;
                expect(move_attr_to_trash_stub).to.have.been.calledOnce;
                expect(move_attr_to_trash_stub).to.have.been.calledWith(DROP_ATTR_OBJECT_TEST);
                expect(logger_error_stub).to.have.been.calledWith(`Got an error deleting attribute ${util.inspect(DROP_ATTR_OBJECT_TEST)}.`);
                expect(error.message).to.equal(move_attr_trash_err);
            }
        });

        it('should call all functions and return a success message', async function() {
            let move_attr_to_trash_fake = 'Attribute successfully moved to trash';
            move_attr_to_trash_stub.resolves(move_attr_to_trash_fake);
            let result = await schema.dropAttribute(DROP_ATTR_OBJECT_TEST);

            expect(attr_validator_stub).to.have.been.calledOnce;
            expect(move_attr_to_trash_stub).to.have.been.calledOnce;
            expect(move_attr_to_trash_stub).to.have.been.calledWith(DROP_ATTR_OBJECT_TEST);
            expect(result).to.equal(move_attr_to_trash_fake);
        });
    });

    describe('Move schema to trash', function() {
        let move_schema_to_trash;
        let insert_table;
        let tables = [{id: '123456'}];

        before(function() {
            move_schema_to_trash_rewire();
            move_schema_to_trash = schema.__get__('moveSchemaToTrash');
            insert_table = schema.__get__('insertTable');
        });

        after(function() {
            deleteSchemaTableStruc();
        });

        it('should throw drop_schema_object was not found error ', async function () {
            try {
                await move_schema_to_trash('', TABLE_NAME_TEST);
            } catch(error) {
                expect(error).to.equal('drop_schema_object was not found.');
            }
        });

        it('should throw tables parameter was null error ', async function () {
            try {
                await move_schema_to_trash(DROP_SCHEMA_OBJECT_TEST, '');
            } catch(error) {
                expect(error).to.equal('tables parameter was null.');
            }
        });

        it('should make trash dir and move test schema to it', async function () {
            search_for_schema_stub.resolves();
            let destination_name = `${DROP_SCHEMA_OBJECT_TEST.schema}-${current_date}`;
            let delete_table_object_fake = {
                table: "hdb_table",
                schema: "system",
                hash_values: ['123456']
            };

            try {
                // Make a temporary schema and table setup in unit test dir then move it to trash.
                await buildSchemaTableStruc();
                await move_schema_to_trash(DROP_SCHEMA_OBJECT_TEST, tables);
                // Test that temp setup has been moved to test trash dir and doesnt exist in test schema dir
                let exists_in_trash = await fs.pathExists(`${TRASH_PATH_TEST}/${destination_name}`);
                let doesnt_exist_in_schema = await fs.pathExists(FULL_SCHEMA_PATH_TEST);

                expect(exists_in_trash).to.be.true;
                expect(doesnt_exist_in_schema).to.be.false;
                expect(delete_delete_stub).to.have.been.calledOnce;
                expect(delete_delete_stub).to.have.been.calledWith(delete_table_object_fake);
            } catch(err) {
                console.error(err);
            }
        });

        it('should catch thrown error', async function() {
            try {
                await move_schema_to_trash(DROP_SCHEMA_OBJECT_TEST, tables);
            } catch(error) {
                expect(error).to.be.instanceOf(Error);
                expect(error.message).to.include('no such file or directory');
            }
        })
    });

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

        it('should throw schema.table was not found error', async function() {
            try {
                await build_drop_table_obj(DROP_TABLE_OBJECT_TEST, [{}]);
            } catch(error) {
                expect(error).to.equal(`${DROP_TABLE_OBJECT_TEST.schema}.${DROP_TABLE_OBJECT_TEST.table} was not found`);
            }
        });

        it('should return valid delete table object', async function() {
            let result = await build_drop_table_obj(DROP_TABLE_OBJECT_TEST, data_fake);

            expect(result).to.deep.equal(delete_table_object_fake);
        });
    });

    describe('Move table to trash', function() {
        let move_table_to_trash;

        before(function() {
            move_table_to_trash_rewire();
            move_table_to_trash = schema.__get__('moveTableToTrash');
        });

        after(function() {
            deleteSchemaTableStruc();
        });

        it('should make trash dir and move test table to it', async function() {
            let destination_name = `${DROP_TABLE_OBJECT_TEST.table}-${current_date}`;
            try {
                await buildSchemaTableStruc();
                await move_table_to_trash(DROP_TABLE_OBJECT_TEST);
                let exists_in_trash = await fs.pathExists(`${TRASH_PATH_TEST}/${destination_name}`);
                let doesnt_exist_in_schema = await fs.pathExists(FULL_TABLE_PATH_TEST);

                expect(exists_in_trash).to.be.true;
                expect(doesnt_exist_in_schema).to.be.false;
            } catch(err) {
                console.error(err);
            }
        });

        it('should catch thrown error', async function() {
            try {
                await move_table_to_trash(DROP_TABLE_OBJECT_TEST);
            } catch(error) {
                expect(error).to.be.instanceOf(Error);
                expect(error.message).to.include('no such file or directory');
            }
        })
    });

    describe('Drop attribute from system', function() {

    });































    describe('Search for schema', function() {
        let search_for_schema;

        before(function() {
            // This resets searchForSchema() as it was previously stubbed
            search_for_schema_rewire();
            search_for_schema = schema.__get__('searchForSchema');

        });

        it('should return valid stub from searchByConditions', async function() {
            let search_by_conditions_fake = [{SCHEMA_NAME_TEST}];
            search_by_conditions_stub.resolves(search_by_conditions_fake);
            let result = await search_for_schema(SCHEMA_NAME_TEST);

            expect(result).to.equal(search_by_conditions_fake);
            expect(search_by_conditions_stub).to.have.been.calledOnce;
        });

        it('should catch thrown error from searchByConditions', async function() {
            let search_by_conditions_err = `${SCHEMA_NAME_TEST} does not exist`;
            search_by_conditions_stub.throws(new Error(search_by_conditions_err));

            try {
                let result = await search_for_schema(SCHEMA_NAME_TEST);
            } catch(error) {
                expect(error).to.be.instanceOf(Error);
                expect(error.message).to.equal(search_by_conditions_err);
                expect(search_by_conditions_stub).to.have.been.calledOnce;
            }
        });
    });

    describe('Search for table', function() {
        let search_for_table;


        before(function() {
            // This resets searchForTable as it was previously stubbed
            search_for_table_rewire();
            search_for_table = schema.__get__('searchForTable');
        });

        it('should return valid stub from searchByConditions', async function() {
            let search_by_conditions_fake = [{TABLE_NAME_TEST}];
            search_by_conditions_stub.resolves(search_by_conditions_fake);
            let result = await search_for_table(TABLE_NAME_TEST);

            expect(result).to.equal(search_by_conditions_fake);
            expect(search_by_conditions_stub).to.have.been.calledOnce;
        });

        it('should catch thrown error from searchByConditions', async function() {
            let search_by_conditions_err = `${TABLE_NAME_TEST} does not exist`;
            search_by_conditions_stub.throws(new Error(search_by_conditions_err));

            try {
                let result = await search_for_table(TABLE_NAME_TEST);
            } catch(error) {
                expect(error).to.be.instanceOf(Error);
                expect(error.message).to.equal(search_by_conditions_err);
                expect(search_by_conditions_stub).to.have.been.calledOnce;
            }
        });
    });

});
