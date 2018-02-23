"use strict"
/**
 * Test the sql_statement_bucket module.
 */

const assert = require('assert');
const rewire = require('rewire');
const alasql = require('alasql');
const sql_statement_bucket = require('../../sqlTranslator/sql_statement_bucket');
const sql_statement_rewire = rewire('../../sqlTranslator/sql_statement_bucket');

//DELETE
let TEST_DELETE_JSON = {
    "table": {
        "databaseid": "dev",
        "tableid": "dog"
    },
    "where": {
        "left": {
            "left": {
                "columnid": "id"
            },
            "op": "=",
            "right": {
                "value": 1
            }
        },
        "op": "AND",
        "right": {
            "left": {
                "columnid": "name"
            },
            "op": "=",
            "right": {
                "value": "abc"
            }
        }
    }
};
let TEST_DELETE = new alasql.yy.Delete(TEST_DELETE_JSON);

let TEST_INSERT_JSON = {
    "into": {
        "databaseid": "dev",
        "tableid": "dog"
    },
    "columns": [
        {
            "columnid": "id"
        },
        {
            "columnid": "name"
        }
    ],
    "values": [
        [
            {
                "value": 22
            },
            {
                "value": "Simon"
            }
        ]
    ]
};

let TEST_INSERT = new alasql.yy.Insert(TEST_INSERT_JSON);

let TEST_UPDATE_JSON = {
    "table": {
        "databaseid": "dev",
        "tableid": "dog"
    },
    "columns": [
        {
            "column": {
                "columnid": "name"
            },
            "expression": {
                "value": "penelope"
            }
        }
    ],
    "where": {
        "left": {
            "columnid": "id"
        },
        "op": "=",
        "right": {
            "value": 1
        }
    }
};

let TEST_UPDATE = new alasql.yy.Update(TEST_UPDATE_JSON);

let TEST_SELECT_JSON = {
    "columns": [
        {
            "columnid": "*"
        }
    ],
    "from": [
        {
            "databaseid": "dev",
            "tableid": "dog"
        }
    ],
    "where": {
        "expression": {
            "left": {
                "columnid": "id"
            },
            "op": "=",
            "right": {
                "value": 1
            }
        }
    }
};

let TEST_SELECT = new alasql.yy.Select(TEST_SELECT_JSON);

let SCHEMA_NAME = 'dev';
let TABLE_NAME = 'dog';

/*
    This is a simple, naive clone implementation.  It should never, ever! be used in prod.
 */
function clone(a) {
    return JSON.parse(JSON.stringify(a));
}

describe(`Test getDeleteAttributes`, function () {
    it('Nominal, pull attributes in delete statement', function () {
        let getDeleteAttributes = sql_statement_rewire.__get__('getDeleteAttributes');
        //let statement = new sql_statement_bucket(TEST_DELETE);
        let statement = new Map();
        let table_lookup = new Map();
        getDeleteAttributes(TEST_DELETE, statement, table_lookup);
        assert.equal(statement.get(SCHEMA_NAME).get(TABLE_NAME).length, 2);
        assert.equal(Array.from(statement.get(SCHEMA_NAME).keys()).length, 1);
        assert.equal(Array.from(statement.keys()).length, 1);
    });
    it('Pull attributes from delete statement with no where clause', function () {
        let getDeleteAttributes = sql_statement_rewire.__get__('getDeleteAttributes');
        let copy = clone(TEST_DELETE_JSON);
        copy.where = {};
        let temp_delete = new alasql.yy.Delete(copy);
        let statement = new Map();
        let table_lookup = new Map();
        getDeleteAttributes(temp_delete, statement, table_lookup);
        assert.equal(statement.get(SCHEMA_NAME).get(TABLE_NAME).length, 0);
        assert.equal(Array.from(statement.get(SCHEMA_NAME).keys()).length, 1);
        assert.equal(Array.from(statement.keys()).length, 1);
    });
    it('Pull attributes from delete statement with no table clause', function () {
        let getDeleteAttributes = sql_statement_rewire.__get__('getDeleteAttributes');
        let copy = clone(TEST_DELETE_JSON);
        copy.table = {};
        let temp_delete = new alasql.yy.Delete(copy);
        let statement = new Map();
        let table_lookup = new Map();
        getDeleteAttributes(temp_delete, statement, table_lookup);
        // No table was defined, so the returned value should be empty
        assert.equal(statement.get(SCHEMA_NAME), undefined);
    });
});

