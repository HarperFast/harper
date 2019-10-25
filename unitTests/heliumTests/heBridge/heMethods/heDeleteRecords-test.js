'use strict';

const test_utils = require('../../../test_utils');
test_utils.preTestPrep();
let hdb_helium = test_utils.buildHeliumTestVolume();

const rewire = require('rewire');
const heDeleteRecords = rewire('../../../../data_layer/harperBridge/heBridge/heMethods/heDeleteRecords');
const chai = require('chai');
const { expect } = chai;

let DELETE_OBJ_TEST = {
    operation: "delete",
    table: "doggo",
    schema: "deleteTest",
    hash_values: [
        8,
        9
    ],
    records: [
        {
            age: 5,
            breed: "Mutt",
            id: 8,
            name: "Harper"
        },
        {
            age: 5,
            breed: "Mutt",
            id: 9,
            name: "Penny"
        }
    ]
};

const ATTRIBUTES_TEST = [
    {
        attribute: "name"
    },
    {
        attribute: "breed"
    },
    {
        attribute: "age"
    },
    {
        attribute: "id"
    },
    {
        attribute: "height"
    },
    {
        attribute: "__createdtime__"
    },
    {
        attribute: "__updatedtime__"
    }
];

const HASH_ATTRIBUTE = 'id';
const DATASTORES_TEST = [ "deleteTest/doggo/name", "deleteTest/doggo/breed", "deleteTest/doggo/id", "deleteTest/doggo/age", "deleteTest/doggo/height", "deleteTest/doggo/__createdtime__", "deleteTest/doggo/__updatedtime__"];
const TABLE_DATA_TEST = [
    [ '8', [ 'Harper', 'Mutt', '8', '5', null, '1943201', '1943201'] ],
    [ '9', [ 'Penny', 'Mutt', '9', '5', '145', '1943201', '1943201' ] ],
    [ '12', [ 'David', 'Mutt', '12', null, null, '1943201', '1943201' ] ],
    [ '10', [ 'Rob', 'Mutt', '10', '5', '145', '1943201', '1943201' ] ],
    [ '11', [ 'Riley', 'Mutt', '11', '7', '145', '1943201', '1943201' ] ],
];

function setupTest() {
    try {
        hdb_helium.createDataStores(DATASTORES_TEST);
        hdb_helium.insertRows(DATASTORES_TEST, TABLE_DATA_TEST);
    } catch(err) {
        throw err;
    }
}

