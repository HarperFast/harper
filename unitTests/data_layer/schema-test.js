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
const FULL_TABLE_PATH_TEST = FULL_SCHEMA_PATH_TEST + '/' + TABLE_NAME_TEST;
const SCHEMA_CREATE_OBJECT_TEST = {operation: 'create_schema', schema: SCHEMA_NAME_TEST};
const CREATE_TABLE_OBJECT_TEST = {operation: 'create_table', schema: SCHEMA_NAME_TEST, table: TABLE_NAME_TEST, hash_attribute: HASH_ATT_TEST, residence: ''};
const TABLE_TEST = {name: CREATE_TABLE_OBJECT_TEST.table, schema: CREATE_TABLE_OBJECT_TEST.schema, id: uuidV4(), hash_attribute: CREATE_TABLE_OBJECT_TEST.hash_attribute};
const INSERT_OBJECT_TEST = {operation: 'insert', schema: 'system', table: 'hdb_table', hash_attribute: 'id', records: [TABLE_TEST]};



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

    afterEach(function() {
        sinon.resetHistory();
        insert_stub.resolves();
    });

    after(function() {
        schema = rewire('../../data_layer/schema');
        sinon.restore();
        test_util.cleanUpDirectories(`${HDB_ROOT_TEST}/schema`);
        env.setProperty('HDB_ROOT', HDB_ROOT_ORIGINAL);
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
                let result = await schema.createSchema(SCHEMA_CREATE_OBJECT_TEST);
            } catch(error) {
                expect(error).to.be.instanceOf(Error);
                expect(error.message).to.equal(create_schema_structure_err);
                expect(create_schema_structure_stub).to.have.been.calledOnce;
            }
        });
    });

    describe('Create schema structure',  function() {
        let schema_validator_stub = sinon.stub(schema_validator, 'schema_object');


        afterEach(function() {
            // Reset stubs normal behavior 
            schema_validator_stub.returns();
        });

        it('should throw a validation error', async function() {
            let validation_err = 'Schema is required';
            schema_validator_stub.throws(new Error(validation_err));

            try {
                let result = await schema.createSchemaStructure(SCHEMA_CREATE_OBJECT_TEST);
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
                let result = await schema.createSchemaStructure(SCHEMA_CREATE_OBJECT_TEST);
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
                let result = await schema.createSchemaStructure(SCHEMA_CREATE_OBJECT_TEST);
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
                let result = await schema.createSchemaStructure(SCHEMA_CREATE_OBJECT_TEST);
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
                let result = await schema.createTable(CREATE_TABLE_OBJECT_TEST);
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
                let result = await schema.createTableStructure(CREATE_TABLE_OBJECT_TEST);
            } catch(error) {
                expect(error).to.be.instanceOf(Error);
                expect(error.message).to.equal(create_table_validator_err);
                expect(create_table_validator_stub).to.have.been.calledOnce;
            }
        });

        it('should throw schema does not exist error message', async function() {
            search_for_schema_stub.resolves([]);

            try {
                let result = await schema.createTableStructure(CREATE_TABLE_OBJECT_TEST);
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
                let result = await schema.createTableStructure(CREATE_TABLE_OBJECT_TEST);
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
                let result = await schema.createTableStructure(CREATE_TABLE_OBJECT_TEST);
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

        const HDB_ROOT_ORIGINAL = env.get('HDB_ROOT');
        const HDB_ROOT_TEST = '../unitTests/data_layer';
        env.setProperty('HDB_ROOT', HDB_ROOT_TEST);

        before(function() {
            insert_table_rewire();
            insert_table = schema.__get__('insertTable');
            fs_mkdir_stub = sinon.stub(fs, 'mkdir');
        });

        beforeEach(function(){

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
