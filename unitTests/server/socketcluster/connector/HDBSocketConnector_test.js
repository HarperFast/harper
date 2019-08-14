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

const SCHEMA_3_NAME = 'schema_3';

function setupGlobalSchema() {
    test_utils.setGlobalSchema(ID_HASH_NAME, SCHEMA_1_NAME, SCHEMA_1_TABLE_1_NAME, SCHEMA_1_TABLE_1_ID, [SCHEMA_1_TABLE_1_ATT_1_NAME, SCHEMA_1_TABLE_1_ATT_2_NAME]);
    test_utils.setGlobalSchema(ID_HASH_NAME, SCHEMA_1_NAME, SCHEMA_1_TABLE_2_NAME, SCHEMA_1_TABLE_2_ID, [SCHEMA_1_TABLE_2_ATT_1_NAME, SCHEMA_1_TABLE_2_ATT_2_NAME]);

    test_utils.setGlobalSchema(ID_HASH_NAME, SCHEMA_2_NAME, SCHEMA_2_TABLE_1_NAME, SCHEMA_2_TABLE_1_ID, [SCHEMA_2_TABLE_1_ATT_1_NAME, SCHEMA_2_TABLE_1_ATT_2_NAME]);

    // Manually set an empty schema
    global.hdb_schema[SCHEMA_3_NAME] = {};
}

function resetGlobalSchema() {
    global.hdb_schema = {};
}

/**
 * This function should be used in the getOperationFunction stub.
 * @param msg
 * @param callback
 * @returns {{operation_function: (function(*=, *): *)}|{operation_function: operation_function}}
 */
function getOperationFunctionStub(msg, callback) {
    switch(msg.operation) {
        case terms.OPERATIONS_ENUM.CREATE_SCHEMA:
            return {operation_function: (msg, callback) => {
                    if(!global.hdb_schema[msg.schema]) {
                        global.hdb_schema[msg.schema] = {};
                        return callback(null, null);
                    }
                }};
        case terms.OPERATIONS_ENUM.CREATE_TABLE:
            return {operation_function: (msg, callback) => {
                    if(!global.hdb_schema[msg.schema]) {
                        global.hdb_schema[msg.schema] = {};
                    }
                    if(!global.hdb_schema[msg.schema][msg.table]) {
                        global.hdb_schema[msg.schema][msg.table] = {};
                        return callback(null, null);
                    }
                }};
        case terms.OPERATIONS_ENUM.CREATE_ATTRIBUTE:
            return {operation_function: (msg, callback) => {
                    global.hdb_schema[msg.schema][msg.table].attributes.push(msg);
                    return callback(null, null);
                }};
    }
}

/**
 * Since we import getOperationFunction in a unique way inside of HDBSocketConnector, we are overrid
 * @param msg
 * @returns {undefined}
 */
function get_operation_override(msg) {
    let found_operation = undefined;

    return found_operation;
}

