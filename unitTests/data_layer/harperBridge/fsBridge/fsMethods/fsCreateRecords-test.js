'use strict';

const test_utils = require('../../../../test_utils');
test_utils.preTestPrep();

const rewire = require('rewire');
let fs_create_records = rewire('../../../../../data_layer/harperBridge/fsBridge/fsMethods/fsCreateRecords');
const log = require('../../../../../utility/logging/harper_logger');
const chai = require('chai');
const sinon = require('sinon');
const sinon_chai = require('sinon-chai');
const { expect } = chai;
chai.use(sinon_chai);

const INSERT_OBJ_TEST = {
    operation: "insert",
    schema: "system",
    table: "hdb_schema",
    records: [
        {
            name: "dev",
            createddate: 1565028087315
        }
    ]};

const ATTRIBUTES_TEST = [
    "name",
    "createddate"
    ];

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
            attribute: "createddate"
        }
    ]};

const DATA_WRAPPER_TEST = {
    written_hashes: [
        "dev"
    ],
    folders: [
        "/Users/david/hdb/schema/system/hdb_schema/name/dev",
    ],
    raw_data: [
        {
            path: "/Users/david/hdb/schema/system/hdb_schema/__hdb_hash/name/dev.hdb",
            value: "dev"
        },
    ],
    skipped: [],
    unlinks: []
    };

let validate_result = {
  SCHEMA_TABLE_TEST,
  ATTRIBUTES_TEST
};

describe('Tests for file system module fsCreateRecords', () => {
    let sandbox = sinon.createSandbox();
    let log_error_spy;
    let process_rows_stub = sandbox.stub();
    let check_new_attr_stub;
    let process_data_stub = sandbox.stub();
    let check_for_new_attributes_stub = sandbox.stub();
    let validate_stub = sinon.stub().resolves(validate_result);

    before(() => {
        log_error_spy = sandbox.spy(log, 'error');
        fs_create_records.__set__('insertUpdateValidate', validate_stub);
        fs_create_records.__set__('checkForNewAttributes', check_for_new_attributes_stub);
        fs_create_records.__set__('processRows', process_rows_stub);
        fs_create_records.__set__('processData', process_data_stub);
    });

    after(() => {
        sandbox.restore();
        fs_create_records = rewire('../../../../../data_layer/harperBridge/fsBridge/fsMethods/fsCreateRecords');
    });

    it('Test createRecords calls validate, processRows, checkAttr, processData as expected', async () => {
        process_rows_stub.resolves(DATA_WRAPPER_TEST);
        let expected_result = {
            "written_hashes": [
                "dev"
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
                        "attribute": "createddate"
                    }
                ]
            }
        };
        let result = await fs_create_records(INSERT_OBJ_TEST, ATTRIBUTES_TEST, SCHEMA_TABLE_TEST);

        expect(result).to.eql(expected_result);
        expect(check_new_attr_stub).to.have.been.calledWith(INSERT_OBJ_TEST.hdb_auth_header, SCHEMA_TABLE_TEST, ATTRIBUTES_TEST);
        expect(process_data_stub).to.have.been.calledWith(DATA_WRAPPER_TEST);
    });

    it('Test error is caught and thrown', async () => {
        check_new_attr_stub.throws(new Error('Insert error'));
        let test_error_response = await test_utils.testError(fs_create_records(INSERT_OBJ_TEST, ATTRIBUTES_TEST, SCHEMA_TABLE_TEST), 'Insert error');

        expect(test_error_response).to.be.true;
        expect(log_error_spy).to.have.been.calledOnce;
    });
});
