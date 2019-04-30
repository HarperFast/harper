'use strict';
const test_util = require('../test_utils');
test_util.preTestPrep();

const chai = require('chai');
const sinon = require('sinon');
const sinon_chai = require('sinon-chai');
const fs = require('fs-extra');
const signalling = require('../../utility/signalling');
const env = require('../../utility/environment/environmentManager');
const global_schema = require('../../utility/globalSchema');
const util = require('util');
const validationWrapper = require('../../validation/validationWrapper');
const rewire = require('rewire');
let schema = rewire('../../data_layer/schema');
let schema_validator = rewire('../../validation/schema_validator');
let insert = require('../../data_layer/insert');

const { expect } = chai;
const sandbox = sinon.createSandbox();
chai.use(sinon_chai);

const TEST_SCHEMA_NAME = 'dogsrule';
const TEST_FULL_SCHEMA_PATH = env.get('HDB_ROOT') + '/schema/' + TEST_SCHEMA_NAME;

describe('schema module in data_layer folder', () => {
    let schema_create_object = {operation: 'create_schema', schema: TEST_SCHEMA_NAME};

    after(async () => {
        try {
            test_util.cleanUpDirectories(TEST_FULL_SCHEMA_PATH);
        } catch(err) {
            console.error(err);
        }
    });

    afterEach(() => {
        sandbox.restore();
    });

    context('create schema', () => {
        let stub_create_schema_structure = sandbox.stub();
        let stub_signal_schema_change = sandbox.stub(signalling, 'signalSchemaChange');
        schema.__set__('createSchemaStructure', stub_create_schema_structure);

        it('should return valid stub from createSchemaStructure', async () => {
            let fake_schema_structure = `schema ${TEST_SCHEMA_NAME} successfully created`;
            stub_create_schema_structure.resolves(fake_schema_structure);
            let result = await schema.createSchema(schema_create_object);

            expect(result).to.equal(`schema ${TEST_SCHEMA_NAME} successfully created`);
            expect(stub_create_schema_structure).to.have.been.calledOnce;
            expect(stub_signal_schema_change).to.have.been.calledOnce;
        });

        it('should throw an error', async () => {
            stub_create_schema_structure.throws(new Error(`schema ${TEST_SCHEMA_NAME} successfully created`));

            try {
                let result = await schema.createSchema(schema_create_object);
            } catch(error) {
                expect(error).to.be.instanceOf(Error);
                expect(error.message).to.equal(`schema ${TEST_SCHEMA_NAME} successfully created`);
            }
        });
    });

    context('create schema structure', () => {
        let stub_validation = sandbox.stub();
        let stub_search_for_schema = sandbox.stub();
        let stub_insert_insert = sandbox.stub();
        schema.__set__('validation.schema_object', stub_validation);
        schema.__set__('insert.insert', stub_insert_insert);

        it('should throw a validation error', async () => {
            stub_validation.throws(new Error('Schema is required'));

            try {
                let result = await schema.createSchemaStructure(schema_create_object);
            } catch(error) {
                expect(error).to.be.instanceOf(Error);
                expect(error.message).to.equal('Schema is required');
            }
        });

        it('should throw schema search error', async () => {
            // stub wasn't resetting after previous test so re-stubbing it
            stub_validation.returns();
            let fake_schema_search = [{name: `${TEST_SCHEMA_NAME}`}];
            stub_search_for_schema.resolves(fake_schema_search);
            schema.__set__('searchForSchema', stub_search_for_schema);

            try {
                let result = await schema.createSchemaStructure(schema_create_object);
            } catch(error) {
                expect(error).to.equal(`Schema ${TEST_SCHEMA_NAME} already exists`);
            }
        });

        it('should create directory with test schema name', async () => {
            // stub wasn't resetting after previous test so re-stubbing it
            stub_search_for_schema.resolves([]);

            try {
                let result = await schema.createSchemaStructure(schema_create_object);
                let exists = await fs.pathExists(TEST_FULL_SCHEMA_PATH);

                expect(result).to.equal(`schema ${TEST_SCHEMA_NAME} successfully created`);
                expect(exists).to.be.true;
                expect(stub_insert_insert).to.have.been.calledOnce;
            } catch(err) {
                console.error(err);
            }
        });
        
        it('should catch errno directory exists error from fs', async () => {
            try {
                let result = await schema.createSchemaStructure(schema_create_object);
            } catch(err) {
                expect(err).to.equal('schema already exists')
            }
        });


    });
});
