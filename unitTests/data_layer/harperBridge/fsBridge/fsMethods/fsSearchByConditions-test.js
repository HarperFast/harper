'use strict';

const test_utils = require('../../../../test_utils');
const {
    createMockFS,
    deepClone,
    getMockFSPath,
    mochaAsyncWrapper,
    tearDownMockFS,
    preTestPrep
} = test_utils;

preTestPrep();

const rewire = require('rewire');
const getAttributeFileValues_rw = rewire('../../../../../data_layer/harperBridge/fsBridge/fsUtility/getAttributeFileValues');
getAttributeFileValues_rw.__set__('getBasePath', getMockFSPath);
let fsSearchByConditions_rw = rewire('../../../../../data_layer/harperBridge/fsBridge/fsMethods/fsSearchByConditions');
fsSearchByConditions_rw.__set__('getBasePath', getMockFSPath);
const { expect } = require('chai');

const { TEST_DATA_DOG } = require('../../../../test_data');
const TEST_SCHEMA = 'dev';
const HASH_ATTRIBUTE = 'id';
const TEST_TABLE_DOG = 'dog';

let test_data_dog;
let test_search_attr1 = 'breed';
let test_search_attr2 = 'name';
const test_search_val1 = 'Poodle';
const test_search_val2 = 'Sarah';
let test_attr_names;
const test_expected_hash_result1 = [];
const test_expected_hash_result2 = [];
const test_conditions1 = [
    {
        "and":
            {"=":[test_search_attr1, test_search_val1]}
    }
];
const test_conditions2 = [
    {
        "and":
            {"=":[test_search_attr1, test_search_val1]}
    },
    {
        "and":
            {"=":[test_search_attr2, test_search_val2]}
    }
];

const TEST_SEARCH_OBJ = (conds) => ({
    operation: "search_by_value",
    schema: TEST_SCHEMA,
    table: TEST_TABLE_DOG,
    conditions: conds,
    get_attributes: "*"

});

const ERR_MSGS = {
    SCHEMA: "Schema can't be blank",
    TABLE: "Table can't be blank",
    CONDITIONS: "Conditions can't be blank",
    GET_ATTR: "Get attributes can't be blank"
}

function setupTestData() {
    const test_data = deepClone(TEST_DATA_DOG);
    test_attr_names = Object.keys(test_data[0]);
    test_data_dog = test_data.reduce((acc, row) => {
        acc[row.id] = row;
        if (row[test_search_attr1] === test_search_val1) {
            test_expected_hash_result1.push(row.id);
            if (row[test_search_attr2] === test_search_val2) {
                test_expected_hash_result2.push(row.id);
            }
        }
        return acc;
    }, {});
    createMockFS(HASH_ATTRIBUTE, TEST_SCHEMA, TEST_TABLE_DOG, test_data);
}

// Search Object
// {
//   schema:String, // schema to search
//   table:String, // table to search
//   conditions: Array // search condition to filter rows on
//   get_attributes:Array // attributes to return with search result
// }

