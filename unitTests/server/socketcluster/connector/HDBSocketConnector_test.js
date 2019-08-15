"use strict";

const test_utils = require(`../../../test_utils`);
test_utils.preTestPrep();
const sinon = require('sinon');
const assert = require('assert');
const rewire = require('rewire');
const HDBSocketConnector = rewire('../../../../server/socketcluster/connector/HDBSocketConnector');
const existing_test_schema = global.hdb_schema;
const global_schema = require('../../../../utility/globalSchema');
const SocketConnector = require('../../../../server/socketcluster/connector/SocketConnector');
const schema = require('../../../../data_layer/schema');
const server_utils = require('../../../../server/serverUtilities');
const terms = require('../../../../utility/hdbTerms');
const {promisify} = require('util');

const p_set_global = promisify(global_schema.setSchemaDataToGlobal);
const p_get_table = promisify(global_schema.getTableSchema);

const TEST_DATA_DOG = [
    {
        "name":"Frank",
        "id":"1",
        "age":5
    },
    {
        "name":"Bill",
        "id":"2",
        "age":4
    }
];

const ID_HASH_NAME = 'id';

const SCHEMA_1_NAME = 'schema_1';
const SCHEMA_1_TABLE_1_NAME = 'schema_1_table_1';
const SCHEMA_1_TABLE_1_ID = 'table_1_id';
const SCHEMA_1_TABLE_1_ATT_1_NAME = 'table_1_att_1';
const SCHEMA_1_TABLE_1_ATT_2_NAME = 'table_1_att_2';

const SCHEMA_1_TABLE_2_NAME = 'schema_1_table_2';
const SCHEMA_1_TABLE_2_ID = 'table_2_id';
const SCHEMA_1_TABLE_2_ATT_1_NAME = 'table_2_att_1';
const SCHEMA_1_TABLE_2_ATT_2_NAME = 'table_2_att_2';

const SCHEMA_2_NAME = 'schema_2';
const SCHEMA_2_TABLE_1_NAME = 'schema_2_table_1';
const SCHEMA_2_TABLE_1_ID = 'table_1_id';
const SCHEMA_2_TABLE_1_ATT_1_NAME = 'table_1_att_1';
const SCHEMA_2_TABLE_1_ATT_2_NAME = 'table_1_att_2';

const SCHEMA_1_NEW_TABLE_NAME = 'new_table';
const SCHEMA_1_OTHER_NEW_TABLE_NAME = 'newer_table';

const SCHEMA_3_NAME = 'schema_3';

// matches the enum in HDBSocketConnector.js
const ENTITY_TYPE_ENUM = {
    SCHEMA: `schema`,
    TABLE: `table`,
    ATTRIBUTE: `attribute`
};