describe('Test compareSchemas', () => {
    //Stub out connection related configuration.
    let sandbox = sinon.createSandbox();
    let SocketConnector_stub = undefined;
    let AddEventListener_stub = undefined;
    let get_operation_stub = undefined;

    let connector = undefined;
    let set_schema_to_global_stub = undefined;

    beforeEach(async () => {
       setupGlobalSchema();
        SocketConnector_stub = sandbox.stub(SocketConnector.prototype, `init`).resolves(``);
        AddEventListener_stub = sandbox.stub(HDBSocketConnector.prototype, 'addEventListener').resolves(``);
        connector = new HDBSocketConnector(null, null, null, null);
       get_operation_stub = sandbox.stub(server_utils, `getOperationFunction`).callsFake((msg) => {
           switch(msg.operation) {
               case terms.OPERATIONS_ENUM.CREATE_SCHEMA:
                   return {operation_function: (msg, callback) => {
                       if(!global.hdb_schema[msg.schema]) {
                           global.hdb_schema[msg.schema] = {};
                           return callback(null, null);
                       }
                   }};
               case terms.OPERATIONS_ENUM.CREATE_TABLE:
                   return {operation_function: (msg, callback) => {
                       if(!global.hdb_schema[msg.schema]) {
                           global.hdb_schema[msg.schema] = {};
                       }
                       if(!global.hdb_schema[msg.schema][msg.table]) {
                           global.hdb_schema[msg.schema][msg.table] = {};
                           return callback(null, null);
                       }
                   }};
               case terms.OPERATIONS_ENUM.CREATE_ATTRIBUTE:
                   return {operation_function: (msg, callback) => {
                       global.hdb_schema[msg.schema][msg.table].attributes.push(msg);
                       return callback(null, null);
                   }};
           }
       });
    });
    afterEach(async () => {
       resetGlobalSchema();
    });
   it('Nominal case', async () => {
       let schem = 'new_schema3';
       let table = 'new_table';
       let att_1 = 'att_1';
       let att_2 = 'att_2';
       let test_message = test_utils.deepClone(global.hdb_schema);
       test_message[schem] = {};
       test_message[schem][table] = { hash_attribute: 'hash', name: `${table}`, id: 'id' };
       test_message[schem][table].attributes = [];
       test_message[schem][table].attributes.push({attribute: `${att_1}`});
       test_message[schem][table].attributes.push({attribute: `${att_2}`});
       assert.notStrictEqual(global.hdb_schema, undefined);
       let result = undefined;
        try {
            result = await connector.compareSchemas(test_message);
        } catch(err) {
            result = err;
        }
        assert.notStrictEqual(global.hdb_schema[schem], undefined, 'Expected new schema to exist in global.');
   });
});

