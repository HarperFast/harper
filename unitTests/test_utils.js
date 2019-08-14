"use strict";
const path = require('path');
const fs = require('fs');
const moment = require('moment');
const sinon = require('sinon');
const uuid = require('uuid/v4');

const sql = require('../sqlTranslator/index');
const SelectValidator = require('../sqlTranslator/SelectValidator');

const env = require('../utility/environment/environmentManager');
const terms = require('../utility/hdbTerms');
const common_utils = require('../utility/common_utils');

let env_mgr_init_sync_stub = undefined;
const {
    JOB_TABLE_NAME,
    NODE_TABLE_NAME,
    ATTRIBUTE_TABLE_NAME,
    LICENSE_TABLE_NAME,
    QUEUE_TABLE_NAME,
    ROLE_TABLE_NAME,
    SCHEMA_TABLE_NAME,
    TABLE_TABLE_NAME,
    USER_TABLE_NAME
} = terms.SYSTEM_TABLE_NAMES;

const {
    ATTR_ATTRIBUTE_KEY,
    ATTR_CREATEDDATE_KEY,
    ATTR_HASH_ATTRIBUTE_KEY,
    ATTR_ID_KEY,
    ATTR_NAME_KEY,
    ATTR_RESIDENCE_KEY,
    ATTR_SCHEMA_KEY,
    ATTR_SCHEMA_TABLE_KEY,
    ATTR_TABLE_KEY,
} = terms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES;

const MOCK_FS_ARGS_ERROR_MSG = "Null, undefined, and/or empty string argument values not allowed when building mock HDB FS for testing";
const UNIT_TEST_DIR = __dirname;
const ENV_DIR_NAME = 'envDir';
const TEST_FS_DIR = path.join(ENV_DIR_NAME, `test_schema`);;
const ATTR_PATH_OBJECT = {
    "files": [],
    "journals": [],
    "system": []
};

/**
 * Used in the createMockGlobalSchema function to generate a global.hdb_schema in the test harness.
 */
class MockSchemaObject {
    constructor() {
        this.schema = {};
    }

    addSchema(schema_name_string) {
        this.schema[schema_name_string] = {};
    }

    addTable(schema_name_string, table_name_string) {
        this.schema[schema_name_string][table_name_string] = {};
    }

    addAttribute(schema_name_string, table_name_string, att_name_string) {
        this.schema[schema_name_string][table_name_string][att_name_string] = {};
    }
}

/**
 * This needs to be called near the top of our unit tests.  Most will fail when loading harper modules due to the
 * properties reader trying to look in bin.  We can iterate on this to make it smarter if needed, for now this works.
 */
function changeProcessToBinDir() {
    try {
        process.chdir(path.join(process.cwd(), 'bin'));
        console.log(`Current directory ${process.cwd()}`);
    } catch (e) {
        // no-op, we are probably already in bin
    }
}

/**
 This is a simple, naive clone implementation.  It should never, ever! be used in prod.
 */
function deepClone(a) {
    return JSON.parse(JSON.stringify(a));
}

/**
 * Wrap an async function with a try/catch to reduce the amount of test code.  This is OK for unit tests, but prod code should be explicitly wrapped.
 * @param fn
 * @returns {function(*=)}
 */
let mochaAsyncWrapper = (fn) => {
    return (done) => {
        fn.call().then(done, (err) => {
            done(err);
        });
    };
};

/**
 * Call this function near the top of any unit test to assign the unhandledReject event handler (this is due to a bug in Node).
 * This will prevent tests bombing with an unhandled promise rejection in some cases.
 */
function preTestPrep() {
    let unhandledRejectionExitCode = 0;
    if(env_mgr_init_sync_stub) {
        env_mgr_init_sync_stub.restore();
    }
    env_mgr_init_sync_stub = sinon.stub(env, 'initSync').callsFake(() => {
       env.initTestEnvironment();
    });
    process.on("unhandledRejection", (reason) => {
        console.log("unhandled rejection:", reason);
        unhandledRejectionExitCode = 1;
        throw reason;
    });

    process.prependListener("exit", (code) => {
        if (code === 0) {
            process.exit(unhandledRejectionExitCode);
        }
    });
    // Try to change to bin
    changeProcessToBinDir();
    env.initTestEnvironment();
}

