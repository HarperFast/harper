'use strict';

const test_utils = require('../../../../test_utils');
test_utils.preTestPrep();
test_utils.buildHeliumTestVolume();

const heliumUtils = require('../../../../../utility/helium/heliumUtils');
const rewire = require('rewire');
const heCreateRecords = rewire('../../../../../data_layer/harperBridge/heBridge/heMethods/heCreateRecords');
const log = require('../../../../../utility/logging/harper_logger');
const chai = require('chai');
const sinon = require('sinon');
const sinon_chai = require('sinon-chai');
const { expect } = chai;
chai.use(sinon_chai);

let hdb_helium;
try {
    heliumUtils.createSystemDataStores();
    hdb_helium = heliumUtils.initializeHelium();
} catch(err) {
    console.log(err);
}

const INSERT_OBJECT_TEST = {
    operation: "insert",
    schema: "dev",
    table: "dog",
    records: [
        {
            name: "Harper",
            breed: "Mutt",
            id: "8",
            age: 5
        },
        {
            name: "Penny",
            breed: "Mutt",
            id: "9",
            age: 5,
            height: 145
        },
        {
            name: "David",
            breed: "Mutt",
            id: "12"
        },
        {
            name: "Rob",
            breed: "Mutt",
            id: "10",
            age: 5,
            height: 145
        }
    ]
};