describe('Test compareAttributeKeys', () => {
    let sandbox = sinon.createSandbox();
    let SocketConnector_stub = undefined;
    let AddEventListener_stub = undefined;
    let get_operation_stub = undefined;

    let connector = undefined;
    let set_schema_to_global_stub = undefined;

    beforeEach(async () => {
        setupGlobalSchema();
        SocketConnector_stub = sandbox.stub(SocketConnector.prototype, `init`).resolves(``);
        AddEventListener_stub = sandbox.stub(HDBSocketConnector.prototype, 'addEventListener').resolves(``);
        connector = new HDBSocketConnector(null, null, null, null);
        get_operation_stub = sandbox.stub(server_utils, `getOperationFunction`).callsFake((msg) => {
            switch(msg.operation) {
                case terms.OPERATIONS_ENUM.CREATE_SCHEMA:
                    return {operation_function: (msg, callback) => {
                            if(!global.hdb_schema[msg.schema]) {
                                global.hdb_schema[msg.schema] = {};
                                return callback(null, null);
                            }
                        }};
                case terms.OPERATIONS_ENUM.CREATE_TABLE:
                    return {operation_function: (msg, callback) => {
                            if(!global.hdb_schema[msg.schema]) {
                                global.hdb_schema[msg.schema] = {};
                            }
                            if(!global.hdb_schema[msg.schema][msg.table]) {
                                global.hdb_schema[msg.schema][msg.table] = {};
                                return callback(null, null);
                            }
                        }};
                case terms.OPERATIONS_ENUM.CREATE_ATTRIBUTE:
                    return {operation_function: (msg, callback) => {
                            global.hdb_schema[msg.schema][msg.table].attributes.push({attribute: msg.attribute});
                            return callback(null, null);
                        }};
            }
        });
    });
    afterEach(async () => {
        resetGlobalSchema();
    });

    it('Nominal test for compareAttributeKeys, no new attributes', async () => {
        let test_message = test_utils.deepClone(global.hdb_schema);

        let result = undefined;
        try {
            result = await connector.compareAttributeKeys(test_message[SCHEMA_1_NAME][SCHEMA_1_TABLE_1_NAME], SCHEMA_1_NAME, SCHEMA_1_TABLE_1_NAME);
        } catch(err) {
            result = err;
        }
        assert.strictEqual(global.hdb_schema[SCHEMA_1_NAME][SCHEMA_1_TABLE_1_NAME].attributes.length, 2, 'Expected new attribute in global schema');
    });
    it('Nominal test for compareAttributeKeys, 1 new attribute', async () => {
        let att_3 = 'att_3';
        let test_message = test_utils.deepClone(global.hdb_schema);
        test_message[SCHEMA_1_NAME][SCHEMA_1_TABLE_1_NAME].attributes.push({attribute: `${att_3}`});

        let result = undefined;
        try {
            result = await connector.compareAttributeKeys(test_message[SCHEMA_1_NAME][SCHEMA_1_TABLE_1_NAME], SCHEMA_1_NAME, SCHEMA_1_TABLE_1_NAME);
        } catch(err) {
            result = err;
        }
        assert.strictEqual(global.hdb_schema[SCHEMA_1_NAME][SCHEMA_1_TABLE_1_NAME].attributes.length, 3, 'Expected new attribute in global schema');
    });
    it('Nominal test for compareAttributeKeys, 2 new attributes', async () => {
        let att_3 = 'att_3';
        let att_4 = 'att_4';
        let test_message = test_utils.deepClone(global.hdb_schema);
        test_message[SCHEMA_1_NAME][SCHEMA_1_TABLE_1_NAME].attributes.push({attribute: `${att_3}`});
        test_message[SCHEMA_1_NAME][SCHEMA_1_TABLE_1_NAME].attributes.push({attribute: `${att_4}`});

        let result = undefined;
        try {
            result = await connector.compareAttributeKeys(test_message[SCHEMA_1_NAME][SCHEMA_1_TABLE_1_NAME], SCHEMA_1_NAME, SCHEMA_1_TABLE_1_NAME);
        } catch(err) {
            result = err;
        }
        assert.strictEqual(global.hdb_schema[SCHEMA_1_NAME][SCHEMA_1_TABLE_1_NAME].attributes.length, 4, 'Expected new attribute in global schema');
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
        //reset attributes in a table (simulate newly created table) and test adding new attribute
        global.hdb_schema[SCHEMA_1_NAME][SCHEMA_1_TABLE_1_NAME].attributes = [];
        let test_message = test_utils.deepClone(global.hdb_schema);
        test_message[SCHEMA_1_NAME][SCHEMA_1_TABLE_1_NAME].attributes.push({attribute: `${SCHEMA_1_TABLE_1_ATT_1_NAME}`});
        let result = undefined;
        try {
            result = await connector.compareAttributeKeys(null, SCHEMA_1_NAME, SCHEMA_1_TABLE_1_NAME);
        } catch(err) {
            result = err;
        }
        assert.strictEqual((result instanceof Error), true,'Expected new attribute in global schema');
    });
});

describe('Test compareAttributeKeys with filesystem', () => {
    let sandbox = sinon.createSandbox();
    let SocketConnector_stub = undefined;
    let AddEventListener_stub = undefined;

    let connector = undefined;

    beforeEach(async () => {
        //setupGlobalSchema();
        let dog_data = test_utils.deepClone(TEST_DATA_DOG);
        test_utils.createMockFS(ID_HASH_NAME, SCHEMA_1_NAME, SCHEMA_1_TABLE_1_NAME, dog_data);
        test_utils.createMockFS(ID_HASH_NAME, SCHEMA_1_NAME, SCHEMA_1_TABLE_2_NAME, dog_data);
        test_utils.createMockFS(ID_HASH_NAME, SCHEMA_2_NAME, SCHEMA_2_TABLE_1_NAME, dog_data);
        SocketConnector_stub = sandbox.stub(SocketConnector.prototype, `init`).resolves(``);
        AddEventListener_stub = sandbox.stub(HDBSocketConnector.prototype, 'addEventListener').resolves(``);
        connector = new HDBSocketConnector(null, null, null, null);

    });
    afterEach(async () => {
        //resetGlobalSchema();
        test_utils.tearDownMockFS();
    });

    after(async () => {
        test_utils.tearDownMockFS();
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
        assert.strictEqual(global.hdb_schema[SCHEMA_1_NAME][SCHEMA_1_TABLE_1_NAME].attributes.length, 4, 'Expected new attribute in global schema');
    });
});