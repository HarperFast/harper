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
const rewire = require('rewire');
let schema = require('../../data_layer/schema');
let schema_validator = rewire('../../validation/schema_validator');

const { expect } = chai;
chai.use(sinon_chai);

const TEST_SCHEMA_NAME = 'dogsrule';
const TEST_FULL_SCHEMA_PATH = env.get('HDB_ROOT') + '/schema/' + TEST_SCHEMA_NAME;

global.hdb_schema = {
    "system": {
        "hdb_table": {
            "hash_attribute": "id",
            "name": "hdb_table",
            "schema": "system",
            "residence": [
                "*"
            ],
            "attributes": [
                {
                    "attribute": "id"
                },
                {
                    "attribute": "name"
                },
                {
                    "attribute": "hash_attribute"
                },
                {
                    "attribute": "schema"
                }
            ]
        },
        "hdb_drop_schema": {
            "hash_attribute": "id",
            "name": "hdb_drop_schema",
            "schema": "system",
            "residence": [
                "*"
            ]
        },
        "hdb_attribute": {
            "hash_attribute": "id",
            "name": "hdb_attribute",
            "schema": "system",
            "residence": [
                "*"
            ]
        },
        "hdb_schema": {
            "hash_attribute": "name",
            "name": "hdb_schema",
            "schema": "system",
            "residence": [
                "*"
            ],
            "attributes": [
                {
                    "attribute": "name"
                },
                {
                    "attribute": "createddate"
                }
            ]
        },
        "hdb_user": {
            "hash_attribute": "username",
            "name": "hdb_user",
            "schema": "system",
            "residence": [
                "*"
            ]
        },
        "hdb_role": {
            "hash_attribute": "id",
            "name": "hdb_user",
            "schema": "system",
            "residence": [
                "*"
            ]
        },
        "hdb_license": {
            "hash_attribute": "license_key",
            "name": "hdb_license",
            "schema": "system"
        },
        "hdb_nodes": {
            "hash_attribute": "name",
            "residence": [
                "*"
            ]
        },
        "hdb_queue": {
            "hash_attribute": "id",
            "name": "hdb_queue",
            "schema": "system",
            "residence": [
                "*"
            ]
        }
    }
}

describe('Test schema module', function() {
    let schema_create_object = {operation: 'create_schema', schema: TEST_SCHEMA_NAME};
    let create_schema_structure_stub;
    let signal_schema_change_stub = sinon.stub(signalling, 'signalSchemaChange');

    afterEach(function() {
        // sinon.restore();
    });


    after(() => {

    });



    it('Should return valid stub from createSchemaStructure', async function() {
        let fake_schema_structure = `schema ${TEST_SCHEMA_NAME} successfully created`;
        create_schema_structure_stub = sinon.stub(schema, 'createSchemaStructure');

        let result = await schema.createSchema(schema_create_object);
    });

    // context('Create schema', function() {
    //     signal_schema_change_stub = sinon.stub(signalling, 'signalSchemaChange');
    //
    //     it('Should return valid stub from createSchemaStructure', async function() {
    //         let fake_schema_structure = `schema ${TEST_SCHEMA_NAME} successfully created`;
    //         create_schema_structure_stub = sinon.stub(schema, 'createSchemaStructure');
    //
    //         let result = await schema.createSchema(schema_create_object);
    //     });
    // });


    // describe('Create schema', function() {
    //     let stub_create_schema_structure = sinon.stub();
    //     let stub_signal_schema_change = sinon.stub(signalling, 'signalSchemaChange');
    //     schema.__set__('createSchemaStructure', stub_create_schema_structure);
    //
    //     it('Should return valid stub from createSchemaStructure', async () => {
    //         let fake_schema_structure = `schema ${TEST_SCHEMA_NAME} successfully created`;
    //         stub_create_schema_structure.resolves(fake_schema_structure);
    //         let result = await schema.createSchema(schema_create_object);
    //
    //         expect(result).to.equal(`schema ${TEST_SCHEMA_NAME} successfully created`);
    //         expect(stub_create_schema_structure).to.have.been.calledOnce;
    //         expect(stub_signal_schema_change).to.have.been.calledOnce;
    //     });
    //
    //     it('Should throw an error', async function() {
    //         stub_create_schema_structure.throws(new Error(`schema ${TEST_SCHEMA_NAME} successfully created`));
    //
    //         try {
    //             let result = await schema.createSchema(schema_create_object);
    //         } catch(error) {
    //             expect(error).to.be.instanceOf(Error);
    //             expect(error.message).to.equal(`schema ${TEST_SCHEMA_NAME} successfully created`);
    //         }
    //     });
    // });
    //
    // describe('Create schema structure', async function() {
    //     let stub_validation = sinon.stub();
    //     let stub_search_for_schema = sinon.stub();
    //
    //     schema.__set__('validation.schema_object', stub_validation);
    //
    //     it('Should throw a validation error', async function() {
    //         let stub_insert = sinon.stub(insert, 'insert');
    //         stub_validation.throws(new Error('Schema is required'));
    //
    //         try {
    //             let result = await schema.createSchemaStructure(schema_create_object);
    //         } catch(error) {
    //             expect(error).to.be.instanceOf(Error);
    //             expect(error.message).to.equal('Schema is required');
    //         }
    //     });
    //
    //     it('Should throw schema search error', async function() {
    //         // stub wasn't resetting after previous test so re-stubbing it
    //         stub_validation.returns();
    //         let fake_schema_search = [{name: `${TEST_SCHEMA_NAME}`}];
    //         stub_search_for_schema.resolves(fake_schema_search);
    //         schema.__set__('searchForSchema', stub_search_for_schema);
    //
    //         try {
    //             let result = await schema.createSchemaStructure(schema_create_object);
    //         } catch(error) {
    //             expect(error).to.equal(`Schema ${TEST_SCHEMA_NAME} already exists`);
    //         }
    //     });
    //
    //     // TODO - we should be testing throw from insert
    //     it('Should catch error from insert insert', async function() {
    //
    //     });
    //
    //     it('Should create directory with test schema name', async function() {
    //         // stub wasn't resetting after previous test so re-stubbing it
    //         stub_search_for_schema.resolves([]);
    //
    //         try {
    //             let result = await schema.createSchemaStructure(schema_create_object);
    //             let exists = await fs.pathExists(TEST_FULL_SCHEMA_PATH);
    //
    //             expect(result).to.equal(`schema ${TEST_SCHEMA_NAME} successfully created`);
    //             expect(exists).to.be.true;
    //         } catch(err) {
    //             console.error(err);
    //         }
    //     });
    //
    //     it('Should catch errno directory exists error from fs', async function() {
    //         try {
    //             let result = await schema.createSchemaStructure(schema_create_object);
    //         } catch(err) {
    //             expect(err).to.equal('schema already exists')
    //         }
    //     });
    //
    //
    //
    // });
});