describe('Test compareSchemas', () => {
    //Stub out connection related configuration.
    let sandbox = undefined;
    let SocketConnector_stub = undefined;
    let AddEventListener_stub = undefined;
    let get_operation_stub = undefined;

    let connector = undefined;

    beforeEach(async () => {
        sandbox = sinon.createSandbox();
        SocketConnector_stub = sandbox.stub(SocketConnector.prototype, `init`).resolves(``);
        AddEventListener_stub = sandbox.stub(HDBSocketConnector.prototype, 'addEventListener').resolves(``);
        connector = new HDBSocketConnector(null, null, null, null);

        let dog_data = test_utils.deepClone(TEST_DATA_DOG);
        test_utils.createMockFS(ID_HASH_NAME, SCHEMA_1_NAME, SCHEMA_1_TABLE_1_NAME, dog_data);
        test_utils.createMockFS(ID_HASH_NAME, SCHEMA_1_NAME, SCHEMA_1_TABLE_2_NAME, dog_data);
        test_utils.createMockFS(ID_HASH_NAME, SCHEMA_2_NAME, SCHEMA_2_TABLE_1_NAME, dog_data);

    });

    afterEach(async () => {
        test_utils.tearDownMockFS();
        test_utils.tearDownMockFSSystem();
        sandbox.restore();
    });

    after(async () => {
        test_utils.tearDownMockFS();
        test_utils.tearDownMockFSSystem();
    });

   it('Nominal case with a new schema', async () => {
       let new_schema = 'new_schema3';
       let test_message = test_utils.deepClone(global.hdb_schema);
       test_message[new_schema] = {};
       assert.notStrictEqual(global.hdb_schema, undefined);
       let result = undefined;
        try {
            result = await connector.compareSchemas(test_message);
        } catch(err) {
            result = err;
        }
       await p_set_global();
        assert.notStrictEqual(global.hdb_schema[new_schema], undefined, 'Expected new schema to exist in global.');
   });

    it('Nominal case with 2 new schemas', async () => {
        let new_schema = 'new_schema3';
        let other_new_schema = 'other_new_schema';
        let test_message = test_utils.deepClone(global.hdb_schema);
        test_message[new_schema] = {};
        test_message[other_new_schema] = {};
        assert.notStrictEqual(global.hdb_schema, undefined);
        let result = undefined;
        try {
            result = await connector.compareSchemas(test_message);
        } catch(err) {
            result = err;
        }
        await p_set_global();
        assert.notStrictEqual(global.hdb_schema[new_schema], undefined, 'Expected new schema to exist in global.');
        assert.notStrictEqual(global.hdb_schema[other_new_schema], undefined, 'Expected new schema to exist in global.');
    });

    it('Nominal case with invalid first parameter', async () => {
        let new_schema = 'new_schema3';
        let other_new_schema = 'other_new_schema';
        let test_message = test_utils.deepClone(global.hdb_schema);
        assert.notStrictEqual(global.hdb_schema, undefined);
        let result = undefined;
        try {
            result = await connector.compareSchemas(null);
        } catch(err) {
            result = err;
        }
        assert.notStrictEqual((result instanceof Error), true, 'Expected no exception.');
        assert.strictEqual(Object.keys(global.hdb_schema).length, 3, 'Expected new schema to exist in global.');
    });
    it('Test global schema called', async () => {
        let new_schema = 'new_schema3';
        let other_new_schema = 'other_new_schema';
        let test_message = test_utils.deepClone(global.hdb_schema);
        global.hdb_schema = undefined;;
        assert.strictEqual(global.hdb_schema, undefined);
        let result = undefined;
        try {
            result = await connector.compareSchemas(null);
        } catch(err) {
            result = err;
        }
        assert.notStrictEqual((result instanceof Error), true, 'Expected no exception.');
        assert.strictEqual(Object.keys(global.hdb_schema).length, 3, 'Expected new schema to exist in global.');
    });
});

