'use strict';

const chai = require('chai');
const sinon = require('sinon');
const sinon_chai = require('sinon-chai');
const fs = require('fs-extra');
const schema = require('../../data_layer/schema');
const signalling = require('../../utility/signalling');
const util = require('util');

const { expect } = chai;
const sandbox = sinon.createSandbox();
chai.use(sinon_chai);

describe('schema module in data_layer folder', () => {
    let stub_signal_schema_change;
    let stub_create_schema_structure;

    beforeEach(() => {
    });

    afterEach(() => {
        sandbox.restore()
    });

    context('create schema', () => {
        it('should return valid stub from createSchemaStructure', async () => {
            let schema_create_object = {operation: 'create_schema',
                schema: 'dogsrule', hdb_user:'',
                hdb_auth_header:'Basic YWRtaW4xOmFkbWluMQ=='
            };
            let fake_schema_structure = 'schema dogsrule successfully created';

            stub_signal_schema_change = sandbox
                .stub(signalling, 'signalSchemaChange');
            stub_create_schema_structure = sandbox
                .stub(schema, 'createSchemaStructure')
                .resolves(fake_schema_structure);
            let result = await schema.createSchema(schema_create_object);

            expect(result).to.equal('schema dogs successfully created');

        });

    });
});