'use strict';

const test_util = require('../test_utils');
test_util.preTestPrep();
const assert = require('assert');
const async = require('async');
const system_schema = require('../../json/systemSchema.json');
const rewire = require('rewire');
const schema = rewire('../../data_layer/schemaDescribe');
const global_schema = rewire('../../utility/globalSchema');

const TEST_DATA_BIRD = [
    {
        "age": 2,
        "breed": "parakeet",
        "id": 1,
        "name": "Britt"
    },
];

const TEST_DATA_CAT = [
    {
        "age": 18,
        "breed": "tabby",
        "id": 1,
        "name": "Beepers"
    },
];

const TEST_DATA_DOG = [
    {
        "age": 5,
        "breed": "Mutt",
        "id": 1,
        "name": "Sam"
    },
    {
        "age": 4,
        "breed": "Golden Retriever",
        "id": 2,
        "name": "David"
    },
    {
        "age": 10,
        "breed": "Pit Bull",
        "id": 3,
        "name": "Kyle"
    },
    {
        "age": 10,
        "breed": "Pit",
        "id": 4,
        "name": "Sam"
    },
    {
        "age": 15,
        "breed": "Poodle",
        "id": 5,
        "name": "Eli"
    },
    {
        "age": 8,
        "breed": "Poodle",
        "id": 6,
        "name": "Sarah"
    }
];

const DEV_SCHEMA = {
    'dog': {
        'hash_attribute': 'dog_id',
        'id': '8650f230-be55-4455-8843-55bcfe7f61c4',
        'name': 'dog',
        'schema': 'test',
        'attributes': [
            {
                'attribute': 'dog_id'
            },
            {
                'attribute': 'breed'
            }
        ]
    },
    'cat': {
        'hash_attribute': 'cat_id',
        'id': '8650f230-be55-4455-8843-55bcfe7f61c4',
        'name': 'cat',
        'schema': 'test',
        'attributes': [
            {
                'attribute': 'cat_name'
            },
            {
                'attribute': 'cat_id'
            }
        ]
    },
    'bird': {
        'hash_attribute': 'bird_id',
        'id': '8650f230-be55-4455-8843-55bcfe7f61c4',
        'name': 'bird',
        'schema': 'test',
        'attributes': [
            {
                'attribute': 'bird_id'
            },
            {
                'attribute': 'bird_age'
            }
        ]
    }
};

const TABLE_INFO_DEV_DOG = {
    id: 'ca533abc-3278-4e62-8e03-9d706e72669b',
    hash_attribute: 'dog_id',
    name: 'dog',
    schema: 'dev',
    attributes: [{ attribute: 'breed' }, { attribute: 'dog_id' }]
};

const TABLE_INFO_DEV_CAT = {
    id: 'ca533abc-3278-4e62-8e03-9d706e72669c',
    hash_attribute: 'cat_id',
    name: 'cat',
    schema: 'dev',
    attributes: [{ attribute: 'cat_name' }, { attribute: 'cat_id' }]
};

const TABLE_INFO_DEV_BIRD = {
    id: 'ca533abc-3278-4e62-8e03-9d706e72669d',
    hash_attribute: 'bird_id',
    name: 'bird',
    schema: 'dev',
    attributes: [{ attribute: 'bird_age' }, { attribute: 'bird_id' }]
};

const SCHEMA_NAME = 'dev';
const DOG_TABLE_NAME = 'dog';
const DOG_TABLE_HASH_ATTRIBUTE = 'id';
const CAT_TABLE_NAME = 'cat';
const CAT_TABLE_HASH_ATTRIBUTE = 'id';
const BIRD_TABLE_NAME = 'bird';
const BIRD_TABLE_HASH_ATTRIBUTE = 'id';

describe('Test setSchemaDataToGlobal function', function () {
    it('Has data["systems"] in global.hdb_schema', function (done) {
        async.parallel(
            [
                global_schema.setSchemaDataToGlobal,
            ], function () {
                assert.deepEqual(global.hdb_schema['system'], system_schema);
                done();
            });

    });
});

