'use strict';

const test_utils = require('../../../../test_utils');
test_utils.preTestPrep();

const rewire = require('rewire');
const heDeleteRecordsBefore = rewire('../../../../../data_layer/harperBridge/heBridge/heMethods/heDeleteRecordsBefore');
const helium_utils = require('../../../../../utility/helium/heliumUtils');
const chai = require('chai');
const { expect } = chai;
const sinon = require('sinon');

let helium_reponse = [ 
    [ '1571083064650', [ '8' ] ],
    [ '1571083064650', [ '9' ] ],
    [ '1111083064650', [ '100' ] ]
];

const DELETE_OBJ_TEST = {
    operation: "delete_files_before",
    date: `2019-09-12`,
    schema: 'animals',
    table: 'horses'
};

describe('Test Helium method heDeleteRecordsBefore', () => {
    let sandbox = sinon.createSandbox();

    before(() => {
        global.hdb_schema = {
            [DELETE_OBJ_TEST.schema]: {
                [DELETE_OBJ_TEST.table]: {
                    hash_attribute: ''
                }
            }
        };
        let search_by_range_stub = sinon.stub(helium_utils, 'initializeHelium');
    });

    after(() => {
        delete global.hdb_schema[DELETE_OBJ_TEST.schema];
    });

    it('Test error is thrown with bad attribute', () => {
        let error;
        try {
            heDeleteRecordsBefore(DELETE_OBJ_TEST);
        } catch(err) {
            error = err;
        }

        expect(error.message).to.equal(`Could not retrieve hash attribute for schema: ${DELETE_OBJ_TEST.schema} table: ${DELETE_OBJ_TEST.table}`);
    });

    it('Test ', () => {
        global.hdb_schema[DELETE_OBJ_TEST.schema][DELETE_OBJ_TEST.table].hash_attribute = 'id';

        heDeleteRecordsBefore(DELETE_OBJ_TEST);

    });

});