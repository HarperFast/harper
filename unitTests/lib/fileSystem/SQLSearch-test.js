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

const assert = require('assert');
const sinon = require('sinon');
const env = require('../../../utility/environment/environmentManager');
const FileSearch = require('../../../lib/fileSystem/SQLSearch');

const TEST_FS_DIR = getMockFSPath();
const TEST_SCHEMA = 'test';
// const TEST_SCHEMA_PATH = path.join(TEST_FS_DIR, TEST_SCHEMA);
const HASH_ATTRIBUTE = 'id';
const TEST_TABLE_CAT = 'cat';
const TEST_TABLE_DOG = 'dog';
const TEST_DATA_DOG = [
    {
        "id": 1,
        "age": 5,
        "name": "Sam",
        "breed": "Mutt"
    },
    {
        "id": 2,
        "age": 4,
        "name": "David",
        "breed": "Golden Retriever"
    },
    {
        "id": 3,
        "age": 10,
        "name": "Kyle",
        "breed": "Pit Bull"
    },
    {
        "id": 4,
        "age": 10,
        "name": "Sam",
        "breed": "Pit"
    },
    {
        "id": 5,
        "age": 15,
        "name": "Eli",
        "breed": "Poodle"
    },
    {
        "id": 6,
        "age": 8,
        "name": "Sarah",
        "breed": "Poodle"
    }
];
const TEST_DATA_CAT = [
    {
        "id": 1,
        "age": 5,
        "name": "Sam"
    },
    {
        "id": 2,
        "age": 4,
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

let test_instance;

const sandbox = sinon.createSandbox();
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

sandbox.stub(env, 'getHdbBasePath').returns(TEST_FS_DIR);

function setupData() {
    const test_data_dog = deepClone(TEST_DATA_DOG);
    const test_data_cat = deepClone(TEST_DATA_CAT);

    createMockFS(HASH_ATTRIBUTE, TEST_SCHEMA, TEST_TABLE_DOG, test_data_dog);
    createMockFS(HASH_ATTRIBUTE, TEST_SCHEMA, TEST_TABLE_CAT, test_data_cat);
}

function setClassMethodSpies() {
    _getColumns_spy = sandbox.spy(FileSearch.prototype, '_getColumns');
    _getTables_spy = sandbox.spy(FileSearch.prototype, '_getTables');
    _conditionsToFetchAttributeValues_spy = sandbox.spy(FileSearch.prototype, '_conditionsToFetchAttributeValues');
    _backtickAllSchemaItems_spy = sandbox.spy(FileSearch.prototype, '_backtickAllSchemaItems');
}

function setupTestInstance(statement, attributes) {
    const test_statement = statement ? statement : TEST_STATEMENT_DOG;
    const test_attributes = attributes ? attributes : TEST_ATTRIBUTES_DOG;
    test_instance = new FileSearch(test_statement, test_attributes);
}

describe('FileSystem class methods', () => {
    before(() => {
        setupData();
        setClassMethodSpies();
    });

    afterEach(() => {
        sandbox.resetHistory();
    })

    after(() => {
        tearDownMockFS();
        sandbox.restore();
    });

    describe('constructor()', () => {
        it('should call four class methods when instantiated', () => {
            setupTestInstance();
            assert.equal(_getColumns_spy.calledOnce, true);
            assert.equal(_getTables_spy.calledOnce, true);
            assert.equal(_conditionsToFetchAttributeValues_spy.calledOnce, true);
            assert.equal(_backtickAllSchemaItems_spy.calledOnce, true);
        });

        it('should throw an exception if no statement argument is provided', () => {
            let err;
            try {
                new FileSearch(null, TEST_ATTRIBUTES_DOG);
            } catch(e) {
                err = e;
            }
            assert.equal(err, 'statement cannot be null');
        });
    });
    describe('search()', () => {
        it('', () => {

        });
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