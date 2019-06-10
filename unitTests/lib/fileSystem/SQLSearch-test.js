'use strict';

const test_utils = require('../../test_utils');
// try to move to /bin directory so our properties reader doesn't explode.
test_utils.preTestPrep();
const {
    createMockFS,
    deepClone,
    getMockFSPath,
    mochaAsyncWrapper,
    tearDownMockFS
} = test_utils;

const chai = require('chai');
const { expect } = chai;
const sinon = require('sinon');

const alasql = require('alasql');
const rewire = require('rewire');
const FileSearch = rewire('../../../lib/fileSystem/SQLSearch');

const TEST_FS_DIR = getMockFSPath();
const TEST_SCHEMA = 'test';
const HASH_ATTRIBUTE = 'id';
const TEST_TABLE_CAT = 'cat';
const TEST_TABLE_DOG = 'dog';
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
const TEST_DATA_CAT = [
    {
        "age": 5,
        "id": 1,
        "name": "Sam"
    },
    {
        "age": 4,
        "id": 2,
        "name": "David"
    }
];
const TEST_STATEMENT_DOG = {
    "columns": [
        {
            "columnid": "*"
        },
        {
            "columnid": "breed",
            "tableid": "dog"
        },
        {
            "columnid": "name",
            "tableid": "dog"
        },
        {
            "columnid": "id",
            "tableid": "dog"
        },
        {
            "columnid": "age",
            "tableid": "dog"
        }
    ],
    "from": [
        {
            "databaseid": "test",
            "tableid": "dog"
        }
    ]
};
const TEST_ATTRIBUTES_DOG = [
    {
        "attribute": "breed",
        "table": {
            "databaseid": "test",
            "tableid": "dog"
        }
    },
    {
        "attribute": "name",
        "table": {
            "databaseid": "test",
            "tableid": "dog"
        }
    },
    {
        "attribute": "id",
        "table": {
            "databaseid": "test",
            "tableid": "dog"
        }
    },
    {
        "attribute": "age",
        "table": {
            "databaseid": "test",
            "tableid": "dog"
        }
    }
];
const TEST_WHERE_COL = { "columnid": "id", "tableid": "dog" };
const TEST_WHERE_COL_VAL = (val) => ({"value": val});

let test_instance;

let sandbox;
let search_spy;
let _getColumns_spy;
let _getTables_spy;
let _conditionsToFetchAttributeValues_spy;
let _backtickAllSchemaItems_spy;
let _checkEmptySQL_spy;
let _findColumn_spy;
let _addFetchColumns_spy;
let _getFetchAttributeValues_spy;
let _checkHashValueExists_spy;
let _retrieveIds_spy;
let _readBlobFilesForSetup_spy;
let _consolidateData_spy;
let _processJoins_spy;
let _decideReadPattern_spy;
let _readRawFiles_spy;
let _readAttributeFilesByIds_spy;
let _readAttributeValues_spy;
let _readBlobFiles_spy;
let _finalSQL_spy;
let _buildSQL_spy;
let _stripFileExtension_spy;


function setupData() {
    const test_data_dog = deepClone(TEST_DATA_DOG);
    const test_data_cat = deepClone(TEST_DATA_CAT);

    createMockFS(HASH_ATTRIBUTE, TEST_SCHEMA, TEST_TABLE_DOG, test_data_dog);
    createMockFS(HASH_ATTRIBUTE, TEST_SCHEMA, TEST_TABLE_CAT, test_data_cat);
}

