'use strict';

const test_utils = require('../../../../test_utils');
test_utils.preTestPrep();

const rewire = require('rewire');
let fsDropSchema = rewire('../../../../../data_layer/harperBridge/fsBridge/fsMethods/fsDropSchema');
let fsDeleteRecords = rewire('../../../../../data_layer/harperBridge/fsBridge/fsMethods/fsDeleteRecords');
let search = rewire('../../../../../data_layer/search');
const log = require('../../../../../utility/logging/harper_logger');
const terms = require('../../../../../utility/hdbTerms');
const fs = require('graceful-fs');
const chai = require('chai');
const sinon = require('sinon');
const sinon_chai = require('sinon-chai');
const { expect } = chai;
chai.use(sinon_chai);

const HASH_ATTRIBUTE_TEST = 'id';
const TABLE_TEST = 'animal';
const SCHEMA_TEST = 'dropTest';
const FS_DIR_TEST = test_utils.getMockFSPath();
const TABLE_DATA_TEST = [
    {
        age: 17,
        species: "Panda",
        id: 1,
        name: "Gary"
    },
    {
        age: 5,
        species: "Wolf",
        id: 2,
        name: "Sid"
    }
];
const DROP_SCHEMA_OBJ_TEST = {
    operation: "drop_schema",
    schema: "dropTest",
};

describe('Tests for file system module fsDropSchema', () => {
    let sandbox = sinon.createSandbox();

    context('Tests for dropSchema function', () => {
        let fs_delete_records_stub;
        let p_search_by_value_stub;
        let move_schema_to_trash_stub;
        let delete_attr_struc;
        let schema = DROP_SCHEMA_OBJ_TEST.schema;
        let delete_schema_obj = {
            table: terms.SYSTEM_TABLE_NAMES.SCHEMA_TABLE_NAME,
            schema: terms.SYSTEM_SCHEMA_NAME,
            hash_values: [schema]
        };
        let search_obj = {
            schema: terms.SYSTEM_SCHEMA_NAME,
            table: terms.SYSTEM_TABLE_NAMES.TABLE_TABLE_NAME,
            hash_attribute: terms.SYSTEM_TABLE_HASH,
            search_attribute: terms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES.ATTR_SCHEMA_KEY,
            search_value: schema,
            get_attributes: ['id']
        };
        
        before(() => {
            fs_delete_records_stub = sandbox.stub();
            fsDropSchema.__set__();

        });

        after(function () {
            sandbox.restore('fsDeleteRecords', );
        });
    });

    context('Tests for moveSchemaToTrash function', () => {

    });

});