'use strict';

const rewire = require('rewire');
const test_utils = require('../../../../test_utils');
const deleteAttrStructure = rewire('../../../../../data_layer/harperBridge/fsBridge/fsUtility/deleteAttrStructure');
const terms = require('../../../../../utility/hdbTerms');
const chai = require('chai');
const sinon = require('sinon');
const sinon_chai = require('sinon-chai');
const { expect } = chai;
chai.use(sinon_chai);

const ATTR_DROP_OBJ_TEST = {
    operation: "drop_schema",
    schema: "dropAttrTest",
    table: "doggo"
};

const ATTR_SEARCH_RES_TEST = [
    {
        id: "1868",
        attribute: "age"
    },
    {
        id: "9140",
        attribute: "breed"
    },
    {
        id: "c128",
        attribute: "id"
    },
    {
        id: "ee7d",
        attribute: "name"
    }
];

let SEARCH_OBJ_TEST = {
    schema: terms.SYSTEM_SCHEMA_NAME,
    table: terms.SYSTEM_TABLE_NAMES.ATTRIBUTE_TABLE_NAME,
    hash_attribute: terms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES.ATTR_ID_KEY,
    get_attributes: [terms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES.ATTR_ID_KEY, terms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES.ATTR_ATTRIBUTE_KEY],
    search_attribute: "schema_table",
    search_value: `${ATTR_DROP_OBJ_TEST.schema}.${ATTR_DROP_OBJ_TEST.table}`
};

describe('Tests for fsUtility function deleteAttrStructure', () => {
    let sandbox = sinon.createSandbox();
    let p_search_by_value_stub = sandbox.stub();
    let fs_delete_records_stub = sandbox.stub();

    before(() => {
        deleteAttrStructure.__set__('p_search_by_value', p_search_by_value_stub);
        deleteAttrStructure.__set__('fsDeleteRecords', fs_delete_records_stub);
    });

    after(() => {
        sandbox.restore();
        rewire('../../../../../data_layer/harperBridge/fsBridge/fsUtility/deleteAttrStructure');
    });

    it('Test error thrown from missing schema', async () => {
        let test_err_result = await test_utils.testError(deleteAttrStructure({ operation: "drop_schema", table: "doggo"}), 'attribute drop requires table and or schema.');

        expect(test_err_result).to.be.true;
    });

    it('Test search by value and delete records stubs are called as expected', async () => {
        p_search_by_value_stub.resolves(ATTR_SEARCH_RES_TEST);
        let result = await deleteAttrStructure(ATTR_DROP_OBJ_TEST);

        expect(result).to.equal('successfully deleted 4 attributes');
        expect(p_search_by_value_stub).to.have.been.calledWith(SEARCH_OBJ_TEST);
    });

    it('Test that an error from delete records is caught and thrown', async () => {
        let error_msg = 'Problem deleting record';
        fs_delete_records_stub.throws(new Error(error_msg));
        let test_err_result = await test_utils.testError(deleteAttrStructure(ATTR_DROP_OBJ_TEST), error_msg);

        expect(test_err_result).to.be.true;
    });
});