function makeTheDir(path) {
    if(!fs.existsSync(path)) {
        fs.mkdirSync(path);
    }
}

/**
 * Call this function to delete all directories under the specified path.  This is a synchronous function.
 * @param target_path The path to the directory to remove
 *
 * IMPORTANT: Use `tearDownMockFS()` to properly clean up the mock fs built using `createMockFS()`
 */
function cleanUpDirectories(target_path) {
    if (!target_path) return;
    //Just in case
    if (target_path === '/') return;
    let files = [];
    if (fs.existsSync(target_path)) {
        try {
            files = fs.readdirSync(target_path);
            for (let i = 0; i < files.length; i++) {
                let file = files[i];
                let curPath = path.join(target_path, file);
                if (fs.lstatSync(curPath).isDirectory()) { // recurse
                    cleanUpDirectories(curPath);
                } else {
                    fs.unlinkSync(curPath);
                }
            }
            fs.rmdirSync(target_path);
        } catch (e) {
            console.error(e);
        }
    }
}

/** HELPER METHODS TO CREATE MOCK HDB SCHEMA FILE SYSTEM STRUCTURE */
/**
 * Returns the path to the directory with the mock FS structure that will be created by `createMockFS()`
 * @returns String representing the path value to the mock file system directory
 */
function getMockFSPath() {
    env.setProperty(terms.HDB_SETTINGS_NAMES.HDB_ROOT_KEY, path.join(UNIT_TEST_DIR, ENV_DIR_NAME));
    return path.join(UNIT_TEST_DIR, TEST_FS_DIR);
}

/**
 * Validates that arguments passed into `createMockFS()` are not null, undefined, or "" - throws error, if so
 * @param argArray Array of arg values
 */
function validateMockFSArgs(argArray) {
    for (let i=0; i < argArray.length; i++) {
        if (argArray[i] === null || argArray[i] === undefined || argArray[i] === "") {
            throw new Error(MOCK_FS_ARGS_ERROR_MSG);
        }
    }
}

/**
 * This function will simulate the HDB data structure with the data passed in at the path accessed by using
 * `getMockFSPath()` in your unit test file. It will build out a fs structure for the schema/table/attributes
 * included in the parameters AND make appropriate updates to the schema > system structure AND set global.hdb_schema.
 * This function can be used to build out multiple schemas and tables, if necessary.
 *
 * IMPORTANT: Please be sure to use `tearDownMockFS()` after any test/s using this mock fs structure to ensure the test
 * data is properly removed from the file system and the global.hdb_schema is reset to undefined for other unit tests.
 *
 * @param hash_attribute The hash_attribute to use
 * @param schema The name of the schema you'd like to create
 * @param table The name of the table you'd like to create
 * @param test_data The attribute data you'd like to insert into the table.
 *          Ex: {"name":"Frank","id":"1","age":5}
 * @returns Object in the format of ATTR_PATH_OBJECT above that includes paths associated with the files and journal
 *          entries associated with the data passed in.
 * TODO: The method does not currently return paths for the system schema directory.
 */
