"use strict"
const path = require('path');
const fs = require('fs');
const uuid = require('uuid/v4');
const moment = require('moment');
const env = require('../utility/environment/environmentManager');

const HDB_HASH_FOLDER_NAME = "__hdb_hash";
const ATTR_PATH_OBJECT = {
    "files": [],
    "journals": [],
    "system": []
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

function makeTheDir(path) {
    if(!fs.existsSync(path)) {
        fs.mkdirSync(path);
    }
}

//TODO: Update docs for this method
/**
 * This function will simulate the HDB data structure with the data passed in.  It will pull the hash attribute from the
 * global.hdb_schema values above.  A table value must be defined in the data so the function knows which table to pull
 * from.  The schema is always assumed to be 'test'.
 * @param data
 */
function createMockSchemaTableFS(hash_attribute, schema_path, schema, table, test_data) {
    try {
        //create schema
        makeTheDir(schema_path);

        //create table
        const table_id = uuid();
        const table_path = path.join(schema_path, table);
        makeTheDir(table_path);
        let table_hash_dir_path = path.join(table_path, HDB_HASH_FOLDER_NAME);
        makeTheDir(table_hash_dir_path);

        const test_table_paths = {
            table_dir: table_path,
            hash_dir: table_hash_dir_path
        };

        //create attribute and hash dirs
        const attribute_names = [];
        const test_table_data = test_data.map(data => {
            const test_record_paths = deepClone(ATTR_PATH_OBJECT);
            const keys = Object.keys(data).filter(key => (key !== 'table'));
            for (let i=0; i < keys.length; i++) {
                const curr_attribute = keys[i];
                if (attribute_names.indexOf(curr_attribute) < 0) {
                    attribute_names.push(curr_attribute);
                }
                const is_hash = curr_attribute === hash_attribute;
                const hash_dir_path = path.join(table_path, HDB_HASH_FOLDER_NAME, curr_attribute);
                makeTheDir(hash_dir_path);
                const attribute_dir_path = path.join(table_path, curr_attribute);
                makeTheDir(attribute_dir_path);
                const attribute_instance_dir_path = path.join(attribute_dir_path, `${data[curr_attribute]}`);
                makeTheDir(attribute_instance_dir_path);
                // make the hash file
                let hash_file_path = path.join(hash_dir_path, data[hash_attribute] + '.hdb');
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
        test_table_data.paths = test_table_paths;
        return test_table_data;
    } catch(e) {
         console.error(e);
    }
}

function tearDownMockFS(target_path) {
    if(!target_path) return;
    let files = [];
    if( fs.existsSync(target_path) ) {
        try {
            files = fs.readdirSync(target_path);
            for(let i = 0; i<files.length; i++) {
                let file = files[i];
                let curPath = path.join(target_path, file);
                if (fs.lstatSync(curPath).isDirectory()) { // recurse
                    tearDownMockFS(curPath);
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

function validateFSDeletion(paths) {
    for (let i = 0; i < paths.length; i++) {
        if (fs.existsSync(paths[i]) === true) {
            return false;
        }
    }
    return true;
}

function validateFSCreation(paths) {
    for(let i = 0; i < paths.length; i++) {
        if (fs.exists(paths[i]) === false) {
            return false;
        }
    }
    return true;
}

//TODO: Add docs for this method
function setGlobalSchema(hash_attribute, schema, table, table_id, attribute_names) {
    const attributes = attribute_names.map(name => ({ "attributes": name }));
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
        global.hdb_schema[schema][table] = {
            "hash_attribute": `${hash_attribute}`,
            "id": `${table_id}`,
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
    createMockSchemaTableFS:createMockSchemaTableFS,
    makeTheDir:makeTheDir,
    tearDownMockFS:tearDownMockFS,
    validateFSDeletion:validateFSDeletion,
    validateFSCreation:validateFSCreation
};