describe('fsSearchByCondition', () => {

    before(() => {
        setupTestData();
        fsSearchByConditions_rw.__set__('getAttributeFileValues', getAttributeFileValues_rw);
    });

    after(() => {
        tearDownMockFS();
        rewire('../../../../../data_layer/harperBridge/fsBridge/fsMethods/fsGetDataByValue');
        rewire('../../../../../data_layer/harperBridge/fsBridge/fsUtility/getAttributeFileValues');
    });


    it('Single condition - should return rows based on condition passed', mochaAsyncWrapper(async () => {
        const test_search_result = await fsSearchByConditions_rw(TEST_SEARCH_OBJ(test_conditions1));

        expect(test_search_result.length).to.equal(test_expected_hash_result1.length);
        test_search_result.forEach(row => {
            expect(test_expected_hash_result1.includes(row.id)).to.equal(true);
        });
    }));

    it('Single condition - should return correct attributes for both matching rows returned', mochaAsyncWrapper(async () => {
        const test_search_result = await fsSearchByConditions_rw(TEST_SEARCH_OBJ(test_conditions1));

        test_search_result.forEach(row => {
            expect(test_expected_hash_result1.includes(row.id)).to.equal(true);
            Object.keys(row).forEach(attr_name => {
                expect(test_data_dog[row.id][attr_name]).to.equal(row[attr_name]);
            });
        });
    }));

    it('Single condition - should return specified attributes for both matching rows returned', mochaAsyncWrapper(async () => {
        const test_attr_name = test_attr_names[0];
        const TEMP_SEARCH_OBJECT = deepClone(TEST_SEARCH_OBJ(test_conditions1));
        TEMP_SEARCH_OBJECT.get_attributes = [HASH_ATTRIBUTE, test_attr_name];

        const test_search_result = await fsSearchByConditions_rw(TEMP_SEARCH_OBJECT);

        expect(test_search_result.length).to.equal(test_expected_hash_result1.length);
        test_search_result.forEach(row => {
            expect(test_expected_hash_result1.includes(row.id)).to.equal(true);
            Object.keys(row).forEach(attr_name => {
                expect(test_attr_names.includes(attr_name)).to.equal(true);
                expect(row[attr_name]).to.equal(test_data_dog[row.id][attr_name]);
            });
        });
    }));

    it('Multi condition - should return rows based on condition passed', mochaAsyncWrapper(async () => {
        const test_search_result = await fsSearchByConditions_rw(TEST_SEARCH_OBJ(test_conditions2));

        expect(test_search_result.length).to.equal(test_expected_hash_result2.length);
        test_search_result.forEach(row => {
            expect(test_expected_hash_result2.includes(row.id)).to.equal(true);
        });
    }));

    it('Multi condition - should return correct attributes for both matching rows returned', mochaAsyncWrapper(async () => {
        const test_search_result = await fsSearchByConditions_rw(TEST_SEARCH_OBJ(test_conditions2));

        test_search_result.forEach(row => {
            expect(test_expected_hash_result2.includes(row.id)).to.equal(true);
            Object.keys(row).forEach(attr_name => {
                expect(test_data_dog[row.id][attr_name]).to.equal(row[attr_name]);
            });
        });
    }));

    it('Multi condition - should return specified attributes for both matching rows returned', mochaAsyncWrapper(async () => {
        const test_attr_name = test_attr_names[0];
        const TEMP_SEARCH_OBJECT = deepClone(TEST_SEARCH_OBJ(test_conditions2));
        TEMP_SEARCH_OBJECT.get_attributes = [HASH_ATTRIBUTE, test_attr_name];

        const test_search_result = await fsSearchByConditions_rw(TEMP_SEARCH_OBJECT);

        expect(test_search_result.length).to.equal(test_expected_hash_result2.length);
        test_search_result.forEach(row => {
            expect(test_expected_hash_result2.includes(row.id)).to.equal(true);
            Object.keys(row).forEach(attr_name => {
                expect(test_attr_names.includes(attr_name)).to.equal(true);
                expect(row[attr_name]).to.equal(test_data_dog[row.id][attr_name]);
            });
        });
    }));

    it('Should return error if empty object is passed in', mochaAsyncWrapper(async () => {
        let err;
        try{
            await fsSearchByConditions_rw({});
        } catch(e) {
            err = e;
        }

        expect(err.message).to.equal("Schema can't be blank,Table can't be blank,Conditions can't be blank");
    }));

    it('Should return error if empty string is passed in for schema', mochaAsyncWrapper(async () => {
        const TEMP_SEARCH_OBJECT = deepClone(TEST_SEARCH_OBJ(test_conditions1));
        TEMP_SEARCH_OBJECT.schema = "";
        let err;

        try{
            err = await fsSearchByConditions_rw(TEMP_SEARCH_OBJECT);
        } catch(e) {
            err = e;
        }

        expect(err.message).to.equal(ERR_MSGS.SCHEMA);
    }));

    it('Should return error if empty string is passed in for table', mochaAsyncWrapper(async () => {
        const TEMP_SEARCH_OBJECT = deepClone(TEST_SEARCH_OBJ(test_conditions1));
        TEMP_SEARCH_OBJECT.table = "";
        let err;

        try{
            err = await fsSearchByConditions_rw(TEMP_SEARCH_OBJECT);
        } catch(e) {
            err = e;
        }

        expect(err.message).to.equal(ERR_MSGS.TABLE);
    }));

    // TODO: fix error handling for this scenario - currently, this returns 'Cannot read property '0' of undefined'
    // it('Should return error if array with empty object is passed in for conditions', mochaAsyncWrapper(async () => {
    //     const TEMP_SEARCH_OBJECT = deepClone(TEST_SEARCH_OBJ(test_conditions1));
    //     TEMP_SEARCH_OBJECT.conditions = [{}];
    //     let err;
    //
    //     try{
    //         err = await fsSearchByConditions_rw(TEMP_SEARCH_OBJECT);
    //     } catch(e) {
    //         err = e;
    //     }
    //
    //     expect(err.message).to.equal(ERR_MSGS.CONDITIONS);
    // }));

    it('Should return error if empty object is passed in for conditions', mochaAsyncWrapper(async () => {
        const TEMP_SEARCH_OBJECT = deepClone(TEST_SEARCH_OBJ(test_conditions1));
        TEMP_SEARCH_OBJECT.conditions = {};
        let err;

        try{
            err = await fsSearchByConditions_rw(TEMP_SEARCH_OBJECT);
        } catch(e) {
            err = e;
        }

        expect(err.message).to.equal(ERR_MSGS.CONDITIONS);
    }));

    it('Should return error if empty string is passed in for conditions', mochaAsyncWrapper(async () => {
        const TEMP_SEARCH_OBJECT = deepClone(TEST_SEARCH_OBJ(test_conditions1));
        TEMP_SEARCH_OBJECT.conditions = '';
        let err;

        try{
            await fsSearchByConditions_rw(TEMP_SEARCH_OBJECT);
        } catch(e) {
            err = e;
        }

        expect(err.message).to.equal(ERR_MSGS.CONDITIONS);
    }));

    it('Should return error if empty array is passed in for conditions', mochaAsyncWrapper(async () => {
        const TEMP_SEARCH_OBJECT = deepClone(TEST_SEARCH_OBJ(test_conditions1));
        TEMP_SEARCH_OBJECT.conditions = [];
        let err;

        try{
            await fsSearchByConditions_rw(TEMP_SEARCH_OBJECT);
        } catch(e) {
            err = e;
        }

        expect(err.message).to.equal(ERR_MSGS.CONDITIONS);
    }));

    // TODO: fix error handling here - currently returning 'Cannot read property 'dev' of undefined'
    // it('Should return error if empty string is passed in for get_attributes', mochaAsyncWrapper(async () => {
    //     const TEMP_SEARCH_OBJECT = deepClone(TEST_SEARCH_OBJ(test_conditions1));
    //     TEMP_SEARCH_OBJECT.get_attributes = "";
    //     let err;
    //
    //     try{
    //         err = await fsSearchByConditions_rw(TEMP_SEARCH_OBJECT);
    //     } catch(e) {
    //         err = e;
    //     }
    //
    //     expect(err.message).to.equal(ERR_MSGS.GET_ATTR);
    // }));

    // TODO: fix error handling here - nothing is returned in this scenario
    // it('Should return error if empty array is passed in for get_attributes', mochaAsyncWrapper(async () => {
    //     const TEMP_SEARCH_OBJECT = deepClone(TEST_SEARCH_OBJ(test_conditions1));
    //     TEMP_SEARCH_OBJECT.get_attributes = [];
    //     let err;
    //
    //     try{
    //         err = await fsSearchByConditions_rw(TEMP_SEARCH_OBJECT);
    //     } catch(e) {
    //         err = e;
    //     }
    //
    //     expect(err.message).to.equal(ERR_MSGS.GET_ATTR);
    // }));
});