function createMockFS(hash_attribute, schema, table, test_data) {
    try {
        validateMockFSArgs([hash_attribute, schema, table, test_data]);

        //create default mock fs dir
        const test_base_path = getMockFSPath();
        makeTheDir(test_base_path);

        //create schema
        const schema_path = path.join(test_base_path, schema);
        makeTheDir(schema_path);

        //create table
        const table_id = uuid();
        const table_path = path.join(schema_path, table);
        makeTheDir(table_path);
        let table_hash_dir_path = path.join(table_path, terms.HASH_FOLDER_NAME);
        makeTheDir(table_hash_dir_path);

        const test_table_paths = {
            table_dir: table_path,
            hash_dir: table_hash_dir_path
        };

        //create attribute and hash dirs
        const attribute_names = [];
        const test_table_data = test_data.map(data => {
            const test_record_paths = deepClone(ATTR_PATH_OBJECT);
            const keys = Object.keys(data).filter(key => (key !== 'table' && key !== 'schema'));
            for (let i=0; i < keys.length; i++) {
                const curr_attribute = keys[i].trim();
                if (attribute_names.indexOf(curr_attribute) < 0) {
                    attribute_names.push(curr_attribute);
                }
                const is_hash = hash_attribute === curr_attribute;
                const hash_dir_path = path.join(table_path, terms.HASH_FOLDER_NAME, curr_attribute);
                makeTheDir(hash_dir_path);
                const attribute_dir_path = path.join(table_path, curr_attribute);
                makeTheDir(attribute_dir_path);
                const attr_values = common_utils.valueConverter(data[curr_attribute]);
                if (attr_values.value_path.endsWith('/blob')) {
                    const attr_dir_for_blob = attr_values.value_path.replace("/blob", "");
                    const dir_for_blob = path.join(attribute_dir_path, attr_dir_for_blob);
                    makeTheDir(dir_for_blob);
                }
                const attribute_instance_dir_path = path.join(attribute_dir_path, attr_values.value_path);
                makeTheDir(attribute_instance_dir_path);
                // make the hash file
                let hash_file_path = path.join(hash_dir_path, `${data[hash_attribute]}.hdb`);
                fs.writeFileSync(hash_file_path, data[curr_attribute]);
                test_record_paths.files.push(hash_file_path);
                if (!is_hash) {
                    let link_path = path.join(attribute_instance_dir_path, data[hash_attribute] + '.hdb');
                    fs.linkSync(hash_file_path, link_path);
                    test_record_paths.files.push(link_path);
                } else {
                    // for hash attributes, we need to write a file with the current time stamp and the delta of the data
                    let time_file_name = path.join(attribute_instance_dir_path, `${moment().valueOf()}.hdb`);
                    fs.writeFileSync(time_file_name, JSON.stringify(data),'utf-8');
                    test_record_paths.journals.push(attribute_instance_dir_path);
                    test_record_paths.journals.push(time_file_name);
                }
            }
            data.paths = test_record_paths;
            return data;
        });

        //set hdb_global
        setGlobalSchema(hash_attribute, schema, table, table_id, attribute_names);

        //set system > schema structure
        createMockSystemSchema(hash_attribute, schema, table, attribute_names);

        //add top-level table and hash directory paths to returned data for testing
        test_table_data.paths = test_table_paths;

        return test_table_data;
    } catch(e) {
         console.error(e);
    }
}

/**
 * Removes the mock FS directory created by `createMockFS()` and resets global.hdb_schema
 */
function tearDownMockFS() {
    const test_base_path = getMockFSPath();
    cleanUpDirectories(test_base_path);
    global.hdb_schema = undefined;
}

/**
 * Accepts a
 * @param system_schema_object
 */
function createMockSystemSchema(system_schema_object) {

}

/**
 * This method is used in `createMockFS()` to create the mock FS structure for the schema > system directory
 * TODO: Right now, this method does not return paths to specific directories or files being created.  This functionality
 ** should be added as when needed in future tests in the `system` array value returned from `createMockFS()`.
 */

