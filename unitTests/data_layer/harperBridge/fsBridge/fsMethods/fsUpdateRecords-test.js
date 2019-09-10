'use strict';

const test_utils = require('../../../../test_utils');
test_utils.preTestPrep();

const rewire = require('rewire');
let fsUpdateRecords = rewire('../../../../../data_layer/harperBridge/fsBridge/fsMethods/fsUpdateRecords');
const log = require('../../../../../utility/logging/harper_logger');
const chai = require('chai');
const sinon = require('sinon');
const sinon_chai = require('sinon-chai');
const { expect } = chai;
chai.use(sinon_chai);

const UPDATE_OBJ_TEST = {
    operation: "update",
    schema: "dev",
    table: "dog",
    hdb_auth_header: "1234",
    records: [
        {
            name: "Harper",
            age: 12
        }
    ]
};
const SCHEMA_TABLE_TEST = {
    hash_attribute: "name",
    name: "hdb_schema",
    schema: "system",
    residence: [
        "*"
    ],
    attributes: [
        {
            attribute: "name"
        },
        {
            attribute: "age"
        }
    ]
};
const HASHES_TEST = [1, 2];
const ATTRIBUTES_TEST = [
    "name",
    "breed",
    "id",
    "age"
];
const EXISTING_ROWS_TEST = [
    {
        name: "Harper",
        breed: "Mutt",
        id: 8,
        age: 5
    },
    {
        name: "Penny",
        breed: "Mutt",
        id: 9,
        age: 5
    }
];
const EXISTING_ATTR = [
    "name",
    "breed",
    "id",
    "age"
];
const DATA_WRAPPER_TEST = {
    written_hashes: [
        8,
        9
    ],
    folders: [
        "/Users/davidcockerill/hdb/schema//dev/dog/age/8",
    ],
    raw_data: [
        {
            path: "/Users/davidcockerill/hdb/schema//dev/dog/__hdb_hash/age/8.hdb",
            value: 8,
            link_path: "/Users/davidcockerill/hdb/schema//dev/dog/age/8/8.hdb"
        }
    ],
    skipped_hashes: [],
    unlinks: [
        "/Users/davidcockerill/hdb/schema//dev/dog/age/5/8.hdb"
    ]
};