describe('Test compareAttributeKeys with filesystem', () => {
    let connector = undefined;
    let SocketConnector_stub = undefined;
    let AddEventListener_stub = undefined;
    let sandbox = undefined;
    beforeEach(async () => {
        sandbox = sinon.createSandbox();
        let dog_data = test_utils.deepClone(TEST_DATA_DOG);
        test_utils.createMockFS(ID_HASH_NAME, SCHEMA_1_NAME, SCHEMA_1_TABLE_1_NAME, dog_data);
        test_utils.createMockFS(ID_HASH_NAME, SCHEMA_1_NAME, SCHEMA_1_TABLE_2_NAME, dog_data);
        test_utils.createMockFS(ID_HASH_NAME, SCHEMA_2_NAME, SCHEMA_2_TABLE_1_NAME, dog_data);
        SocketConnector_stub = sandbox.stub(SocketConnector.prototype, `init`).resolves(``);
        AddEventListener_stub = sandbox.stub(HDBSocketConnector.prototype, 'addEventListener').resolves(``);
        connector = new HDBSocketConnector(null, null, null, null);

    });
    afterEach(async () => {
        test_utils.tearDownMockFS();
        test_utils.tearDownMockFSSystem();
        sandbox.restore();
    });

    after(async () => {
        test_utils.tearDownMockFS();
        test_utils.tearDownMockFSSystem();
    });

    it('Nominal test for compareAttributeKeys, 1 new attributes', async () => {
        let test_message = test_utils.deepClone(global.hdb_schema);
        let att_3 = 'att_3';
        test_message[SCHEMA_1_NAME][SCHEMA_1_TABLE_1_NAME].attributes.push({attribute: `${att_3}`});
        assert.strictEqual(global.hdb_schema[SCHEMA_1_NAME][SCHEMA_1_TABLE_1_NAME].attributes.length, 3, 'Expected only 3 attributes in starting schema');
        let result = undefined;
        try {
            result = await connector.compareAttributeKeys(test_message[SCHEMA_1_NAME][SCHEMA_1_TABLE_1_NAME], SCHEMA_1_NAME, SCHEMA_1_TABLE_1_NAME);
        } catch(err) {
            result = err;
        }

        // Need to force updating the global schema, otherwise we would have to wait for the signal to tell the master
        // to update.
        await p_set_global();
        let found = await p_get_table(SCHEMA_1_NAME, SCHEMA_1_TABLE_1_NAME);
        assert.strictEqual(found.attributes.length, 4, 'Expected new attribute in table');
        assert.strictEqual(global.hdb_schema[SCHEMA_1_NAME][SCHEMA_1_TABLE_1_NAME].attributes.length, 4, 'Expected new attribute in global schema');
    });
    it('Nominal test for compareAttributeKeys, 2 new attributes', async () => {
        let att_4 = 'att_4';
        let att_5 = 'att_5';
        let test_message = test_utils.deepClone(global.hdb_schema);
        test_message[SCHEMA_1_NAME][SCHEMA_1_TABLE_1_NAME].attributes.push({attribute: `${att_4}`});
        test_message[SCHEMA_1_NAME][SCHEMA_1_TABLE_1_NAME].attributes.push({attribute: `${att_5}`});

        let result = undefined;
        try {
            result = await connector.compareAttributeKeys(test_message[SCHEMA_1_NAME][SCHEMA_1_TABLE_1_NAME], SCHEMA_1_NAME, SCHEMA_1_TABLE_1_NAME);
        } catch(err) {
            result = err;
        }
        await p_set_global();
        let found = await p_get_table(SCHEMA_1_NAME, SCHEMA_1_TABLE_1_NAME);
        assert.strictEqual(found.attributes.length, 5, 'Expected new attribute in table');
        assert.strictEqual(global.hdb_schema[SCHEMA_1_NAME][SCHEMA_1_TABLE_1_NAME].attributes.length, 5, 'Expected new attribute in global schema');
    });
    it('Nominal test for compareAttributeKeys, no new attributes', async () => {
        let test_message = test_utils.deepClone(global.hdb_schema);

        let result = undefined;
        try {
            result = await connector.compareAttributeKeys(test_message[SCHEMA_1_NAME][SCHEMA_1_TABLE_1_NAME], SCHEMA_1_NAME, SCHEMA_1_TABLE_1_NAME);
        } catch(err) {
            result = err;
        }
        const p_get_table = promisify(global_schema.getTableSchema);
        let found = await p_get_table(SCHEMA_1_NAME, SCHEMA_1_TABLE_1_NAME);
        assert.strictEqual(found.attributes.length, 3, 'Expected 2 new attributes in schema');
    });
    it('Test with bad schema, expect exception', async () => {
        let test_message = test_utils.deepClone(global.hdb_schema);
        let bad_schema = `badbad`;
        let result = undefined;
        try {
            result = await connector.compareAttributeKeys(test_message[bad_schema][SCHEMA_1_TABLE_1_NAME], SCHEMA_1_NAME, SCHEMA_1_TABLE_1_NAME);
        } catch(err) {
            result = err;
        }
        assert.strictEqual((result instanceof Error), true,'Expected new attribute in global schema');
    });
    it('Test with bad table, expect exception', async () => {
        let test_message = test_utils.deepClone(global.hdb_schema);
        let bad_table = `badbad`;
        let result = undefined;
        try {
            result = await connector.compareAttributeKeys(test_message[SCHEMA_1_NAME][bad_table], SCHEMA_1_NAME, SCHEMA_1_TABLE_1_NAME);
        } catch(err) {
            result = err;
        }
        assert.strictEqual((result instanceof Error), true,'Expected new attribute in global schema');
    });

    it('Test against new table with no attributes created yet, expect 1 attribute', async () => {

        let test_message = test_utils.deepClone(global.hdb_schema);
        let att_4 = 'att_4';
        test_message[SCHEMA_1_NAME][SCHEMA_1_TABLE_1_NAME].attributes.push({attribute: `${att_4}`});
        //reset attributes in a table (simulate newly created table) and test adding new attribute
        global.hdb_schema[SCHEMA_1_NAME][SCHEMA_1_TABLE_1_NAME].attributes = undefined;
        let result = undefined;
        try {
            result = await connector.compareAttributeKeys(test_message[SCHEMA_1_NAME][SCHEMA_1_TABLE_1_NAME], SCHEMA_1_NAME, SCHEMA_1_TABLE_1_NAME);
        } catch(err) {
            result = err;
        }
        await p_set_global();
        let found = await p_get_table(SCHEMA_1_NAME, SCHEMA_1_TABLE_1_NAME);
        assert.strictEqual(found.attributes.length, 4, 'Expected new attribute in table');
        assert.strictEqual(global.hdb_schema[SCHEMA_1_NAME][SCHEMA_1_TABLE_1_NAME].attributes.length, 4, 'Expected new attribute in global schema');
    });
});

