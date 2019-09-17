'use strict';

const test_utils = require('../../../../test_utils');
test_utils.preTestPrep();

const rewire = require('rewire');
const heCreateAttribute = rewire('../../../../../data_layer/harperBridge/heBridge/heMethods/heCreateAttribute');
const heliumUtils = require('../../../../../utility/helium/heliumUtils');
const log = require('../../../../../utility/logging/harper_logger');
const hdb_helium = heliumUtils.initializeHelium();
const chai = require('chai');
const sinon = require('sinon');
const sinon_chai = require('sinon-chai');
const { expect } = chai;
chai.use(sinon_chai);

const CREATE_ATTR_OBJ_TEST = {
    operation: "create_attribute",
    schema: "attrUnitTest",
    table: "dog",
    attribute: "another_attribute",
};


describe('Test for Helium method heCreateAttribute', () => {
    let sandbox = sinon.createSandbox();



    after(() => {
        sandbox.restore();
        rewire('../../../../../data_layer/harperBridge/heBridge/heMethods/heCreateAttribute');
    });

    context('Tests for heCreateAttribute function', () => {

        before(() => {
            heliumUtils.createSystemDataStores();
            global.hdb_schema = {
                [CREATE_ATTR_OBJ_TEST.schema]: {
                    [CREATE_ATTR_OBJ_TEST.table]: {
                        attributes: 'test'
                    }
                }
            };
        });

        it('', () => {
            // try {
            //     let result = heCreateAttribute(CREATE_ATTR_OBJ_TEST);
            //     console.log(result);
            // } catch(err) {
            //     console.log(err);
            // }
        });

    });

});