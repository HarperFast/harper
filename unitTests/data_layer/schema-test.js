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
const global_schema = require('../../utility/globalSchema');
const util = require('util');
const validationWrapper = require('../../validation/validationWrapper');
// Rewire is used at times as stubbing alone doesn't work when stubbing a function
// being called inside another function in same file.
const rewire = require('rewire');
let schema = rewire('../../data_layer/schema');
let schema_validator = require('../../validation/schema_validator');

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
const SCHEMA_CREATE_OBJECT_TEST = {operation: 'create_schema', schema: SCHEMA_NAME_TEST};
const CREATE_TABLE_OBJECT_TEST = {operation: 'create_table', schema: SCHEMA_NAME_TEST, table: TABLE_NAME_TEST, hash_attribute: HASH_ATT_TEST};


describe('Test schema module', function() {
    let signal_schema_change_stub = sinon.stub(signalling, 'signalSchemaChange');

    afterEach(function() {

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

        it('Should return valid stub from createSchemaStructure', async () => {
            let schema_structure_fake = `schema ${SCHEMA_NAME_TEST} successfully created`;
            create_schema_structure_stub.resolves(schema_structure_fake);
            let result = await schema.createSchema(SCHEMA_CREATE_OBJECT_TEST);

            expect(result).to.equal(`schema ${SCHEMA_NAME_TEST} successfully created`);
            expect(create_schema_structure_stub).to.have.been.calledOnce;
            expect(signal_schema_change_stub).to.have.been.calledOnce;
        });

        it('Should catch thrown error from createSchemaStructure', async function() {
            let create_schema_structure_err = `schema ${SCHEMA_NAME_TEST} already exists`;
            create_schema_structure_stub.throws(new Error(create_schema_structure_err));

            try {
                let result = await schema.createSchema(SCHEMA_CREATE_OBJECT_TEST);
            } catch(error) {
                expect(error).to.be.instanceOf(Error);
                expect(error.message).to.equal(create_schema_structure_err);
            }
        });
    });

    describe('Create schema structure',  function() {
        let validation_stub = sinon.stub(schema_validator, 'schema_object');
        let search_for_schema_stub = sinon.stub();
        let insert_stub = sinon.stub(insert, 'insert');

        afterEach(function() {
            // Reset stubs normal behavior 
            validation_stub.returns();
            search_for_schema_stub.resolves([]);
            insert_stub.resolves();
        })

        it('Should throw a validation error', async function() {
            let validation_err = 'Schema is required'
            validation_stub.throws(new Error(validation_err));

            try {
                let result = await schema.createSchemaStructure(SCHEMA_CREATE_OBJECT_TEST);
            } catch(error) {
                expect(error).to.be.instanceOf(Error);
                expect(error.message).to.equal(validation_err);
            }
        });

        it('Should throw schema search error', async function() {
            let schema_search_fake = [{name: `${SCHEMA_NAME_TEST}`}];
            search_for_schema_stub.resolves(schema_search_fake);
            schema.__set__('searchForSchema', search_for_schema_stub);

            try {
                let result = await schema.createSchemaStructure(SCHEMA_CREATE_OBJECT_TEST);
            } catch(error) {
                expect(error).to.equal(`Schema ${SCHEMA_NAME_TEST} already exists`);
            }
        });

        it('Should catch thrown error from insert insert', async function() {
            let insert_err = 'invalid operation, must be insert';
            insert_stub.throws(new Error(insert_err));

            try {
                let result = await schema.createSchemaStructure(SCHEMA_CREATE_OBJECT_TEST);
            } catch(error) {
                expect(error).to.be.instanceOf(Error);
                expect(error.message).to.equal(insert_err);
            }``
        });

        it('Should create directory with test schema name', async function() {
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

        it('Should catch errno directory exists error from fs.mkdir', async function() {
            try {
                let result = await schema.createSchemaStructure(SCHEMA_CREATE_OBJECT_TEST);
            } catch(error) {
                expect(error).to.equal('schema already exists')
            }
        });
    });

    describe('Create table',  function() {
        let create_table_struc_stub = sinon.stub(schema, 'createTable');

        it('Should return valid stub from createTableStructure', async function () {
            let create_table_struc_fake = `table ${CREATE_TABLE_OBJECT_TEST.schema}.${CREATE_TABLE_OBJECT_TEST.table} successfully created.`;
            create_table_struc_stub.resolves(create_table_struc_fake);
            let result = await schema.createTable(CREATE_TABLE_OBJECT_TEST);

            expect(result).to.equal(create_table_struc_fake);
            expect(create_table_struc_stub).to.have.been.calledOnce;
            expect(signal_schema_change_stub).to.have.been.calledOnce;
        });

        it('Should catch thrown error from createTableStructure', async function () {
            let create_table_struc_err = 'schema does not exist';
            create_table_struc_stub.throws(new Error(create_table_struc_err));

            try {
                let result = await schema.createTable(CREATE_TABLE_OBJECT_TEST);
            } catch(error) {
                expect(error).to.be.instanceOf(Error);
                expect(error.message).to.equal(create_table_struc_err);
            }
        });


    });
});