function createMockSystemSchema(hash_attribute, schema, table, attributes_keys) {
    const test_base_path = getMockFSPath();
    const test_system_base_path = path.join(test_base_path, terms.SYSTEM_SCHEMA_NAME);

    // create default dir structure
    makeTheDir(test_system_base_path);

    // schema
    const schema_dir_path = path.join(test_system_base_path, SCHEMA_TABLE_NAME);
    makeTheDir(schema_dir_path);

    // schema > name
    const schema_name_dir = path.join(schema_dir_path, ATTR_NAME_KEY);
    makeTheDir(schema_name_dir);

    // schema > name > [schema]
    const schema_name_schema_dir = path.join(schema_name_dir, schema);
    makeTheDir(schema_name_schema_dir);
    // write file
    const timestamp_value_schema = `${moment().valueOf()}`;
    const schema_time_file_name = path.join(schema_name_schema_dir, `${timestamp_value_schema}.hdb`);
    const schema_data = JSON.stringify({ name: schema, createddate: timestamp_value_schema });
    fs.writeFileSync(schema_time_file_name, schema_data,'utf-8');

    // schema > createddate
    const schema_createddate_dir = path.join(schema_dir_path, ATTR_CREATEDDATE_KEY);
    makeTheDir(schema_createddate_dir);
    // schema > createddate > [timestamp]
    const schema_createddate_timestamp_dir = path.join(schema_createddate_dir, timestamp_value_schema);
    makeTheDir(schema_createddate_timestamp_dir);

    // schema > __hdb_hash
    const schema_hdb_hash_path = path.join(schema_dir_path, terms.HASH_FOLDER_NAME);
    makeTheDir(schema_hdb_hash_path);

    // schema > __hdb_hash > name
    const schema_hdb_hash_name = path.join(schema_hdb_hash_path, ATTR_NAME_KEY);
    makeTheDir(schema_hdb_hash_name);
    //create record
    const name_hash_file = path.join(schema_hdb_hash_name, `${schema}.hdb`);
    fs.writeFileSync(name_hash_file, schema,'utf-8');

    // schema > __hdb_hash > createddate
    const schema_hdb_hash_createddate = path.join(schema_hdb_hash_path, ATTR_CREATEDDATE_KEY);
    makeTheDir(schema_hdb_hash_createddate);
    //create hdb_hash createddate record
    const createddate_hash_file = path.join(schema_hdb_hash_createddate, `${schema}.hdb`);
    fs.writeFileSync(createddate_hash_file, timestamp_value_schema,'utf-8');
    const s_link_path = path.join(schema_createddate_timestamp_dir, `${schema}.hdb`);
    fs.linkSync(createddate_hash_file, s_link_path);

    // table
    const timestamp_value_table = `${moment().valueOf()}`;
    const table_dir_path = path.join(test_system_base_path, TABLE_TABLE_NAME);
    makeTheDir(table_dir_path);
    const table_hash_value = uuid();

    // table > hash_attribute
    const table_hash_att_dir = path.join(table_dir_path, ATTR_HASH_ATTRIBUTE_KEY);
    makeTheDir(table_hash_att_dir);
    // table > hash_attribute > id
    const table_hash_att_id_dir = path.join(table_hash_att_dir, ATTR_ID_KEY);
    makeTheDir(table_hash_att_id_dir);

    // table > id
    const table_id_dir = path.join(table_dir_path, ATTR_ID_KEY);
    makeTheDir(table_id_dir);
    // table > id > [hash_value]
    const table_id_hash_dir = path.join(table_id_dir, table_hash_value);
    makeTheDir(table_id_hash_dir);
    const t_id_timestamp_file = path.join(table_id_hash_dir, `${timestamp_value_table}.hdb`);
    const table_data = JSON.stringify({ name: table, schema: schema, id: table_hash_value, hash_attribute: hash_attribute });
    fs.writeFileSync(t_id_timestamp_file, table_data,'utf-8');

    // table > name
    const table_name_dir = path.join(table_dir_path, ATTR_NAME_KEY);
    makeTheDir(table_name_dir);
    // table > name > [table]
    const table_name_name_dir = path.join(table_name_dir, table);
    makeTheDir(table_name_name_dir);

    // table > residence
    const table_residence_dir = path.join(table_dir_path, ATTR_RESIDENCE_KEY);
    makeTheDir(table_residence_dir);

    // table > schema
    const table_schema_dir = path.join(table_dir_path, ATTR_SCHEMA_KEY);
    makeTheDir(table_schema_dir);
    // table > schema > [schema]
    const table_schema_schema_dir = path.join(table_schema_dir, schema);
    makeTheDir(table_schema_schema_dir);

    // table > __hdb_hash
    const table_hdb_hash_dir = path.join(table_dir_path, terms.HASH_FOLDER_NAME);
    makeTheDir(table_hdb_hash_dir);
    // table > __hdb_hash > hash_attribute
    const hash_hash_attr_dir = path.join(table_hdb_hash_dir, ATTR_HASH_ATTRIBUTE_KEY);
    makeTheDir(hash_hash_attr_dir);
    const hash_hash_attr_file = path.join(hash_hash_attr_dir, `${table_hash_value}.hdb`);
    fs.writeFileSync(hash_hash_attr_file, ATTR_ID_KEY, 'utf-8');
    const t_id_link_file = path.join(table_hash_att_id_dir, `${table_hash_value}.hdb`);
    fs.linkSync(hash_hash_attr_file, t_id_link_file);

    // table > __hdb_hash > id
    const hash_id_dir = path.join(table_hdb_hash_dir, ATTR_ID_KEY);
    makeTheDir(hash_id_dir);
    const hash_id_file = path.join(hash_id_dir, `${table_hash_value}.hdb`);
    fs.writeFileSync(hash_id_file, table_hash_value, 'utf-8');

    // table > __hdb_hash > name
    const hash_name_dir = path.join(table_hdb_hash_dir, ATTR_NAME_KEY);
    makeTheDir(hash_name_dir);
    const hash_name_file = path.join(hash_name_dir, `${table_hash_value}.hdb`);
    fs.writeFileSync(hash_name_file, table, 'utf-8');
    const t_name_link_file = path.join(table_name_name_dir, `${table_hash_value}.hdb`);
    fs.linkSync(hash_name_file, t_name_link_file);

    // table > __hdb_hash > schema
    const hash_schema_dir = path.join(table_hdb_hash_dir, ATTR_SCHEMA_KEY);
    makeTheDir(hash_schema_dir);
    const hash_schema_file = path.join(hash_schema_dir, `${table_hash_value}.hdb`);
    fs.writeFileSync(hash_schema_file, schema, 'utf-8');
    const t_schema_link_file = path.join(table_schema_schema_dir, `${table_hash_value}.hdb`);
    fs.linkSync(hash_schema_file, t_schema_link_file);

    // attributes
    const attr_dir_path = path.join(test_system_base_path, ATTRIBUTE_TABLE_NAME);
    makeTheDir(attr_dir_path);

    for (let i=0; i < attributes_keys.length; i++) {
        const attr_value = attributes_keys[i];
        const attr_hash_value = uuid();
        const attr_timestamp = `${moment().valueOf()}`;
        const schematable_value = `${schema}.${table}`;

        // attr > attribute
        const attr_attribute_dir = path.join(attr_dir_path, ATTR_ATTRIBUTE_KEY);
        makeTheDir(attr_attribute_dir);
        // attr > attribute > [attribute]
        const attr_attribute_value_dir = path.join(attr_attribute_dir, attr_value);
        makeTheDir(attr_attribute_value_dir);

        // attr > id
        const attr_id_dir = path.join(attr_dir_path, ATTR_ID_KEY);
        makeTheDir(attr_id_dir);
        // attr > id > [hash_value]
        const attr_id_hash_dir = path.join(attr_id_dir, attr_hash_value);
        makeTheDir(attr_id_hash_dir);
        const attr_data = JSON.stringify({
                schema: schema, table: table, attribute: attr_value,
                id: attr_hash_value, schema_table: schematable_value
            });
        const attr_id_hash_file = path.join(attr_id_hash_dir, `${attr_timestamp}.hdb`);
        fs.writeFileSync(attr_id_hash_file, attr_data, 'utf-8');

        // attr > schema
        const attr_schema_dir = path.join(attr_dir_path, ATTR_SCHEMA_KEY);
        makeTheDir(attr_schema_dir);
        // attr > schema > [schema]
        const attr_schema_value_dir = path.join(attr_schema_dir, schema);
        makeTheDir(attr_schema_value_dir);

        // attr > schema_table
        const attr_schematable_dir = path.join(attr_dir_path, ATTR_SCHEMA_TABLE_KEY);
        makeTheDir(attr_schematable_dir);
        // attr > schema_table > [schema.table]
        const attr_schematable_value_dir = path.join(attr_schematable_dir, schematable_value);
        makeTheDir(attr_schematable_value_dir);

        // attr > table
        const attr_table_dir = path.join(attr_dir_path, ATTR_TABLE_KEY);
        makeTheDir(attr_table_dir);
        // attr > table > [table]
        const attr_table_value_dir = path.join(attr_table_dir, table);
        makeTheDir(attr_table_value_dir);

        // attr > __hdb_hash
        const attr_hdb_hash_dir = path.join(attr_dir_path, terms.HASH_FOLDER_NAME);
        makeTheDir(attr_hdb_hash_dir);

        // attr > __hdb_hash > attribute
        const attr_hash_attr_dir = path.join(attr_hdb_hash_dir, ATTR_ATTRIBUTE_KEY);
        makeTheDir(attr_hash_attr_dir);
        const attr_hash_attr_file = path.join(attr_hash_attr_dir, `${attr_hash_value}.hdb`);
        fs.writeFileSync(attr_hash_attr_file, attr_value, 'utf-8');
        const a_hash_attr_link_file = path.join(attr_attribute_value_dir, `${attr_timestamp}.hdb`);
        fs.linkSync(attr_hash_attr_file, a_hash_attr_link_file);

        // attr > __hdb_hash > id
        const attr_hash_id_dir = path.join(attr_hdb_hash_dir, ATTR_ID_KEY);
        makeTheDir(attr_hash_id_dir);
        const attr_hash_id_file = path.join(attr_hash_id_dir, `${attr_hash_value}.hdb`);
        fs.writeFileSync(attr_hash_id_file, attr_hash_value, 'utf-8');

        // attr > __hdb_hash > schema
        const attr_hash_schema_dir = path.join(attr_hdb_hash_dir, ATTR_SCHEMA_KEY);
        makeTheDir(attr_hash_schema_dir);
        const attr_hash_schema_file = path.join(attr_hash_schema_dir, `${attr_hash_value}.hdb`);
        fs.writeFileSync(attr_hash_schema_file, schema, 'utf-8');
        const a_hash_schema_link_file = path.join(attr_schema_value_dir, `${attr_hash_value}.hdb`);
        fs.linkSync(attr_hash_schema_file, a_hash_schema_link_file);

        // attr > __hdb_hash > schema_table
        const attr_hash_schematable_dir = path.join(attr_hdb_hash_dir, ATTR_SCHEMA_TABLE_KEY);
        makeTheDir(attr_hash_schematable_dir);
        const attr_hash_schematable_file = path.join(attr_hash_schematable_dir, `${attr_hash_value}.hdb`);
        fs.writeFileSync(attr_hash_schematable_file, schematable_value, 'utf-8');
        const a_hash_schematable_link_file = path.join(attr_schematable_value_dir, `${attr_hash_value}.hdb`);
        fs.linkSync(attr_hash_schematable_file, a_hash_schematable_link_file);

        // attr > __hdb_hash > table
        const attr_hash_table_dir = path.join(attr_hdb_hash_dir, ATTR_TABLE_KEY);
        makeTheDir(attr_hash_table_dir);
        const attr_hash_table_file = path.join(attr_hash_table_dir, `${attr_hash_value}.hdb`);
        fs.writeFileSync(attr_hash_table_file, table, 'utf-8');
        const a_hash_table_link_file = path.join(attr_table_value_dir, `${attr_hash_value}.hdb`);
        fs.linkSync(attr_hash_table_file, a_hash_table_link_file);

    }

    // Other schema > system directories
    // TODO: add additional structure to schema > system directories below as needed for testing.
    makeTheDir(path.join(test_system_base_path, LICENSE_TABLE_NAME));
    makeTheDir(path.join(test_system_base_path, JOB_TABLE_NAME));
    makeTheDir(path.join(test_system_base_path, NODE_TABLE_NAME));
    makeTheDir(path.join(test_system_base_path, QUEUE_TABLE_NAME));
    makeTheDir(path.join(test_system_base_path, ROLE_TABLE_NAME));
    makeTheDir(path.join(test_system_base_path, USER_TABLE_NAME));
}