describe('Test returnSchema function', function () {
    beforeEach(function () {
        test_util.createMockFS(DOG_TABLE_HASH_ATTRIBUTE,SCHEMA_NAME,DOG_TABLE_NAME,TEST_DATA_DOG);
        test_util.createMockFS(BIRD_TABLE_HASH_ATTRIBUTE,SCHEMA_NAME,CAT_TABLE_NAME,TEST_DATA_CAT);
        test_util.createMockFS(CAT_TABLE_HASH_ATTRIBUTE,SCHEMA_NAME,BIRD_TABLE_NAME,TEST_DATA_BIRD);
    });

    afterEach(function () {
        test_util.tearDownMockFS();
    });

    it('Can return system schema from global', function (done) {
        let returnSchema = global_schema.__get__('returnSchema');
        assert.deepEqual(returnSchema('system', 'hdb_table'), system_schema['hdb_table']);
        assert.deepEqual(returnSchema('system', 'hdb_drop_schema'), system_schema['hdb_drop_schema']);
        assert.deepEqual(returnSchema('system', 'hdb_attribute'), system_schema['hdb_attribute']);
        assert.deepEqual(returnSchema('system', 'hdb_schema'), system_schema['hdb_schema']);
        assert.deepEqual(returnSchema('system', 'hdb_user'), system_schema['hdb_user']);
        assert.deepEqual(returnSchema('system', 'hdb_role'), system_schema['hdb_role']);
        assert.deepEqual(returnSchema('system', 'hdb_job'), system_schema['hdb_job']);
        assert.deepEqual(returnSchema('system', 'hdb_license'), system_schema['hdb_license']);
        assert.deepEqual(returnSchema('system', 'hdb_nodes'), system_schema['hdb_nodes']);
        assert.deepEqual(returnSchema('system', 'emptyTable'), system_schema['emptyTable']);
        done();
    });

    it('Can return dev schema from global', function (done) {
        let returnSchema = global_schema.__get__('returnSchema');
        let temp = returnSchema('dev', 'dog');
        assert.deepEqual(returnSchema('dev', 'dog'), global.hdb_schema['dev']['dog']);
        assert.deepEqual(returnSchema('dev', 'cat'), global.hdb_schema['dev']['cat']);
        assert.deepEqual(returnSchema('dev', 'bird'), global.hdb_schema['dev']['bird']);
        done();
    });
});

describe('Test getTableSchema function', function () {
    beforeEach(function () {
        test_util.createMockFS(DOG_TABLE_HASH_ATTRIBUTE,SCHEMA_NAME,DOG_TABLE_NAME,TEST_DATA_DOG);
        test_util.createMockFS(BIRD_TABLE_HASH_ATTRIBUTE,SCHEMA_NAME,CAT_TABLE_NAME,TEST_DATA_CAT);
        test_util.createMockFS(CAT_TABLE_HASH_ATTRIBUTE,SCHEMA_NAME,BIRD_TABLE_NAME,TEST_DATA_BIRD);
    });

    afterEach(function () {
        test_util.tearDownMockFS();
    });

    it('Can get dog table from dev schema', function (done) {
        let getTableSchema = global_schema.__get__('getTableSchema');
        getTableSchema('dev', 'cat', function (err, result) {
            assert.deepEqual(result.name, DEV_SCHEMA['cat'].name);
            done();
        });
    });

    it('Can get table from dog schema', function (done) {
        let getTableSchema = global_schema.__get__('getTableSchema');
        getTableSchema('dev', 'dog', function (err, result) {
            assert.deepEqual(result.name, DEV_SCHEMA['dog'].name);
            done();
        });
    });

    it('Can get table from bird schema', function (done) {
        let getTableSchema = global_schema.__get__('getTableSchema');
        getTableSchema('dev', 'bird', function (err, result) {
            assert.deepEqual(result.name, DEV_SCHEMA['bird'].name);
            done();
        });
    });

    it('Can get table hdb_attribute from system schema', function (done) {
        let getTableSchema = global_schema.__get__('getTableSchema');
        getTableSchema('system', 'hdb_attribute', function (err, result) {
            assert.deepEqual(result.name, system_schema['hdb_attribute'].name);
            done();
        });
    });

    it('Can get table hdb_schema from system schema', function (done) {
        let getTableSchema = global_schema.__get__('getTableSchema');
        getTableSchema('system', 'hdb_schema', function (err, result) {
            assert.deepEqual(result.name, system_schema['hdb_schema'].name);
            done();
        });
    });

    it('Can get table hdb_user from system schema', function (done) {
        let getTableSchema = global_schema.__get__('getTableSchema');
        getTableSchema('system', 'hdb_user', function (err, result) {
            assert.deepEqual(result.name, system_schema['hdb_user'].name);
            done();
        });
    });

    it('Can get table hdb_role from system schema', function (done) {
        let getTableSchema = global_schema.__get__('getTableSchema');
        getTableSchema('system', 'hdb_role', function (err, result) {
            assert.deepEqual(result.name, system_schema['hdb_role'].name);
            done();
        });
    });

    it('Can get table hdb_job from system schema', function (done) {
        let getTableSchema = global_schema.__get__('getTableSchema');
        getTableSchema('system', 'hdb_job', function (err, result) {
            assert.deepEqual(result.name, system_schema['hdb_job'].name);
            done();
        });
    });

    it('Can get table hdb_license from system schema', function (done) {
        let getTableSchema = global_schema.__get__('getTableSchema');
        getTableSchema('system', 'hdb_license', function (err, result) {
            assert.deepEqual(result.name, system_schema['hdb_license'].name);
            done();
        });
    });

    it('Can get table hdb_nodes from system schema', function (done) {
        let getTableSchema = global_schema.__get__('getTableSchema');
        getTableSchema('system', 'hdb_nodes', function (err, result) {
            assert.deepEqual(result.name, system_schema['hdb_nodes'].name);
            done();
        });
    });

    it('Error should be shown when trying to get the table that doesn\'t have in system and dev schema', function (done) {
        let getTableSchema = global_schema.__get__('getTableSchema');
        getTableSchema('system', 'notable', function (err) {
            assert.equal(err, 'table system.notable does not exist');
            done();
        });
    });

    it('Error should be shown when trying to get the table that doesn\'t have in system and dev', function (done) {
        let getTableSchema = global_schema.__get__('getTableSchema');
        getTableSchema('dev', 'notable', function (err) {
            assert.equal(err.message, 'Invalid table');
            done();
        });
    });
});

