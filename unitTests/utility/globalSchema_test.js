'use strict';

const assert = require('assert');
const async = require('async');
const sinon = require('sinon');
const system_schema = require('../../json/systemSchema.json');
const rewire = require('rewire');
const schema = require('../../data_layer/schemaDescribe');
const global_schema = rewire('../../utility/globalSchema');
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
        system_schema.dev = DEV_SCHEMA;
        global.hdb_schema.dev = DEV_SCHEMA;

    });

    afterEach(function () {
        delete system_schema['dev'];
        delete global.hdb_schema.dev;
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
        assert.deepEqual(returnSchema('system', 'hdb_queue'), system_schema['hdb_queue']);
        assert.deepEqual(returnSchema('system', 'emptyTable'), system_schema['emptyTable']);
        done();
    });

    it('Can return dev schema from global', function (done) {
        let returnSchema = global_schema.__get__('returnSchema');

        assert.deepEqual(returnSchema('dev', 'dog'), system_schema['dev']['dog']);
        assert.deepEqual(returnSchema('dev', 'cat'), system_schema['dev']['cat']);
        assert.deepEqual(returnSchema('dev', 'bird'), system_schema['dev']['bird']);
        done();
    });
});

describe('Test getTableSchema function', function () {
    beforeEach(function () {
        system_schema.dev = DEV_SCHEMA;
        global.hdb_schema.dev = DEV_SCHEMA;

    });

    afterEach(function () {
        delete system_schema['dev'];
        delete global.hdb_schema.dev;
    });

    it('Can get table from dev schema', function (done) {
        let getTableSchema = global_schema.__get__('getTableSchema');
        getTableSchema('dev', 'cat', function (err, result) {
            assert.deepEqual(result, DEV_SCHEMA['cat']);
        });
        getTableSchema('dev', 'bird', function (err, result) {

            assert.deepEqual(result, DEV_SCHEMA['bird']);
        });
        getTableSchema('dev', 'dog', function (err, result) {
            assert.deepEqual(result, DEV_SCHEMA['dog']);
        });
        done();
    });

    it('Can get table from system schema', function (done) {
        let getTableSchema = global_schema.__get__('getTableSchema');
        getTableSchema('system', 'hdb_queue', function (err, result) {
            assert.deepEqual(result, system_schema['hdb_queue']);
        });
        getTableSchema('system', 'hdb_drop_schema', function (err, result) {
            assert.deepEqual(result, system_schema['hdb_drop_schema']);
        });
        getTableSchema('system', 'hdb_attribute', function (err, result) {

            assert.deepEqual(result, system_schema['hdb_attribute']);
        });
        getTableSchema('system', 'hdb_schema', function (err, result) {
            assert.deepEqual(result, system_schema['hdb_schema']);
        });

        getTableSchema('system', 'hdb_user', function (err, result) {
            assert.deepEqual(result, system_schema['hdb_user']);
        });
        getTableSchema('system', 'hdb_role', function (err, result) {
            assert.deepEqual(result, system_schema['hdb_role']);
        });
        getTableSchema('system', 'hdb_job', function (err, result) {
            assert.deepEqual(result, system_schema['hdb_job']);
        });
        getTableSchema('system', 'hdb_license', function (err, result) {
            assert.deepEqual(result, system_schema['hdb_license']);
        });
        getTableSchema('system', 'hdb_nodes', function (err, result) {
            assert.deepEqual(result, system_schema['hdb_nodes']);
        });
        getTableSchema('system', 'hdb_queue', function (err, result) {
            assert.deepEqual(result, system_schema['hdb_queue']);
        });
        getTableSchema('system', 'emptyTable', function (err, result) {
            assert.deepEqual(result, system_schema['emptyTable']);
        });
        done();
    });

    it('Error should be shown when trying to get the table that doesn\'t have in system and dev schema', function (done) {
        let getTableSchema = global_schema.__get__('getTableSchema');
        getTableSchema('system', 'notable', function (err) {
            assert.equal(err, 'table system.notable does not exist');
        });

        getTableSchema('dev', 'notable', function (err) {
            assert.equal(err, 'Invalid table');
        });
        done();
    });
});

