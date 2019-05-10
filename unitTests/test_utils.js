"use strict"
const path = require('path');
// const sinon = require('sinon');
const fs = require('fs');
const util = require('util');
const moment = require('moment');
const env = require('../utility/environment/environmentManager');

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
        fn.call().then(done, (err)=>{done(err)});
    };
};

/**
 * Call this function near the top of any unit test to assign the unhandledReject event handler (this is due to a bug in Node).
 * This will prevent tests bombing with an unhandled promise rejection in some cases.
 */
function preTestPrep() {
    let unhandledRejectionExitCode = 0;

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
    env.setPropsFilePath(`${process.cwd()}/../hdb_boot_properties.file`);
    env.initSync();
}

/**
 * Call this function to delete all directories under the specified path.  This is a synchronous function.
 * @param target_path
 */
function cleanUpDirectories(target_path) {
    if(!target_path) return;
    //Just in case
    if(target_path === '/') return;
    let files = [];
    if( fs.existsSync(target_path) ) {
        try {
            files = fs.readdirSync(target_path);
            for(let i = 0; i<files.length; i++) {
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

// const BASE_PATH = path.join(process.cwd(), 'bin');
const HDB_HASH_FOLDER_NAME = "__hdb_hash";
const HASH_ATTRIBUTE_NAME = "id";

// const ATTRIBUTE_1_INSTANCE_NAME = '';
// const ATTRIBUTE_1_TIME_NAME = moment().valueOf();
// const ATTRIBUTE_2_TIME_NAME = moment().subtract(6, 'hours').valueOf();
// const TEST_FILE_NAME_1 = `${ATTRIBUTE_1_TIME_NAME}.hdb`;
// const TEST_FILE_NAME_2 = `${ATTRIBUTE_2_TIME_NAME}.hdb`;
// const FILE_CONTENTS = "Name";
// const DELETE_MOD_BASE_PATH_NAME = 'BASE_PATH';
// const TEST_ATTRIBUTE_NAME = 'Name';
// const TEST_ATTRIBUTE_AGE = 'Age';

function makeTheDir(path) {
    if(!fs.existsSync(path)) {
        fs.mkdirSync(path);
    }
}

function createMockSchemaTableFileStructure(schema_path, schema, table, test_data) {
    try {
        //create schema
        makeTheDir(schema_path);
        //create table
        const table_path = path.join(schema_path, table);
        makeTheDir(table_path)
        let table_hash_dir_path = path.join(table_path, HDB_HASH_FOLDER_NAME);
        makeTheDir(table_hash_dir_path);
        //create attributes and hash dir
        const attribute_names = [];
        const final_test_data = test_data.map(data => {
            let keys = Object.keys(data).filter(key => (key !== 'file_paths' && key !== 'journal_paths' && key !== 'table'));
            for (let i=0; i < keys.length; i++) {
                let curr_attribute = keys[i];
                attribute_names.push(curr_attribute);
                let is_hash = curr_attribute === HASH_ATTRIBUTE_NAME;
                let hash_dir_path = path.join(table_path, HDB_HASH_FOLDER_NAME, curr_attribute);
                makeTheDir(hash_dir_path);
                let attribute_dir_path = path.join(table_path, curr_attribute);
                makeTheDir(attribute_dir_path);
                let attribute_instance_dir_path = path.join(attribute_dir_path, `${data[curr_attribute]}`);
                makeTheDir(attribute_instance_dir_path);
                if (is_hash) {
                    data.journal_paths.push(attribute_instance_dir_path);
                }
                // make the hash file
                let hash_file_path = path.join(hash_dir_path, data[HASH_ATTRIBUTE_NAME] + '.hdb');
                fs.writeFileSync(hash_file_path, data[curr_attribute]);
                data.file_paths.push(hash_file_path);
                if (!is_hash) {
                    let link_path = path.join(attribute_instance_dir_path, data[HASH_ATTRIBUTE_NAME] + '.hdb');
                    fs.linkSync(hash_file_path, link_path);
                    data.file_paths.push(link_path);
                } else {
                    // for hash attributes, we need to write a file with the current time stamp and the delta of the data
                    let time_file_name = path.join(attribute_instance_dir_path, `${moment().valueOf()}.hdb`);
                    fs.writeFileSync(time_file_name, util.inspect(data), 'utf-8');
                    data.journal_paths.push(time_file_name);
                    data.file_paths.push(time_file_name);
                }
            }
            return data;
        });
        //set hdb_global
        setGlobalSchema(schema, table, attribute_names);
        return final_test_data;
    } catch(e) {
         console.error(e);
    }
}

function setGlobalSchema(schema, table, attribute_names) {
    const attributes = attribute_names.map(name => ({ "attributes": name }));
    if (global.hdb_schema === undefined) {
        global.hdb_schema = {
            [schema]: {
                [table]: {
                    "hash_attribute": `${HASH_ATTRIBUTE_NAME}`,
                    "id": "8650f230-be55-4455-8843-55bcfe7f61c4",
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
        global.hdb_schema[schema][table] = {
            "hash_attribute": `${HASH_ATTRIBUTE_NAME}`,
            "id": "8650f230-be55-4455-8843-55bcfe7f61c4",
            "name": `${table}`,
            "schema": `${schema}`,
            "attributes": attributes
        };
    }
}

module.exports = {
    changeProcessToBinDir:changeProcessToBinDir,
    deepClone:deepClone,
    mochaAsyncWrapper:mochaAsyncWrapper,
    preTestPrep:preTestPrep,
    cleanUpDirectories:cleanUpDirectories,
    createMockSchemaTableFileStructure:createMockSchemaTableFileStructure,
    makeTheDir:makeTheDir
};