describe('Test if no table object', function () {
    beforeEach(function () {
        test_util.createMockFS(DOG_TABLE_HASH_ATTRIBUTE,SCHEMA_NAME,DOG_TABLE_NAME,TEST_DATA_DOG);
        test_util.createMockFS(BIRD_TABLE_HASH_ATTRIBUTE,SCHEMA_NAME,CAT_TABLE_NAME,TEST_DATA_CAT);
        test_util.createMockFS(CAT_TABLE_HASH_ATTRIBUTE,SCHEMA_NAME,BIRD_TABLE_NAME,TEST_DATA_BIRD);
    });

    afterEach(function () {
        test_util.tearDownMockFS();
    });

    it('Should show error when get not have table on dev schema', function (done) {
        let setTableDataToGlobal = global_schema.__get__('setTableDataToGlobal');
        setTableDataToGlobal('dev', 'dogs', (err, results) => {
            assert.equal(err.message, 'Invalid table');
            done();
        });
    });
});

describe('Test if have dog table object', function () {
    beforeEach(function () {
        test_util.createMockFS(DOG_TABLE_HASH_ATTRIBUTE,SCHEMA_NAME,DOG_TABLE_NAME,TEST_DATA_DOG);
        test_util.createMockFS(BIRD_TABLE_HASH_ATTRIBUTE,SCHEMA_NAME,CAT_TABLE_NAME,TEST_DATA_CAT);
        test_util.createMockFS(CAT_TABLE_HASH_ATTRIBUTE,SCHEMA_NAME,BIRD_TABLE_NAME,TEST_DATA_BIRD);
    });

    afterEach(function () {
        test_util.tearDownMockFS();
    });

    it('global.hdb_schema["dev"]["dog"] Should equal TABLE_INFO_DEV_DOG', function (done) {
        let setTableDataToGlobal = global_schema.__get__('setTableDataToGlobal');
        setTableDataToGlobal('dev', 'dog', () => {
            assert.deepEqual(global.hdb_schema['dev']['dog'].name, TABLE_INFO_DEV_DOG.name);
            done();
        });
    });

    it('if global.hdb_schema is empty ', function (done) {
        delete global.hdb_schema;
        let setTableDataToGlobal = global_schema.__get__('setTableDataToGlobal');
        setTableDataToGlobal('dev', 'dog', () => {
            assert.deepEqual(global.hdb_schema['dev']['dog'].name, TABLE_INFO_DEV_DOG.name);
            done();
        });
    });

    it('if dev schema is empty', function (done) {
        delete global.hdb_schema.dev;
        let getTableSchema = global_schema.__get__('getTableSchema');
        getTableSchema('dev', 'dog', function () {
            assert.deepEqual(global.hdb_schema['dev']['dog'].name, TABLE_INFO_DEV_DOG.name);
            done();
        });
    });
});