describe('Test setTableDataToGlobal function', function () {
    describe('Test if no table object', function () {
        it('Should show error when get not have table on dev schema', function (done) {
            let setTableDataToGlobal = global_schema.__get__('setTableDataToGlobal');
            setTableDataToGlobal('dev', 'dogs', (err) => {
                assert.equal(err, 'Invalid table');
            });
            done();
        });
    });

    describe('Test if have dog table object', function () {
        let describeTable_stub = undefined;

        beforeEach(function () {
            system_schema.dev = DEV_SCHEMA;
            delete global.hdb_schema.dev;
            describeTable_stub = sinon.stub(schema, 'describeTable').yields('', TABLE_INFO_DEV_DOG);
        });

        afterEach(function () {
            delete system_schema['dev'];
            delete global.hdb_schema.dev;
            describeTable_stub.restore();
        });

        it('global.hdb_schema["dev"]["dog"] Should equal TABLE_INFO_DEV_DOG', function (done) {
            let setTableDataToGlobal = global_schema.__get__('setTableDataToGlobal');
            setTableDataToGlobal('dev', 'dog', () => {
                assert.deepEqual(global.hdb_schema['dev']['dog'], TABLE_INFO_DEV_DOG);
            });
            done();
        });

        it('if global.hdb_schema is empty ', function (done) {
            delete global.hdb_schema;
            let setTableDataToGlobal = global_schema.__get__('setTableDataToGlobal');
            setTableDataToGlobal('dev', 'dog', () => {
                assert.deepEqual(global.hdb_schema['dev']['dog'], TABLE_INFO_DEV_DOG);
            });
            done();
        });

        it('if dev schema is empty', function (done) {
            delete global.hdb_schema.dev;
            let getTableSchema = global_schema.__get__('getTableSchema');
            getTableSchema('dev', 'dog', function () {
                assert.deepEqual(global.hdb_schema['dev']['dog'], TABLE_INFO_DEV_DOG);
            });
            done();
        });
    });

    describe('Test if have cat table object', function () {
        let describeTable_stub = undefined;

        beforeEach(function () {
            system_schema.dev = DEV_SCHEMA;
            delete global.hdb_schema.dev;
            describeTable_stub = sinon.stub(schema, 'describeTable').yields('', TABLE_INFO_DEV_CAT);
        });

        afterEach(function () {
            delete system_schema['dev'];
            delete global.hdb_schema.dev;
            describeTable_stub.restore();
        });

        it('global.hdb_schema["dev"]["cat"] Should equal TABLE_INFO_DEV_CAT', function (done) {
            let setTableDataToGlobal = global_schema.__get__('setTableDataToGlobal');
            setTableDataToGlobal('dev', 'cat', () => {
                assert.deepEqual(global.hdb_schema['dev']['cat'], TABLE_INFO_DEV_CAT);
            });
            done();
        });

        it('if global.hdb_schema is empty ', function (done) {
            delete global.hdb_schema;
            let setTableDataToGlobal = global_schema.__get__('setTableDataToGlobal');
            setTableDataToGlobal('dev', 'cat', () => {
                assert.deepEqual(global.hdb_schema['dev']['cat'], TABLE_INFO_DEV_CAT);
            });
            done();
        });

        it('if dev schema is empty', function (done) {
            delete global.hdb_schema.dev;
            let getTableSchema = global_schema.__get__('getTableSchema');
            getTableSchema('dev', 'cat', function () {
                assert.deepEqual(global.hdb_schema['dev']['cat'], TABLE_INFO_DEV_CAT);
            });
            done();
        });
    });

    describe('Test if have bird table object', function () {
        let describeTable_stub = undefined;

        beforeEach(function () {
            system_schema.dev = DEV_SCHEMA;
            delete global.hdb_schema.dev;
            describeTable_stub = sinon.stub(schema, 'describeTable').yields('', TABLE_INFO_DEV_BIRD);
        });

        afterEach(function () {
            delete system_schema['dev'];
            delete global.hdb_schema.dev;
            describeTable_stub.restore();
        });

        it('global.hdb_schema["dev"]["bird"] Should equal TABLE_INFO_DEV_BIRD', function (done) {
            let setTableDataToGlobal = global_schema.__get__('setTableDataToGlobal');
            setTableDataToGlobal('dev', 'bird', () => {
                assert.deepEqual(global.hdb_schema['dev']['bird'], TABLE_INFO_DEV_BIRD);
            });
            done();
        });

        it('if global.hdb_schema is empty ', function (done) {
            delete global.hdb_schema;
            let setTableDataToGlobal = global_schema.__get__('setTableDataToGlobal');
            setTableDataToGlobal('dev', 'bird', () => {
                assert.deepEqual(global.hdb_schema['dev']['bird'], TABLE_INFO_DEV_BIRD);
            });
            done();
        });

        it('if dev schema is empty', function (done) {
            delete global.hdb_schema.dev;
            let getTableSchema = global_schema.__get__('getTableSchema');
            getTableSchema('dev', 'bird', function () {
                assert.deepEqual(global.hdb_schema['dev']['bird'], TABLE_INFO_DEV_BIRD);
            });
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