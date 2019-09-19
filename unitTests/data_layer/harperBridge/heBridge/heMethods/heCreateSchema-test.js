'use strict';

const test_utils = require('../../../../test_utils');
test_utils.preTestPrep();

const heCreateSchema = require('../../../../../data_layer/harperBridge/heBridge/heMethods/heCreateSchema');
const heliumUtils = require('../../../../../utility/helium/heliumUtils');
const chai = require('chai');
const sinon = require('sinon');
const sinon_chai = require('sinon-chai');
const { expect } = chai;
chai.use(sinon_chai);

const CREATE_SCHEMA_OBJ_TEST_A = {
    operation: 'create_schema',
    schema: 'horses'
};

const CREATE_SCHEMA_OBJ_TEST_B = {
    operation: 'create_schema',
    schema: 'cows'
};
let hdb_helium;

describe('Tests for Helium method heCreateSchema', () => {
    let sandbox = sinon.createSandbox();

    before(() => {
        try {
            heliumUtils.createSystemDataStores();
            hdb_helium = heliumUtils.initializeHelium();
        } catch(err) {
            console.log(err);
        }

        sandbox.stub(Date, 'now').returns('9192019');
        global.hdb_schema = {
            system: {
                hdb_schema: {
                    hash_attribute:"name",
                    name:"hdb_schema",
                    schema:"system",
                    residence:["*"],
                    attributes:[
                        {
                            "attribute":"name"
                        },
                        {
                            "attribute":"createddate"
                        }
                    ]
                }
            }
        };
    });

    after(() => {
        test_utils.deleteSystemDataStores(hdb_helium);
        sandbox.restore();
    });

    it('Test that a new schema is added to the system datastore', () => {
        let expected_search_result = [ [ 'horses', [ 'horses', '9192019' ] ] ];
        heCreateSchema(CREATE_SCHEMA_OBJ_TEST_A);
        let search_result = hdb_helium.searchByKeys([CREATE_SCHEMA_OBJ_TEST_A.schema], ['system/hdb_schema/name', 'system/hdb_schema/createddate']);

        expect(search_result).to.eql(expected_search_result);
    });

    it('Test that a second new schema is added to the system datastore', () => {
        let expected_search_result = [ [ 'cows', [ 'cows', '9192019' ] ] ];
        heCreateSchema(CREATE_SCHEMA_OBJ_TEST_B);
        let search_result = hdb_helium.searchByKeys([CREATE_SCHEMA_OBJ_TEST_B.schema], ['system/hdb_schema/name', 'system/hdb_schema/createddate']);

        expect(search_result).to.eql(expected_search_result);
    });
});