describe(`Test getInsertAttributes`, function () {
    it('Nominal, pull attributes in Insert statement', function () {
        let getInsertAttributes = sql_statement_rewire.__get__('getInsertAttributes');
        //let statement = new sql_statement_bucket(TEST_DELETE);
        let statement = new Map();
        let table_lookup = new Map();
        getInsertAttributes(TEST_INSERT, statement, table_lookup);
        assert.equal(statement.get(SCHEMA_NAME).get(TABLE_NAME).length, 2);
        assert.equal(Array.from(statement.get(SCHEMA_NAME).keys()).length, 1);
        assert.equal(Array.from(statement.keys()).length, 1);
    });
    it('Pull attributes from insert statement with no table clause', function () {
        let getInsertAttributes = sql_statement_rewire.__get__('getInsertAttributes');
        let copy = clone(TEST_DELETE_JSON);
        copy.into = {};
        let temp_delete = new alasql.yy.Insert(copy);
        let statement = new Map();
        let table_lookup = new Map();
        getInsertAttributes(temp_delete, statement, table_lookup);
        // No into was defined, so the returned value should be empty
        assert.equal(statement.get(SCHEMA_NAME), undefined);
    });
});

describe(`Test getUpdateAttributes`, function () {
    it('Nominal, pull attributes in update statement', function () {
        let getUpdateAttributes = sql_statement_rewire.__get__('getUpdateAttributes');
        let statement = new Map();
        let table_lookup = new Map();
        getUpdateAttributes(TEST_UPDATE, statement, table_lookup);
        assert.equal(statement.get(SCHEMA_NAME).get(TABLE_NAME).length, 1);
        assert.equal(Array.from(statement.get(SCHEMA_NAME).keys()).length, 1);
        assert.equal(Array.from(statement.keys()).length, 1);
    });
    it('Pull attributes from update statement with no table clause', function () {
        let getUpdateAttributes = sql_statement_rewire.__get__('getUpdateAttributes');
        let copy = clone(TEST_UPDATE_JSON);
        copy.table = {};
        let temp_update = new alasql.yy.Update(copy);
        let statement = new Map();
        let table_lookup = new Map();
        getUpdateAttributes(temp_update, statement, table_lookup);
        // No table was defined, so the returned value should be empty
        assert.equal(statement.get(SCHEMA_NAME), undefined);
    });
});

describe(`Test getSelectAttributes`, function () {
    it('Nominal, pull attributes in Select statement', function () {
        let getSelectAttributes = sql_statement_rewire.__get__('getSelectAttributes');
        let statement = new Map();
        let table_lookup = new Map();
        getSelectAttributes(TEST_SELECT, statement, table_lookup);
        assert.equal(statement.get(SCHEMA_NAME).get(TABLE_NAME).length, 1);
        assert.equal(Array.from(statement.get(SCHEMA_NAME).keys()).length, 1);
        assert.equal(Array.from(statement.keys()).length, 1);
    });
    it('Pull attributes from insert statement with no table clause', function () {
        let getSelectAttributes = sql_statement_rewire.__get__('getSelectAttributes');
        let copy = clone(TEST_UPDATE_JSON);
        copy.from = {};
        let temp_update = new alasql.yy.Select(copy);
        let statement = new Map();
        let table_lookup = new Map();
        getSelectAttributes(temp_update, statement, table_lookup);
        // No table was defined, so the returned value should be empty
        assert.equal(statement.get(SCHEMA_NAME), undefined);
    });
});