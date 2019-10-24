'use strict';

const test_utils = require('../../../test_utils');
test_utils.preTestPrep();
let hdb_helium = test_utils.buildHeliumTestVolume();

const rewire = require('rewire');
const heCreateTable = rewire('../../../../data_layer/harperBridge/heBridge/heMethods/heCreateTable');
const he_create_attribute_rw = rewire('../../../../data_layer/harperBridge/heBridge/heMethods/heCreateAttribute');
const heGenerateDataStoreName = require('../../../../data_layer/harperBridge/heBridge/heUtility/heGenerateDataStoreName');
const chai = require('chai');
const sinon = require('sinon');
const sinon_chai = require('sinon-chai');
const { expect } = chai;
chai.use(sinon_chai);

const CREATE_TABLE_OBJ_TEST_A = {
    operation: 'create_table',
    schema: 'dogsrule',
    table: 'catsdrool',
    hash_attribute: 'id'
};

const TABLE_SYSTEM_DATA_TEST_A = {
    name: CREATE_TABLE_OBJ_TEST_A.table,
    schema: CREATE_TABLE_OBJ_TEST_A.schema,
    id: '82j3r4',
    hash_attribute: CREATE_TABLE_OBJ_TEST_A.hash_attribute,
    residence: '*'
};

const CREATE_TABLE_OBJ_TEST_B = {
    operation: 'create_table',
    schema: 'dogsrule',
    table: 'coolDogNames',
    hash_attribute: 'name',
};

const TABLE_SYSTEM_DATA_TEST_B = {
    name: CREATE_TABLE_OBJ_TEST_B.table,
    schema: CREATE_TABLE_OBJ_TEST_B.schema,
    id: 'fd23fds',
    hash_attribute: CREATE_TABLE_OBJ_TEST_B.hash_attribute,
    residence: '*'
};

const SYSTEM_HDB_TABLES = ['system/hdb_table/id', 'system/hdb_table/name', 'system/hdb_table/hash_attribute', 'system/hdb_table/schema', 'system/hdb_table/residence'];
const SYSTEM_ATTR_SCHEMA = ['system/hdb_attribute/id', 'system/hdb_attribute/schema', 'system/hdb_attribute/table', 'system/hdb_attribute/attribute', 'system/hdb_attribute/schema_table'];

describe('Test for Helium method heCreateTable', () => {
    let sandbox = sinon.createSandbox();
    let uuidV4_stub_func = () => '1234';

    before(() => {

        he_create_attribute_rw.__set__('uuidV4', uuidV4_stub_func);
        heCreateTable.__set__('heCreateAttribute', he_create_attribute_rw);
        global.hdb_schema = {
            [CREATE_TABLE_OBJ_TEST_A.schema]: {
                [CREATE_TABLE_OBJ_TEST_A.table]: {
                    hash_attribute: CREATE_TABLE_OBJ_TEST_A.hash_attribute
                },
                [CREATE_TABLE_OBJ_TEST_B.table]: {
                    hash_attribute: CREATE_TABLE_OBJ_TEST_B.hash_attribute

                },
            },
            system: {
                hdb_attribute: {
                    hash_attribute:"id",
                    name:"hdb_attribute",
                    schema:"system",
                    residence:["*"],
                    attributes: [
                        {
                            attribute: "id"
                        },
                        {
                            attribute: "schema"
                        },
                        {
                            attribute: "table"
                        },
                        {
                            attribute: "attribute"
                        },
                        {
                            attribute: "schema_table"
                        }
                    ]
                },
                hdb_table: {
                    hash_attribute: "id",
                    name: "hdb_table",
                    schema: "system",
                    residence: ["*"],
                    attributes: [
                        {
                            attribute: "id"
                        },
                        {
                            attribute: "name"
                        },
                        {
                            attribute: "hash_attribute"
                        },
                        {
                            attribute: "schema"
                        },
                        {
                            attribute: "residence"
                        }
                    ]
                }
            }
        };
    });

    after(() => {
        test_utils.teardownHeliumTestVolume(global.hdb_helium);
        global.hdb_schema = {};
        sandbox.restore();
        rewire('../../../../data_layer/harperBridge/heBridge/heMethods/heCreateAttribute');
    });
    
    it('Test that table A is successfully created', () => {
        let expected_sys_table = [ [ '82j3r4', [ '82j3r4', 'catsdrool', 'id', 'dogsrule', '*' ] ] ];
        let expected_attr_table_createdtime = [ [ '1234', [ '1234', 'dogsrule', 'catsdrool', '__createdtime__', 'dogsrule.catsdrool' ] ] ];
        let search_sys_table;
        let search_attr_table;
        let datastore_list;

        try {
            heCreateTable(TABLE_SYSTEM_DATA_TEST_A, CREATE_TABLE_OBJ_TEST_A);
            search_sys_table = hdb_helium.searchByKeys([TABLE_SYSTEM_DATA_TEST_A.id], SYSTEM_HDB_TABLES );
            search_attr_table = hdb_helium.searchByKeys(['1234'], SYSTEM_ATTR_SCHEMA);
            datastore_list = hdb_helium.listDataStores();
        } catch(err) {
            console.log(err);
        }

        expect(search_sys_table).to.eql(expected_sys_table);
        expect(search_attr_table).to.eql(expected_attr_table_createdtime);
        expect(datastore_list.includes(heGenerateDataStoreName(CREATE_TABLE_OBJ_TEST_A.schema, CREATE_TABLE_OBJ_TEST_A.table, '__createdtime__'))).to.be.true;
        expect(datastore_list.includes(heGenerateDataStoreName(CREATE_TABLE_OBJ_TEST_A.schema, CREATE_TABLE_OBJ_TEST_A.table, '__updatedtime__'))).to.be.true;
    });

    it('Test that table B is successfully created', () => {
        let expected_sys_table = [ [ 'fd23fds', [ 'fd23fds', 'coolDogNames', 'name', 'dogsrule', '*' ] ] ];
        let search_sys_table;
        let datastore_list;

        try {
            heCreateTable(TABLE_SYSTEM_DATA_TEST_B, CREATE_TABLE_OBJ_TEST_B);
            search_sys_table = hdb_helium.searchByKeys([TABLE_SYSTEM_DATA_TEST_B.id], SYSTEM_HDB_TABLES );
            datastore_list = hdb_helium.listDataStores();
        } catch(err) {
            console.log(err);
        }

        expect(search_sys_table).to.eql(expected_sys_table);
        expect(datastore_list.includes(heGenerateDataStoreName(CREATE_TABLE_OBJ_TEST_B.schema, CREATE_TABLE_OBJ_TEST_B.table, '__createdtime__'))).to.be.true;
        expect(datastore_list.includes(heGenerateDataStoreName(CREATE_TABLE_OBJ_TEST_B.schema, CREATE_TABLE_OBJ_TEST_B.table, '__updatedtime__'))).to.be.true;
    });

    it('Test that error from heCreateRecords is caught', () => {
        let error_msg = 'I am broken';
        let he_create_records_stub = sandbox.stub().throws(new Error(error_msg));
        heCreateTable.__set__('heCreateRecords', he_create_records_stub);
        let error;

        try {
            heCreateTable(TABLE_SYSTEM_DATA_TEST_B, CREATE_TABLE_OBJ_TEST_B);
        } catch(err) {
            error = err;
        }

        expect(error.message).to.equal(error_msg);
        expect(error).to.be.an.instanceOf(Error);
    });
});