describe('Test compareTableKeys with filesystem', () => {
    let connector = undefined;
    let SocketConnector_stub = undefined;
    let AddEventListener_stub = undefined;
    let sandbox = sinon.createSandbox();
    beforeEach(async () => {
        let dog_data = test_utils.deepClone(TEST_DATA_DOG);
        test_utils.createMockFS(ID_HASH_NAME, SCHEMA_1_NAME, SCHEMA_1_TABLE_1_NAME, dog_data);
        test_utils.createMockFS(ID_HASH_NAME, SCHEMA_1_NAME, SCHEMA_1_TABLE_2_NAME, dog_data);
        test_utils.createMockFS(ID_HASH_NAME, SCHEMA_2_NAME, SCHEMA_2_TABLE_1_NAME, dog_data);

        SocketConnector_stub = sandbox.stub(SocketConnector.prototype, `init`).resolves(``);
        AddEventListener_stub = sandbox.stub(HDBSocketConnector.prototype, 'addEventListener').resolves(``);
        connector = new HDBSocketConnector(null, null, null, null);

    });
    afterEach(async () => {
        test_utils.tearDownMockFS();
        test_utils.tearDownMockFSSystem();
        sandbox.restore();
    });

    after(async () => {
        test_utils.tearDownMockFS();
        test_utils.tearDownMockFSSystem();
    });

    it(`test compareTableKeys 1 new table.`, async () => {
        let test_message = test_utils.deepClone(global.hdb_schema);

        assert.strictEqual(global.hdb_schema[SCHEMA_1_NAME][SCHEMA_1_NEW_TABLE_NAME], undefined, 'Expected table does not exist');
        let result = undefined;
        try {
            result = await connector.compareTableKeys(test_message[SCHEMA_1_NAME], SCHEMA_1_NAME);
        } catch(err) {
            result = err;
        }

        // Need to force updating the global schema, otherwise we would have to wait for the signal to tell the master
        // to update.
        await p_set_global();
        let found_table = undefined;
        try {
            found_table = await p_get_table(SCHEMA_1_NAME, SCHEMA_1_NEW_TABLE_NAME);
        } catch(err) {
            found_table = err;
        }
        // get table returns an error string rather than an error :(
        assert.strictEqual(found_table , 'Invalid table', 'Expected exception');
        assert.strictEqual(global.hdb_schema[SCHEMA_1_NAME][SCHEMA_1_NEW_TABLE_NAME], undefined, 'Expected no new tables.');
    });

    it(`test compareTableKeys 1 new table.`, async () => {
        let test_message = test_utils.deepClone(global.hdb_schema);
        test_message[SCHEMA_1_NAME][SCHEMA_1_NEW_TABLE_NAME] = {
            "hash_attribute": `id`,
            "id": `${ID_HASH_NAME}`,
            "name": `${SCHEMA_1_NEW_TABLE_NAME}`,
            "schema": `${SCHEMA_1_NAME}`,
            "attributes": [
                {
                    "attribute": "att_1"
                },
                {
                    "attribute": "att_2"
                }
            ]
        };
        test_message[SCHEMA_1_NAME][SCHEMA_1_OTHER_NEW_TABLE_NAME] = {
            "hash_attribute": `id`,
            "id": `${ID_HASH_NAME}`,
            "name": `${SCHEMA_1_OTHER_NEW_TABLE_NAME}`,
            "schema": `${SCHEMA_1_NAME}`,
            "attributes": [
                {
                    "attribute": "att_1"
                },
                {
                    "attribute": "att_2"
                }
            ]
        };
        assert.strictEqual(global.hdb_schema[SCHEMA_1_NAME][SCHEMA_1_NEW_TABLE_NAME], undefined, 'Expected table does not exist');
        let result = undefined;
        try {
            result = await connector.compareTableKeys(test_message[SCHEMA_1_NAME], SCHEMA_1_NAME);
        } catch(err) {
            result = err;
        }
        assert.strictEqual(result, undefined, 'Got unexpected exception');
        // Need to force updating the global schema, otherwise we would have to wait for the signal to tell the master
        // to update.
        await p_set_global();
        let found_table = undefined;
        let other_found_table = undefined;
        try {
            found_table = await p_get_table(SCHEMA_1_NAME, SCHEMA_1_NEW_TABLE_NAME);
            other_found_table = await p_get_table(SCHEMA_1_NAME, SCHEMA_1_OTHER_NEW_TABLE_NAME);
        } catch(err) {
            found_table = err;
        }
        // get table returns an error string rather than an error :(
        assert.notStrictEqual(found_table,undefined,'Expected table to be found');
        assert.strictEqual(found_table.attributes.length,2,'Expected 2 attributes in table');
        assert.notStrictEqual(other_found_table,undefined,'Expected table to be found');
        assert.strictEqual(other_found_table.attributes.length,2,'Expected 2 attributes in table');
        assert.notStrictEqual(global.hdb_schema[SCHEMA_1_NAME][SCHEMA_1_NEW_TABLE_NAME], undefined, 'Expected new table to be created.');
        assert.notStrictEqual(global.hdb_schema[SCHEMA_1_NAME][SCHEMA_1_OTHER_NEW_TABLE_NAME], undefined, 'Expected new table to be created.');
    });

    it(`test compareTableKeys 2 new tables.`, async () => {
        let test_message = test_utils.deepClone(global.hdb_schema);
        test_message[SCHEMA_1_NAME][SCHEMA_1_NEW_TABLE_NAME] = {
            "hash_attribute": `id`,
            "id": `${ID_HASH_NAME}`,
            "name": `${SCHEMA_1_NEW_TABLE_NAME}`,
            "schema": `${SCHEMA_1_NAME}`,
            "attributes": [
                {
                    "attribute": "att_1"
                },
                {
                    "attribute": "att_2"
                }
            ]
        };
        assert.strictEqual(global.hdb_schema[SCHEMA_1_NAME][SCHEMA_1_NEW_TABLE_NAME], undefined, 'Expected table does not exist');
        let result = undefined;
        try {
            result = await connector.compareTableKeys(test_message[SCHEMA_1_NAME], SCHEMA_1_NAME);
        } catch(err) {
            result = err;
        }
        assert.strictEqual(result, undefined, 'Got unexpected exception');
        // Need to force updating the global schema, otherwise we would have to wait for the signal to tell the master
        // to update.
        await p_set_global();
        let found_table = undefined;
        try {
            found_table = await p_get_table(SCHEMA_1_NAME, SCHEMA_1_NEW_TABLE_NAME);
        } catch(err) {
            found_table = err;
        }
        // get table returns an error string rather than an error :(
        assert.notStrictEqual(found_table,undefined,'Expected table to be found');
        assert.strictEqual(found_table.attributes.length,2,'Expected 2 attributes in table');
        assert.notStrictEqual(global.hdb_schema[SCHEMA_1_NAME][SCHEMA_1_NEW_TABLE_NAME], undefined, 'Expected new table to be created.');
    });
    it(`test compareTableKeys bad parameter, expect exception`, async () => {
        let test_message = test_utils.deepClone(global.hdb_schema);
        let result = undefined;
        try {
            result = await connector.compareTableKeys(null, SCHEMA_1_NAME);
        } catch(err) {
            result = err;
        }
        assert.strictEqual((result instanceof Error), true, 'Expected exception');
    });
    it(`test compareTableKeys bad 2nd parameter, expect exception`, async () => {
        let test_message = test_utils.deepClone(global.hdb_schema);
        let result = undefined;
        try {
            result = await connector.compareTableKeys(test_message[SCHEMA_1_NAME], null);
        } catch(err) {
            result = err;
        }
        assert.strictEqual((result instanceof Error), true, 'Expected exception');
    });
    it(`test compareTableKeys bad 2nd parameter, expect exception`, async () => {
        let test_message = test_utils.deepClone(global.hdb_schema);
        let result = undefined;
        try {
            result = await connector.compareTableKeys(test_message[SCHEMA_1_NAME], null);
        } catch(err) {
            result = err;
        }
        assert.strictEqual((result instanceof Error), true, 'Expected exception');
    });
});