function setClassMethodSpies() {
    sandbox = sinon.createSandbox();
    const getHdbBasePath_stub = function() {
        return `${TEST_FS_DIR}`;
    };
    FileSearch.__set__('base_path', getHdbBasePath_stub)
    search_spy = sandbox.spy(FileSearch.prototype, 'search');
    _getColumns_spy = sandbox.spy(FileSearch.prototype, '_getColumns');
    _getTables_spy = sandbox.spy(FileSearch.prototype, '_getTables');
    _conditionsToFetchAttributeValues_spy = sandbox.spy(FileSearch.prototype, '_conditionsToFetchAttributeValues');
    _backtickAllSchemaItems_spy = sandbox.spy(FileSearch.prototype, '_backtickAllSchemaItems');
    _checkEmptySQL_spy = sandbox.spy(FileSearch.prototype, '_checkEmptySQL');
    _findColumn_spy = sandbox.spy(FileSearch.prototype, '_findColumn');
    _addFetchColumns_spy = sandbox.spy(FileSearch.prototype, '_addFetchColumns');
    _getFetchAttributeValues_spy = sandbox.spy(FileSearch.prototype, '_getFetchAttributeValues');
    _checkHashValueExists_spy = sandbox.spy(FileSearch.prototype, '_checkHashValueExists');
    _retrieveIds_spy = sandbox.spy(FileSearch.prototype, '_retrieveIds');
    _readBlobFilesForSetup_spy = sandbox.spy(FileSearch.prototype, '_readBlobFilesForSetup');
    _consolidateData_spy = sandbox.spy(FileSearch.prototype, '_consolidateData');
    _processJoins_spy = sandbox.spy(FileSearch.prototype, '_processJoins');
    _decideReadPattern_spy = sandbox.spy(FileSearch.prototype, '_decideReadPattern');
    _readRawFiles_spy = sandbox.spy(FileSearch.prototype, '_readRawFiles');
    _readAttributeFilesByIds_spy = sandbox.spy(FileSearch.prototype, '_readAttributeFilesByIds');
    _readAttributeValues_spy = sandbox.spy(FileSearch.prototype, '_readAttributeValues');
    _readBlobFiles_spy = sandbox.spy(FileSearch.prototype, '_readBlobFiles');
    _finalSQL_spy = sandbox.spy(FileSearch.prototype, '_finalSQL');
    _buildSQL_spy = sandbox.spy(FileSearch.prototype, '_buildSQL');
    _stripFileExtension_spy = sandbox.spy(FileSearch.prototype, '_stripFileExtension');
}

function mockAttrsStmt(attrs) {
    const attrs_clone = deepClone(attrs);
    return attrs_clone.map(attr => {
        attr.table = new alasql.yy.Table(attr.table);
        return attr;
    });
}

function mockColumnAndFromStmt(stmt) {
    const stmt_clone = deepClone(stmt);
    const final_stmt = new alasql.yy.Select();
    final_stmt.columns = stmt_clone.columns.map(col => new alasql.yy.Column(col));
    final_stmt.from = stmt_clone.from.map(from => new alasql.yy.Table(from));

    return final_stmt;
}

function mockWhereStmt(left, op, right) {
    let fromStmt = new alasql.yy.Expression();
    fromStmt.expression = new alasql.yy.Op();
    fromStmt.expression.left = new alasql.yy.Column(left);
    fromStmt.expression.op = op;
    fromStmt.expression.right = new alasql.yy.NumValue(right);
    return fromStmt;
}

function setupTestInstance(statement, attributes) {
    const test_statement = statement ? statement : mockColumnAndFromStmt(TEST_STATEMENT_DOG);
    const test_attributes = attributes ? mockAttrsStmt(attributes) : mockAttrsStmt(TEST_ATTRIBUTES_DOG);
    test_instance = new FileSearch(test_statement, test_attributes);
}

function sortTestResults(test_results) {
    const sorted_arr = test_results.sort((a, b) => a.id - b.id);
    const sorted_results = [];
    sorted_arr.forEach(result => {
        const sorted_result = {}
        const sort_keys = Object.keys(result).sort();
        sort_keys.forEach(key => {
            sorted_result[key] = result[key];
        });
        sorted_results.push(sorted_result);
    });
    return sorted_results;
}