describe('Test if have cat table object', function () {
    beforeEach(function () {
        test_util.createMockFS(DOG_TABLE_HASH_ATTRIBUTE,SCHEMA_NAME,DOG_TABLE_NAME,TEST_DATA_DOG);
        test_util.createMockFS(BIRD_TABLE_HASH_ATTRIBUTE,SCHEMA_NAME,CAT_TABLE_NAME,TEST_DATA_CAT);
        test_util.createMockFS(CAT_TABLE_HASH_ATTRIBUTE,SCHEMA_NAME,BIRD_TABLE_NAME,TEST_DATA_BIRD);
    });

    afterEach(function () {
        test_util.tearDownMockFS();
    });

    it('global.hdb_schema["dev"]["cat"] Should equal TABLE_INFO_DEV_CAT', function (done) {
        let setTableDataToGlobal = global_schema.__get__('setTableDataToGlobal');
        setTableDataToGlobal('dev', 'cat', () => {
            assert.deepEqual(global.hdb_schema['dev']['cat'].name, TABLE_INFO_DEV_CAT.name);
            done();
        });
    });

    it('if global.hdb_schema is empty ', function (done) {
        delete global.hdb_schema;
        let setTableDataToGlobal = global_schema.__get__('setTableDataToGlobal');
        setTableDataToGlobal('dev', 'cat', () => {
            assert.deepEqual(global.hdb_schema['dev']['cat'].name, TABLE_INFO_DEV_CAT.name);
            done();
        });
    });

    it('if dev schema is empty', function (done) {
        delete global.hdb_schema.dev;
        let getTableSchema = global_schema.__get__('getTableSchema');
        getTableSchema('dev', 'cat', function () {
            assert.deepEqual(global.hdb_schema['dev']['cat'].name, TABLE_INFO_DEV_CAT.name);
            done();
        });
    });
});

describe('Test if have bird table object', function () {
    let describeTable_stub = undefined;

    beforeEach(function () {
        test_util.createMockFS(DOG_TABLE_HASH_ATTRIBUTE,SCHEMA_NAME,DOG_TABLE_NAME,TEST_DATA_DOG);
        test_util.createMockFS(BIRD_TABLE_HASH_ATTRIBUTE,SCHEMA_NAME,CAT_TABLE_NAME,TEST_DATA_CAT);
        test_util.createMockFS(CAT_TABLE_HASH_ATTRIBUTE,SCHEMA_NAME,BIRD_TABLE_NAME,TEST_DATA_BIRD);
    });

    afterEach(function () {
        test_util.tearDownMockFS();
    });

    it('global.hdb_schema["dev"]["bird"] Should equal TABLE_INFO_DEV_BIRD', function (done) {
        let setTableDataToGlobal = global_schema.__get__('setTableDataToGlobal');
        setTableDataToGlobal('dev', 'bird', () => {
            assert.deepEqual(global.hdb_schema['dev']['bird'].name, TABLE_INFO_DEV_BIRD.name);
            done();
        });
    });

    it('if global.hdb_schema is empty ', function (done) {
        delete global.hdb_schema;
        let setTableDataToGlobal = global_schema.__get__('setTableDataToGlobal');
        setTableDataToGlobal('dev', 'bird', () => {
            assert.deepEqual(global.hdb_schema['dev']['bird'].name, TABLE_INFO_DEV_BIRD.name);
            done();
        });
    });

    it('if dev schema is empty', function (done) {
        delete global.hdb_schema.dev;
        let getTableSchema = global_schema.__get__('getTableSchema');
        getTableSchema('dev', 'bird', function () {
            assert.deepEqual(global.hdb_schema['dev']['bird'].name, TABLE_INFO_DEV_BIRD.name);
            done();
        });
    });
});

describe('Test getSystemSchema function', function () {

    it('Should equal system_schema json', function (done) {
        let getSystemSchema = global_schema.__get__('getSystemSchema');
        assert.deepEqual(getSystemSchema(), system_schema);
        done();
    });

});