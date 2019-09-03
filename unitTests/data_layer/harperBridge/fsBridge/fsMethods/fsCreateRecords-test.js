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
    hdb_auth_header: "1234",
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
        "/hdb/schema/system/hdb_schema/name/dev",
    ],
    raw_data: [
        {
            path: "/hdb/schema/system/hdb_schema/__hdb_hash/name/dev.hdb",
            value: "dev"
        },
    ],
    skipped_hashes: [],
    unlinks: []
    };

let validate_result = {
  SCHEMA_TABLE_TEST,
  ATTRIBUTES_TEST
};

const WRITTEN_HASH_TEST = ["7d0181"];
const SKIPPED_HASH_TEST = ["13md39"];

describe('Tests for file system module fsCreateRecords', () => {
    let sandbox = sinon.createSandbox();
    let log_error_spy;
    let process_rows_stub = sandbox.stub();
    let process_data_stub = sandbox.stub();
    let check_for_new_attributes_stub = sandbox.stub();
    let validate_fake = {
        schema_table: SCHEMA_TABLE_TEST,
        hashes: WRITTEN_HASH_TEST,
        attributes: SKIPPED_HASH_TEST,
    };
    let validate_stub = sandbox.stub().returns(validate_fake);

    before(() => {
        log_error_spy = sandbox.spy(log, 'error');
        fs_create_records.__set__('insertUpdateValidate', validate_stub);
        fs_create_records.__set__('checkForNewAttributes', check_for_new_attributes_stub);
        fs_create_records.__set__('processRows', process_rows_stub);
        fs_create_records.__set__('processData', process_data_stub);
        process_rows_stub.resolves(DATA_WRAPPER_TEST);
    });

    after(() => {
        sandbox.restore();
        fs_create_records = rewire('../../../../../data_layer/harperBridge/fsBridge/fsMethods/fsCreateRecords');
    });

    it('Test createRecords calls validate, processRows, checkAttr, processData as expected', async () => {
        let expected_result = {
            "schema_table": {
                "attributes": [
                    {
                        "attribute": "name"
                    },
                    {
                        "attribute": "createddate"
                    }
                ],
                "hash_attribute": "name",
                "name": "hdb_schema",
                "residence": [
                    "*"
                ],
                "schema": "system"
            },
            "skipped_hashes": [],
            "written_hashes": [
                "dev"
            ]
        };


        let result = await fs_create_records(INSERT_OBJ_TEST, ATTRIBUTES_TEST, SCHEMA_TABLE_TEST);

        expect(result).to.eql(expected_result);
        expect(process_data_stub).to.have.been.calledWith(DATA_WRAPPER_TEST);
    });

    it('Test error is caught and thrown', async () => {
        check_for_new_attributes_stub.throws(new Error('Insert error'));
        let test_error_response = await test_utils.testError(fs_create_records(INSERT_OBJ_TEST, ATTRIBUTES_TEST, SCHEMA_TABLE_TEST), 'Insert error');

        expect(test_error_response).to.be.true;
        expect(log_error_spy).to.have.been.calledOnce;
    });
});