describe('Test FileSystem class', () => {
    before(() => {
        tearDownMockFS();
        setupData();
        setClassMethodSpies();
    });

    afterEach(() => {
        test_instance = null;
        sandbox.resetHistory();
    })

    after(() => {
        tearDownMockFS();
        sandbox.restore();
        rewire('../../../lib/fileSystem/SQLSearch');
    });

    describe('constructor()', () => {
        it('should call four class methods when instantiated', () => {
            setupTestInstance();
            expect(_getColumns_spy.calledOnce).to.be.true;
            expect(_getTables_spy.calledOnce).to.be.true;
            expect(_conditionsToFetchAttributeValues_spy.calledOnce).to.be.true;
            expect(_backtickAllSchemaItems_spy.calledOnce).to.be.true;
        });

        it('should throw an exception if no statement argument is provided', () => {
            let err;
            try {
                new FileSearch(null, TEST_ATTRIBUTES_DOG);
            } catch(e) {
                err = e;
            }
            expect(err).to.equal('statement cannot be null');
        });
    });
    describe('search()', () => {
        it('should return all rows when there is no WHERE clause', mochaAsyncWrapper(async () => {
            let search_results;

            setupTestInstance();
            try {
                search_results = await test_instance.search();
            } catch(e) {
                console.log(e);
            }

            const sorted_results = sortTestResults(search_results);
            expect(sorted_results).to.deep.equal(TEST_DATA_DOG);
        }));

        it('should return matching row based on WHERE clause', mochaAsyncWrapper(async() => {
            let search_results;
            const test_row = TEST_DATA_DOG[2];
            const test_sql_statement = mockColumnAndFromStmt(TEST_STATEMENT_DOG);
            test_sql_statement.where = mockWhereStmt(TEST_WHERE_COL, '=', TEST_WHERE_COL_VAL(test_row.id));

            setupTestInstance(test_sql_statement);
            try {
                search_results = await test_instance.search();
            } catch(e) {
                console.log(e);
            }

            const sorted_results = sortTestResults(search_results);
            expect(sorted_results[0]).to.deep.equal(test_row);
        }));

        it('should return matching rows based on WHERE clause', mochaAsyncWrapper(async() => {
            let search_results;
            const test_rows = [TEST_DATA_DOG[0], TEST_DATA_DOG[1], TEST_DATA_DOG[2]];
            const test_sql_statement = mockColumnAndFromStmt(TEST_STATEMENT_DOG);
            test_sql_statement.where = mockWhereStmt(TEST_WHERE_COL, '<=', TEST_WHERE_COL_VAL(TEST_DATA_DOG[2].id));

            setupTestInstance(test_sql_statement);
            try {
                search_results = await test_instance.search();
            } catch(e) {
                console.log(e);
            }

            const sorted_results = sortTestResults(search_results);
            expect(sorted_results).to.deep.equal(test_rows);
        }));

        it('should return [] if no rows meet WHERE clause', mochaAsyncWrapper(async() => {
            let search_results;
            const test_incorrect_id = TEST_DATA_DOG.length + 1;
            const test_sql_statement = mockColumnAndFromStmt(TEST_STATEMENT_DOG);
            test_sql_statement.where = mockWhereStmt(TEST_WHERE_COL, '=', TEST_WHERE_COL_VAL(test_incorrect_id));

            setupTestInstance(test_sql_statement);
            try {
                search_results = await test_instance.search();
            } catch(e) {
                console.log(e);
            }

            expect(search_results).to.be.an('array').that.is.empty;;
        }));
    });
    describe('_checkEmptySQL()', () => {
        it('', () => {

        });
    });
    describe('_getTables()', () => {
        it('', () => {

        });
    });
    describe('_getColumns()', () => {
        it('', () => {

        });
    });
    describe('_findColumn()', () => {
        it('', () => {

        });
    });
    describe('_addFetchColumns()', () => {
        it('', () => {

        });
    });
    describe('_conditionsToFetchAttributeValues()', () => {
        it('', () => {

        });
    });

    describe('_backtickAllSchemaItems()', () => {
        it('', () => {

        });
    });

    describe('_getFetchAttributeValues()', () => {
        it('', () => {

        });
    });

    describe('_checkHashValueExists()', () => {
        it('', () => {

        });
    });

    describe('_retrieveIds()', () => {
        it('', () => {

        });
    });

    describe('_readBlobFilesForSetup()', () => {
        it('', () => {

        });
    });

    describe('_consolidateData()', () => {
        it('', () => {

        });
    });

    describe('_processJoins()', () => {
        it('', () => {

        });
    });

    describe('_decideReadPattern()', () => {
        it('', () => {

        });
    });

    describe('_readRawFiles()', () => {
        it('', () => {

        });
    });

    describe('_readAttributeFilesByIds()', () => {
        it('', () => {

        });
    });

    describe('_readAttributeValues()', () => {
        it('', () => {

        });
    });

    describe('_readBlobFiles()', () => {
        it('', () => {

        });
    });

    describe('_finalSQL()', () => {
        it('', () => {

        });
    });

    describe('_buildSQL()', () => {
        it('', () => {

        });
    });

    describe('_stripFileExtension()', () => {
        it('', () => {

        });
    });
});