/**
 * This method is used in `createMockFS()` to update global.hdb_schema based on the mocked FS structure created.
 */
function setGlobalSchema(hash_attribute, schema, table, table_id, attributes_keys) {
    const attributes = attributes_keys.map(attr_key => ({ "attribute": attr_key }));

    if (global.hdb_schema === undefined) {
        global.hdb_schema = {
            [schema]: {
                [table]: {
                    "hash_attribute": `${hash_attribute}`,
                    "id": `${table_id}`,
                    "name": `${table}`,
                    "schema": `${schema}`,
                    "attributes": attributes
                },
            },
            "system": {
                "hdb_table": {
                    "hash_attribute": "id",
                    "name": "hdb_table",
                    "schema": "system",
                    "residence": [
                        "*"
                    ],
                    "attributes": [
                        {
                            "attribute": "id"
                        },
                        {
                            "attribute": "name"
                        },
                        {
                            "attribute": "hash_attribute"
                        },
                        {
                            "attribute": "schema"
                        }
                    ]
                },
                "hdb_drop_schema": {
                    "hash_attribute": "id",
                    "name": "hdb_drop_schema",
                    "schema": "system",
                    "residence": [
                        "*"
                    ]
                },
                "hdb_attribute": {
                    "hash_attribute": "id",
                    "name": "hdb_attribute",
                    "schema": "system",
                    "residence": [
                        "*"
                    ]
                },
                "hdb_schema": {
                    "hash_attribute": "name",
                    "name": "hdb_schema",
                    "schema": "system",
                    "residence": [
                        "*"
                    ],
                    "attributes": [
                        {
                            "attribute": "name"
                        },
                        {
                            "attribute": "createddate"
                        }
                    ]
                },
                "hdb_user": {
                    "hash_attribute": "username",
                    "name": "hdb_user",
                    "schema": "system",
                    "residence": [
                        "*"
                    ]
                },
                "hdb_role": {
                    "hash_attribute": "id",
                    "name": "hdb_user",
                    "schema": "system",
                    "residence": [
                        "*"
                    ]
                },
                "hdb_license": {
                    "hash_attribute": "license_key",
                    "name": "hdb_license",
                    "schema": "system"
                },
                "hdb_nodes": {
                    "hash_attribute": "name",
                    "residence": [
                        "*"
                    ]
                },
                "hdb_queue": {
                    "hash_attribute": "id",
                    "name": "hdb_queue",
                    "schema": "system",
                    "residence": [
                        "*"
                    ]
                }
            }
        };
    } else {
        if (!global.hdb_schema[schema]) {
            global.hdb_schema[schema] = {
                [table]: {
                    "hash_attribute": `${hash_attribute}`,
                    "id": `${table_id}`,
                    "name": `${table}`,
                    "schema": `${schema}`,
                    "attributes": attributes
                }
            };
        } else {
            global.hdb_schema[schema][table] = {
                "hash_attribute": `${hash_attribute}`,
                "id": `${table_id}`,
                "name": `${table}`,
                "schema": `${schema}`,
                "attributes": attributes
            };
        }
    }
}