const NO_NEW_ATTR_TEST = [
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

const SCHEMA_TABLE_TEST = {
    id: "c43762be-4943-4d10-81fb-1b857ed6cf3a",
    name: "dog",
    hash_attribute: "id",
    schema: "dev",
    attributes: []
};

const DATASTORES_TEST = [ "dev/dog/name", "dev/dog/breed", "dev/dog/id", "dev/dog/age", "dev/dog/height", "dev/dog/__createdtime__", "dev/dog/__updatedtime__"];

let ATTR_OBJ_TEST = {
    "schema": "dev",
    "table": "dog",
    "attribute": [
        {
            "attribute": "name"
        },
        {
            "attribute": "breed"
        },
        {
            "attribute": "age"
        },
        {
            "attribute": "id"
        },
        {
            "attribute": "height"
        },
        {
            "attribute": "__createdtime__"
        },
        {
            "attribute": "__updatedtime__"
        }
    ],
    "hdb_auth_header": "auth-header"
};

describe('Tests for Helium method heCreateRecords', () => {
    let sandbox = sinon.createSandbox();

    after(() => {
        test_utils.teardownHeliumTestVolume(global.hdb_helium);
        sandbox.restore();
        rewire('../../../../../data_layer/harperBridge/heBridge/heMethods/heCreateAttribute');
    });

    context('Test createRecords function', () => {
        let row_keys = ['8', '9', '12', '10'];

        before(() => {
            sandbox.stub(Date, 'now').returns('1943201');
            global.hdb_schema = {
                [SCHEMA_TABLE_TEST.schema]: {
                    [SCHEMA_TABLE_TEST.name]: {
                        attributes: SCHEMA_TABLE_TEST.attributes,
                        hash_attribute: SCHEMA_TABLE_TEST.hash_attribute,
                        residence: SCHEMA_TABLE_TEST.residence,
                        schema: SCHEMA_TABLE_TEST.schema,
                        name: SCHEMA_TABLE_TEST.name
                    }
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
                    }
                }
            };
        });

        after(() => {
            sandbox.restore();
        });
        
        it('Test that rows are inserted correctly and return msg is correct ',  () => {
            let expected_search_result = [
                [ '8', [ 'Harper', 'Mutt', '8', '5', null, '1943201', '1943201'] ],
                [ '9', [ 'Penny', 'Mutt', '9', '5', '145', '1943201', '1943201' ] ],
                [ '12', [ 'David', 'Mutt', '12', null, null, '1943201', '1943201' ] ],
                [ '10', [ 'Rob', 'Mutt', '10', '5', '145', '1943201', '1943201' ] ]
            ];
            let expected_return_result = {
                written_hashes: [ '8', '9', '12', '10' ],
                skipped_hashes: [],
                schema_table: {
                    attributes: [],
                    hash_attribute: 'id',
                    residence: undefined,
                    schema: 'dev',
                    name: 'dog'
                }
            };
            let result;
            let search_result;
            
            try {
                result = heCreateRecords(INSERT_OBJECT_TEST);
                search_result = hdb_helium.searchByKeys(row_keys, DATASTORES_TEST);
            } catch(err) {
                console.log(err);
            }

            expect(result).to.eql(expected_return_result);
            expect(search_result).eql(expected_search_result);
        });

        it('Test inserting existing and non-existing rows', () => {
            global.hdb_schema[SCHEMA_TABLE_TEST.schema][SCHEMA_TABLE_TEST.name]['attributes'] = NO_NEW_ATTR_TEST;
            let insert_obj = test_utils.deepClone(INSERT_OBJECT_TEST);
            let new_records = [
                {
                    name: "Harper",
                    breed: "Mutt",
                    id: "8",
                    age: 5
                },
                {
                    name: "Penny",
                    breed: "Mutt",
                    id: "9",
                    age: 5,
                    height: 145
                },
                {
                    name: "David",
                    breed: "Mutt",
                    id: "123"
                },
                {
                    name: "Rob",
                    breed: "Mutt",
                    id: "1232",
                    age: 5,
                    height: 145
                }
            ];
            insert_obj.records = new_records;
            let expected_return_result = {
                written_hashes: [ '123', '1232' ],
                skipped_hashes: [ '8', '9' ],
                schema_table: {
                    attributes: NO_NEW_ATTR_TEST,
                    hash_attribute: 'id',
                    residence: undefined,
                    schema: 'dev',
                    name: 'dog'
                    }
            };
            let expected_search_result = [
                [ '8', [ 'Harper', 'Mutt', '8', '5', null, '1943201', '1943201' ] ],
                [ '9', [ 'Penny', 'Mutt', '9', '5', '145', '1943201', '1943201' ] ],
                [ '123', [ 'David', 'Mutt', '123', null, null, '1943201', '1943201' ] ],
                [ '1232', [ 'Rob', 'Mutt', '1232', '5', '145', '1943201', '1943201' ] ]
            ];
            let result;
            let search_result;

            try {
                result = heCreateRecords(insert_obj);
                search_result = hdb_helium.searchByKeys(['8', '9', '123', '1232'], DATASTORES_TEST);
                
            } catch(err) {
                console.log(err);
            }

            expect(result).to.eql(expected_return_result);
            expect(search_result).to.eql(expected_search_result);
        });
        
        it('Test inserting rows that already exist',  () => {
            let expected_result = {
                written_hashes: [],
                skipped_hashes: [ '8', '9', '12', '10' ],
                schema_table:
                    { attributes: NO_NEW_ATTR_TEST,
                        hash_attribute: 'id',
                        residence: undefined,
                        schema: 'dev',
                        name: 'dog' }
            };
            let result;

            try {
                result = heCreateRecords(INSERT_OBJECT_TEST);
            } catch(err) {
                console.log(err);
            }

            expect(result).to.eql(expected_result);
        });

        it('Test that no hash error from processRows is thrown', () => {
            let insert_obj = test_utils.deepClone(INSERT_OBJECT_TEST);
            let error;
            let records_no_hash = [
                {
                    name: "Harper",
                    breed: "Mutt",
                    id: "89",
                    age: 5
                },
                {
                    name: "Penny",
                    breed: "Mutt",
                    age: 5,
                    height: 145
                }
            ];
            insert_obj.records = records_no_hash;

            try {
                heCreateRecords(insert_obj);
            } catch(err) {
                error = err;
            }

            expect(error.message).to.equal('transaction aborted due to record(s) with no hash value, check log for more info');
            expect(error).to.be.an.instanceOf(Error);
        });
    });

    context('Test checkAttributes function', () => {
        let check_attributes = heCreateRecords.__get__('checkAttributes');
        let create_new_attr_stub = sandbox.stub();
        let check_for_new_attr_stub = sandbox.stub();

        before(() => {
            heCreateRecords.__set__('createNewAttribute', create_new_attr_stub);
            heCreateRecords.__set__('checkForNewAttributes', check_for_new_attr_stub);
        });

        after(() => {
            sandbox.restore();
        });

        it('Test that it returns if no new attributes present', () => {
            check_for_new_attr_stub.returns([]);
            let result = check_attributes('auth-header', SCHEMA_TABLE_TEST, NO_NEW_ATTR_TEST);

            expect(result).to.be.undefined;
            expect(create_new_attr_stub).to.have.not.been.called;
        });

        it('Test that it calls createNewAttribute if new attributes found', () => {
            let new_attr = ['height'];
            check_for_new_attr_stub.returns(new_attr);
            check_attributes('auth-header', SCHEMA_TABLE_TEST, NO_NEW_ATTR_TEST);

            expect(create_new_attr_stub).to.have.been.called;
        });
    });

    context('Test createNewAttribute function', () => {
        let create_new_attribute = heCreateRecords.__get__('createNewAttribute');
        let create_attribute_stub = sandbox.stub();
        let log_warn_spy;

        before(() => {
            heCreateRecords.__set__('createAttribute', create_attribute_stub);
            log_warn_spy = sandbox.spy(log, 'warn');
        });

        after(() => {
            sandbox.restore();
        });

        it('Test nominal behaviour, createAttribute is called as expected', () => {
            create_new_attribute('auth-header', INSERT_OBJECT_TEST.schema, INSERT_OBJECT_TEST.table, NO_NEW_ATTR_TEST);

            expect(create_attribute_stub).to.have.been.calledWith(ATTR_OBJ_TEST);
        });

        it('Test that attribute already exists error is caught and not thrown', () => {
            create_attribute_stub.throws(new Error('attribute already exists'));
            create_new_attribute('auth-header', INSERT_OBJECT_TEST.schema, INSERT_OBJECT_TEST.table, NO_NEW_ATTR_TEST);

            expect(log_warn_spy).to.have.been.called;
        });
    });

    context('Test createAttribute function', () => {
        let create_attribute = heCreateRecords.__get__('createAttribute');
        let he_create_attr_stub = sandbox.stub();

        before(() => {
            heCreateRecords.__set__('heCreateAttribute', he_create_attr_stub);
        });

        it('Test for nominal behaviour, heCreateAttribute called as expected', () => {
            create_attribute(ATTR_OBJ_TEST);

            expect(he_create_attr_stub).to.have.been.calledWith(ATTR_OBJ_TEST);
        });

        it('Test that error from heCreateAttribute is caught and thrown', () => {
            let error_msg = 'Error creating attribute in Helium';
            he_create_attr_stub.throws(new Error(error_msg));
            let error;
            try {
                create_attribute(ATTR_OBJ_TEST);
            } catch(err) {
                error = err;
            }

            expect(error.message).to.equal(error_msg);
        });
    });
});