describe('test generateOperationFunctionCall', () => {
    let connector = undefined;
    let SocketConnector_stub = undefined;
    let AddEventListener_stub = undefined;
    let sandbox = sinon.createSandbox();
    beforeEach(async () => {
        let dog_data = test_utils.deepClone(TEST_DATA_DOG);
        test_utils.createMockFS(ID_HASH_NAME, SCHEMA_1_NAME, SCHEMA_1_TABLE_1_NAME, dog_data);
        test_utils.createMockFS(ID_HASH_NAME, SCHEMA_1_NAME, SCHEMA_1_TABLE_2_NAME, dog_data);
        test_utils.createMockFS(ID_HASH_NAME, SCHEMA_2_NAME, SCHEMA_2_TABLE_1_NAME, dog_data);

        SocketConnector_stub = sandbox.stub(SocketConnector.prototype, `init`).resolves(``);
        AddEventListener_stub = sandbox.stub(HDBSocketConnector.prototype, 'addEventListener').resolves(``);
        connector = new HDBSocketConnector(null, null, null, null);

    });
    afterEach(async () => {
        test_utils.tearDownMockFS();
        test_utils.tearDownMockFSSystem();
        sandbox.restore();
    });

    after(async () => {
        test_utils.tearDownMockFS();
        test_utils.tearDownMockFSSystem();
    });

   it('nominal case with schema', () => {
       let schema_name = 'zaphod';
       let schema_msg = {
         schema: `${schema_name}`
       };
       let result = connector.generateOperationFunctionCall(ENTITY_TYPE_ENUM.SCHEMA, schema_msg, schema_name, null);
       assert.strictEqual(result.operation, terms.OPERATIONS_ENUM.CREATE_SCHEMA, 'Expected create schema message to be created');
   });

    it('nominal case with table', () => {
        let schema_name = 'zaphod';
        let table_name = 'beeblebrox';
        let table_msg = {
            schema: `${schema_name}`,
            table: `${table_name}`,
            hash_attribute: `${ID_HASH_NAME}`
        };
        let result = connector.generateOperationFunctionCall(ENTITY_TYPE_ENUM.TABLE, table_msg, schema_name, table_name);
        assert.strictEqual(result.operation, terms.OPERATIONS_ENUM.CREATE_TABLE, 'Expected create table message to be created');
        assert.strictEqual(result.table, table_name, 'Expected create table message to be created');
        assert.strictEqual(result.hash_attribute, ID_HASH_NAME, 'Expected create table message to be created');
    });

    it('nominal case with attribute', () => {
        let schema_name = 'zaphod';
        let table_name = 'beetlebrox';
        let att_name = 'new_attribute';
        let table_msg = {
            schema: `${schema_name}`,
            table: `${table_name}`,
            attribute: `${att_name}`
        };
        let result = connector.generateOperationFunctionCall(ENTITY_TYPE_ENUM.ATTRIBUTE, table_msg, schema_name, table_name);
        assert.strictEqual(result.operation, terms.OPERATIONS_ENUM.CREATE_ATTRIBUTE, 'Expected create table message to be created');
        assert.strictEqual(result.table, table_name, 'Expected create table message to be created');
        assert.strictEqual(result.attribute, att_name, 'Expected create table message to be created');
    });
});