/**
 * Converts a sql statement into an AST object for an alasql operation
 * @param sql_statement
 * @returns {SelectValidator}
 */
function generateMockAST(sql_statement) {
    try {
        const test_ast = sql.convertSQLToAST(sql_statement);
        const validated_ast = new SelectValidator(test_ast.ast.statements[0]);
        validated_ast.validate();
        return validated_ast;
    } catch(e) {
        console.log(e);
    }
}

function sortDesc(data, sort_by) {
    if (sort_by) {
        return data.sort((a, b) => b[sort_by] - a[sort_by]);
    }

    return data.sort((a, b) => b - a);
}

function sortAsc(data, sort_by) {
    if (sort_by) {
        return data.sort((a, b) => a[sort_by] - b[sort_by]);
    }

    return data.sort((a, b) => a - b);
}

function generateAPIMessage(msg_type_enum) {
    let generated_msg = undefined;
    switch(msg_type_enum) {
        case terms.OPERATIONS_ENUM.CREATE_SCHEMA:
            break;
        case terms.OPERATIONS_ENUM.CREATE_TABLE:
            break;
        case terms.OPERATIONS_ENUM.CREATE_ATTRIBUTE:
            break;

        default:
            break;
    }
    return generated_msg;
}

module.exports = {
    changeProcessToBinDir,
    deepClone,
    mochaAsyncWrapper,
    preTestPrep,
    cleanUpDirectories,
    createMockFS,
    createMockSystemSchema,
    setGlobalSchema,
    tearDownMockFS,
    makeTheDir,
    getMockFSPath,
    generateMockAST,
    sortAsc,
    sortDesc,
    generateAPIMessage
};