describe('Test for file system module fsUpdateRecords', () => {
    let sandbox = sinon.createSandbox();

    after(() => {
        rewire('../../../../../data_layer/harperBridge/fsBridge/fsMethods/fsUpdateRecords');
        sandbox.restore();
    });

    context('Test updateRecords function', () => {
        let validate_response_fake = {
          schema_table: SCHEMA_TABLE_TEST,
          hashes: HASHES_TEST,
          attributes: ATTRIBUTES_TEST
        };
        let insert_update_validate_stub = sandbox.stub().returns(validate_response_fake);
        let process_rows_stub = sandbox.stub().resolves(DATA_WRAPPER_TEST);
        let check_new_attr_stub = sandbox.stub();
        let unlink_files_stub = sandbox.stub();
        let process_data_stub = sandbox.stub();
        let get_existing_rows_stub = sandbox.stub().resolves([]);

        before(() => {
            fsUpdateRecords.__set__('insertUpdateValidate', insert_update_validate_stub);
            fsUpdateRecords.__set__('processRows', process_rows_stub);
            fsUpdateRecords.__set__('checkForNewAttributes', check_new_attr_stub);
            fsUpdateRecords.__set__('unlinkFiles', unlink_files_stub);
            fsUpdateRecords.__set__('processData', process_data_stub);
            fsUpdateRecords.__set__('getExistingRows', get_existing_rows_stub);
        });

        it('Test that no hashes cause the function to skip update', async () => {
            let expected_result = {
                "existing_rows": [],
                "update_action": "updated",
                "hashes": [
                    1,
                    2
                ]
            };
            let result = await fsUpdateRecords(UPDATE_OBJ_TEST);

            expect(result).to.eql(expected_result);
        });

        it('Test all stubs are called as expected for nominal behaviour', async () => {
            let expected_result = {
                "written_hashes": [
                    8,
                    9
                ],
                "skipped_hashes": [],
                "schema_table": {
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
                            "attribute": "age"
                        }
                    ]
                }
            };
            get_existing_rows_stub.resolves(EXISTING_ROWS_TEST);
            let result = await fsUpdateRecords(UPDATE_OBJ_TEST);

            expect(result).to.eql(expected_result);
            expect(insert_update_validate_stub).to.have.been.calledWith(UPDATE_OBJ_TEST);
            expect(get_existing_rows_stub).to.have.been.calledWith(SCHEMA_TABLE_TEST, HASHES_TEST, ATTRIBUTES_TEST);
            expect(process_rows_stub).to.have.been.called;
            expect(check_new_attr_stub).to.have.been.calledWith(UPDATE_OBJ_TEST.hdb_auth_header, SCHEMA_TABLE_TEST, ATTRIBUTES_TEST);
            expect(unlink_files_stub).to.have.been.calledWith(DATA_WRAPPER_TEST.unlinks);
            expect(process_data_stub).to.have.been.calledWith(DATA_WRAPPER_TEST);
        });

        it('Test that an error from unlinkFiles is caught', async () => {
            let error_msg = 'There was a problem un-linking records';
            unlink_files_stub.throws(new Error(error_msg));
            let test_err_result = await test_utils.testError(fsUpdateRecords(UPDATE_OBJ_TEST), error_msg);

            expect(test_err_result).to.be.true;
        });
    });
    
    context('Test getExistingRows function', () => {
        let check_for_existing_attr_stub = sandbox.stub();
        let fs_search_by_hash_stub = sandbox.stub().resolves(EXISTING_ROWS_TEST);
        let get_existing_rows = fsUpdateRecords.__get__('getExistingRows');

        before(() => {
            fsUpdateRecords.__set__('checkForExistingAttributes', check_for_existing_attr_stub);
            fsUpdateRecords.__set__('fsSearchByHash', fs_search_by_hash_stub);
        });

        it('Test that an error is thrown if there are no attributes to update', async () => {
            check_for_existing_attr_stub.returns([]);
            let test_err_result = await test_utils.testError(get_existing_rows(SCHEMA_TABLE_TEST, HASHES_TEST, ATTRIBUTES_TEST), 'no attributes to update');

            expect(test_err_result).to.be.true;
        });
        
        it('Test all stubs are called and response is correct as expected for nominal behaviour', async () => {
            check_for_existing_attr_stub.returns(EXISTING_ATTR);
            let result = await get_existing_rows(SCHEMA_TABLE_TEST, HASHES_TEST, ATTRIBUTES_TEST);

            expect(result).to.eql(EXISTING_ROWS_TEST);
        });

        it('Test that an error from search by hash is caught', async () => {
            check_for_existing_attr_stub.returns(EXISTING_ATTR);
            let error_msg = 'Error from search by hash';
            fs_search_by_hash_stub.throws(new Error(error_msg));
            let test_err_result = await test_utils.testError(get_existing_rows(SCHEMA_TABLE_TEST, HASHES_TEST, ATTRIBUTES_TEST), error_msg);

            expect(test_err_result).to.be.true;
        });
    });
    
    context('Test checkForExistingAttributes function', () => {
        let check_for_existing_attr = fsUpdateRecords.__get__('checkForExistingAttributes');
        
        it('Test that function returns nothing if data attributes is empty', () => {
            let result = check_for_existing_attr(SCHEMA_TABLE_TEST, []);
            
            expect(result).to.be.undefined;
        });

        it('Test that function returns expected existing attributes', () => {
            let expected_result = [
                "name",
                "age"
            ];
            let result = check_for_existing_attr(SCHEMA_TABLE_TEST, ATTRIBUTES_TEST);

            expect(result).to.eql(expected_result);
        });
    });

    context('Test unlinkFiles function', () => {
        let unlink_files = fsUpdateRecords.__get__('unlinkFiles');
        let unlink_stub = sandbox.stub();
        let log_error_spy;

        before(() => {
            fsUpdateRecords.__set__('unlink', unlink_stub);
            log_error_spy = sandbox.spy(log, 'error');
        });

        it('Test unlink stub called as expected with nominal behaviour', async () => {
            await unlink_files(DATA_WRAPPER_TEST.unlinks);

            expect(unlink_stub).to.have.been.calledWith(DATA_WRAPPER_TEST.unlinks);
        });

        it('Test that an error from unlink is logged', async () => {
            unlink_stub.throws(new Error());
            await unlink_files(DATA_WRAPPER_TEST.unlinks);

            expect(log_error_spy).to.have.been.called;
        });
    });
});
