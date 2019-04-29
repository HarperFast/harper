'use strict';

const chai = require('chai');
const sinon = require('sinon');
const sinon_chai = require('sinon-chai');
const fs = require('fs-extra');
const signalling = require('../../utility/signalling');
const global_schema = require('../../utility/globalSchema');
const util = require('util');
const validationWrapper = require('../../validation/validationWrapper');
const rewire = require('rewire');
let schema = rewire('../../data_layer/schema');

const { expect } = chai;
const sandbox = sinon.createSandbox();
chai.use(sinon_chai);

describe('schema module in data_layer folder', () => {
    let schema_create_object = {operation: 'create_schema', schema: 'dogsrule'};

    beforeEach(() => {
    });

    afterEach(() => {
        sandbox.restore();

    });

    context('create schema', () => {
        // sandbox.stub(signalling, 'signalSchemaChange');

        let stub_create_schema_structure = sandbox.stub();
        let stub_signal_schema_change = sandbox.stub(signalling, 'signalSchemaChange');
        schema.__set__('createSchemaStructure', stub_create_schema_structure);



        sandbox.stub(schema, 'createSchemaStructure').resolves(fake_schema_structure);

        it('should return valid stub from createSchemaStructure', async () => {
            let fake_schema_structure = 'schema dogsrule successfully created';

            // stub_create_schema_structure.resolves(fake_schema_structure);
            let result = await schema.createSchema(schema_create_object);

            expect(result).to.equal('schema dogsrule successfully created');
            // expect(stub_create_schema_structure).to.have.been.calledOnce;
            // expect(stub_signal_schema_change).to.have.been.calledOnce;
        });

        // it('should throw an error', async () => {
        //     stub_create_schema_structure.resolves(new Error('Schema dogsrule already exits'));
        //     let result = await schema.createSchema(schema_create_object);
        //
        //     expect(result).to.be.instanceOf(Error);
        //     expect(result.message).to.equal('Schema dogsrule already exits');
        //     expect(stub_create_schema_structure).to.have.been.calledTwice;
        //     expect(stub_signal_schema_change).to.have.been.calledOnce;
        //
        // });
    });

    // context('create schema structure', () => {
    //     let stub_validation  = sandbox.stub();
    //     sandbox.stub(validationWrapper, 'validateObject').returns(new Error('Schema is required'));
    //
    //     // stub_validation.returns(new Error('Schema is required'));
    //     // schema.__set__('validation.schema_object', stub_validation);
    //
    //     it('should throw a validation error', async () => {
    //
    //         let result = await schema.createSchemaStructure(schema_create_object);
    //
    //         expect(stub_validation).to.have.been.calledOnce;
    //     });
    // });
});
