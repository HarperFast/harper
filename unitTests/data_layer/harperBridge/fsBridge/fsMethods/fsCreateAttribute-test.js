'use strict';
const test_utils = require('../../../../test_utils');
test_utils.preTestPrep();

const rewire = require('rewire');
let fsCreateAttribute = rewire('../../../../../data_layer/harperBridge/fsBridge/fsMethods/fsCreateAttribute');
let processRows = rewire('../../../../../data_layer/harperBridge/fsBridge/fsUtility/processRows');
const chai = require('chai');
const sinon = require('sinon');
const sinon_chai = require('sinon-chai');
const { expect } = chai;
chai.use(sinon_chai);

//const HDB_PATH = `${env.getHdbBasePath()}/schema/`;
const FS_DIR_TEST = test_utils.getMockFSPath();
const CREATE_ATTR_OBJ_TEST = {
    operation: "create_attribute",
    schema: "attrUnitTest",
    table: "dog",
    attribute: "another_attribute",
};
const SCHEMA_TABLE_TEST = {
    hash_attribute: "id",
    name: "hdb_attribute",
    schema: "system",
    residence: [
        "*"
    ],
    attributes: [
        {
            attribute: "id"
        },
        {
            attribute: "schema"
        }
    ]
};
const INSERT_OBJ_TEST = {
    operation: "insert",
    schema: "system",
    table: "hdb_attribute",
    hash_attribute: "id",
    records: [
        {
            "schema": "attrUnitTest",
            "table": "dog",
            "attribute": "another_attributee",
            "id": "cb765467-ec0f-4e1e-a467-9c7e984e3059",
            "schema_table": "attrUnitTest.dog"
        }
    ]
};
const WRITTEN_HASH_TEST = ["7d0181"];
const SKIPPED_HASH_TEST = ["13md39"];

const INSERT_ACTION_TEST = 'inserted';
const UPDATE_ACTION_TEST = 'updated';

const INSERT_RESPONSE = {
    message: "inserted 1 of 1 records",
    skipped_hashes: [],
    inserted_hashes: [
        "719d143a-7936-4ba8-af4e-08c37c1efac9"
    ]
};

describe('Tests for file system module fsCreateAttribute', () => {
    let sandbox = sinon.createSandbox();

    after(() => {
        rewire('../../../../../data_layer/harperBridge/fsBridge/fsMethods/fsCreateAttribute');
    });

    afterEach(() => {
        sandbox.restore();
    });

    context('Tests for createAttribute function', () => {
        let insert_data_stub = sandbox.stub().resolves(INSERT_RESPONSE);

        before(() => {
            global.hdb_schema = {
                [CREATE_ATTR_OBJ_TEST.schema]: {
                    [CREATE_ATTR_OBJ_TEST.table]: {
                        attributes: ''
                    }
                }
            };

            sandbox.stub().resolves(INSERT_RESPONSE);
            fsCreateAttribute.__set__('insertData', insert_data_stub)
        });

        it('Test that validation catches and throws from invalid object', async () => {
            let test_err_result = await test_utils.testError(fsCreateAttribute({schema: "TestSchema", table: "TestTable"}), 'Attribute  is required');

            expect(test_err_result).to.be.true;
        });

        it('Test create attribute returns expected response for nominal behaviour', async () => {
            let result = await fsCreateAttribute(CREATE_ATTR_OBJ_TEST);

            expect(result).to.eql(result);
        });

        it('Test that an error is thrown if the attribute already exists', async () => {
            global.hdb_schema = {
                [CREATE_ATTR_OBJ_TEST.schema]: {
                    [CREATE_ATTR_OBJ_TEST.table]: {
                        attributes: [{attribute: CREATE_ATTR_OBJ_TEST.attribute}]
                    }
                }
            };

            let test_err_result = await test_utils.testError(fsCreateAttribute(CREATE_ATTR_OBJ_TEST),
                `attribute '${CREATE_ATTR_OBJ_TEST.attribute}' already exists in ${CREATE_ATTR_OBJ_TEST.schema}.${CREATE_ATTR_OBJ_TEST.table}`);

            expect(test_err_result).to.be.true;
        });
    });

    context('Tests for insertData function', () => {
        let insert_data = fsCreateAttribute.__get__('insertData');
        let insert_update_val_rw;
        let process_rows_rw;
        let process_data_rw;
        let convert_op_rw;
        let validate_fake = {
            schema_table: SCHEMA_TABLE_TEST,
            hashes: WRITTEN_HASH_TEST,
            attributes: SKIPPED_HASH_TEST,
        };
        let process_rows_fake = {
            written_hashes: WRITTEN_HASH_TEST,
            skipped_hashes: SKIPPED_HASH_TEST
        };
        let insert_update_val_stub = sandbox.stub().returns(validate_fake);
        let process_rows_stub = sandbox.stub().resolves(process_rows_fake);
        let process_data_stub = sandbox.stub();
        let convert_op_stub = sandbox.stub();

        before(() => {
            insert_update_val_rw = fsCreateAttribute.__set__('insertUpdateValidate', insert_update_val_stub);
            process_rows_rw = fsCreateAttribute.__set__('processRows', process_rows_stub);
            process_data_rw = fsCreateAttribute.__set__('processData', process_data_stub);
            convert_op_rw = fsCreateAttribute.__set__('convertOperationToTransaction', convert_op_stub);
        });

        after(() => {
            insert_update_val_rw();
            process_rows_rw();
            process_data_rw();
            convert_op_rw();
        });

        it('Test all stubs are called as expected and valid object is returned', async () => {
            let return_obj = {
                message: 'inserted 1 of 1 records',
                skipped_hashes: [ '13md39' ],
                inserted_hashes: [ '7d0181' ]
            };
            let result = await insert_data(INSERT_OBJ_TEST);

            expect(result).to.eql(return_obj);
            expect(insert_update_val_stub).to.have.been.calledWith(INSERT_OBJ_TEST);
            expect(process_rows_stub).to.have.been.calledWith(INSERT_OBJ_TEST, SKIPPED_HASH_TEST, SCHEMA_TABLE_TEST, null);
            expect(process_data_stub).to.have.been.calledWith();
        });

        it('Test that exception from validate is caught', async () => {
            let error_msg = 'validation error';
            insert_update_val_stub.throws(new Error(error_msg));
            let test_err_result = await test_utils.testError(insert_data(INSERT_OBJ_TEST), error_msg);

            expect(test_err_result).to.be.true;
        });
    });


    context('Test returnObject function', () => {
        let return_object = fsCreateAttribute.__get__('returnObject');

        it('Test that an insert object is returned', () => {
            let expected_result = {
                message: "inserted 1 of 1 records",
                skipped_hashes: [
                    "13md39"
                ],
                inserted_hashes: [
                    "7d0181"
                ]
            };
            let result = return_object(INSERT_ACTION_TEST, WRITTEN_HASH_TEST, INSERT_OBJ_TEST, SKIPPED_HASH_TEST);

            expect(result).to.eql(expected_result);
        });

        it('Test that an update object is returned', () => {
            let expected_result = {
                message: "updated 1 of 1 records",
                skipped_hashes: [
                    "13md39"
                ],
                update_hashes: [
                    "7d0181"
                ]
            };
            let result = return_object(UPDATE_ACTION_TEST, WRITTEN_HASH_TEST, INSERT_OBJ_TEST, SKIPPED_HASH_TEST);

            expect(result).to.eql(expected_result);
        });
    });
});