describe('Test Helium method heDeleteRecords', () => {

    before(() => {

        setupTest();
        global.hdb_schema = {
            [DELETE_OBJ_TEST.schema]: {
                [DELETE_OBJ_TEST.table]: {
                    attributes: ATTRIBUTES_TEST,
                    hash_attribute: HASH_ATTRIBUTE
                }
            }
        };
    });

    after(() => {
        test_utils.teardownHeliumTestVolume(global.hdb_helium);
        delete global.hdb_schema[DELETE_OBJ_TEST.schema];
    });

    context('Test heDeleteRecords function', () => {
        it('Test deleting one value from table', () => {
            let delete_obj = {
                operation: "delete",
                table: "doggo",
                schema: "deleteTest",
                hash_values: [ 8 ]
            };
            let expected_result = {
                message: '1 record successfully deleted',
                deleted_hashes: [ 8 ],
                skipped_hashes: []
            };
            let result;
            let search_result;

            try {
                result = heDeleteRecords(delete_obj);
                search_result = hdb_helium.searchByKeys([8], DATASTORES_TEST);
            } catch(err) {
                console.log(err);
            }

            expect(result).to.eql(expected_result);
            expect(search_result).to.eql([]);
        });

        it('Test deleting two values from table, one that does not exist', () => {
            let delete_obj = {
                operation: "delete",
                table: "doggo",
                schema: "deleteTest",
                hash_values: [ 8, 9 ]
            };
            let expected_result = {
                message: '1 record successfully deleted',
                deleted_hashes: [ 9 ],
                skipped_hashes: [ 8]
            };
            let result;
            let search_result;

            try {
                result = heDeleteRecords(delete_obj);
                search_result = hdb_helium.searchByKeys([8, 9], DATASTORES_TEST);
            } catch(err) {
                console.log(err);
            }

            expect(result).to.eql(expected_result);
            expect(search_result).to.eql([]);
        });

        it('Test deleting two values from table that do not exist', () => {
            let delete_obj = {
                operation: "delete",
                table: "doggo",
                schema: "deleteTest",
                hash_values: [ 8, 9 ]
            };
            let expected_result = {
                message: '0 records successfully deleted',
                deleted_hashes: [ ],
                skipped_hashes: [ 8, 9]
            };
            let result;
            let search_result;

            try {
                result = heDeleteRecords(delete_obj);
                search_result = hdb_helium.searchByKeys([8, 9], DATASTORES_TEST);
            } catch(err) {
                console.log(err);
            }

            expect(result).to.eql(expected_result);
            expect(search_result).to.eql([]);
        });

        it('Test deleting multiple values from table', () => {
            let delete_obj = {
                operation: "delete",
                table: "doggo",
                schema: "deleteTest",
                hash_values: [ 12, 10 ]
            };
            let expected_result = {
                message: '2 records successfully deleted',
                deleted_hashes: [ 12, 10 ],
                skipped_hashes: [ ]
            };
            let result;
            let search_result;

            try {
                result = heDeleteRecords(delete_obj);
                search_result = hdb_helium.searchByKeys([12, 10], DATASTORES_TEST);
            } catch(err) {
                console.log(err);
            }

            expect(result).to.eql(expected_result);
            expect(search_result).to.eql([]);
        });

        it('Test that error from helium deleteRows is caught and thrown', () => {
            let error;
            let delete_obj = {
                operation: "delete",
                table: "doggo",
                schema: "deleteTest",
                hash_values: 12
            };

            try {
                heDeleteRecords(delete_obj);
            } catch(err) {
                error = err;
            }

            expect(error.message).to.equal('Second argument must be an array of keys to to be deleted.');
        });

        it('Test passing no hash_values or records', () => {
            let error;
            let delete_obj = {
                operation: "delete",
                table: "doggo",
                schema: "deleteTest"
            };

            let response;
            try {
                response = heDeleteRecords(delete_obj);
            } catch(err) {
                error = err;
            }

            expect(error).to.equal(undefined);
            expect(response).to.not.equal(undefined);
            expect(response.deleted_hashes).to.eql([]);
            expect(response.skipped_hashes).to.eql([]);
            expect(response.message).to.equal("0 records successfully deleted");
        });

        it('Test passing records instead of hash_values', () => {
            let error;
            let delete_obj = {
                operation: "delete",
                table: "doggo",
                schema: "deleteTest",
                records:[
                    {
                        id: 11,
                        name: 'Riley'
                    }
                ]
            };

            let response;
            try {
                response = heDeleteRecords(delete_obj);
            } catch(err) {
                error = err;
            }

            expect(error).to.equal(undefined);
            expect(response).to.not.equal(undefined);
            expect(response.deleted_hashes).to.eql([11]);
            expect(response.skipped_hashes).to.eql([]);
            expect(response.message).to.equal("1 record successfully deleted");
        });

        it('Test passing records instead of hash_values where record hash no hash value', () => {
            let error;
            let delete_obj = {
                operation: "delete",
                table: "doggo",
                schema: "deleteTest",
                records:[
                    {
                        name: 'Riley'
                    }
                ]
            };

            let response;
            try {
                response = heDeleteRecords(delete_obj);
            } catch(err) {
                error = err;
            }

            expect(error).to.equal(undefined);
            expect(response).to.not.equal(undefined);
            expect(response.deleted_hashes).to.eql([]);
            expect(response.skipped_hashes).to.eql([]);
            expect(response.message).to.equal("0 records successfully deleted");
        });

        it('Test that error thrown if hash not present', () => {
            global.hdb_schema[DELETE_OBJ_TEST.schema][DELETE_OBJ_TEST.table]['hash_attribute'] = null;
            let error;
            let delete_obj = {
                operation: "delete",
                table: "doggo",
                schema: "deleteTest",
                hash_values: [12]
            };

            try {
                heDeleteRecords(delete_obj);
            } catch(err) {
                error = err;
            }

            expect(error.message).to.equal(`could not retrieve hash attribute for schema:${delete_obj.schema} and table ${delete_obj.table}`);
        });
    });

    context('Test buildTableDataStores function', () => {
        let build_table_datastores = heDeleteRecords.__get__('buildTableDataStores');

        it('Test that array of datastores is built as expected', () => {
            let schema_table = {
                attributes: ATTRIBUTES_TEST
            };
            let expected_result = [
                'deleteTest/doggo/name',
                'deleteTest/doggo/breed',
                'deleteTest/doggo/age',
                'deleteTest/doggo/id',
                'deleteTest/doggo/height',
                'deleteTest/doggo/__createdtime__',
                'deleteTest/doggo/__updatedtime__'
            ];
            let result = build_table_datastores(DELETE_OBJ_TEST, schema_table);

            expect(result).to.eql(expected_result);
        });
    });
});