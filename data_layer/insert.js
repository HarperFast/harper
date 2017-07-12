'use strict';

const insert_validator = require('../validation/insertValidator.js'),
    fs = require('graceful-fs'),
    async = require('async'),
    path = require('path'),
    child_process = require('child_process'),
    util = require('util'),
    moment = require('moment'),
    mkdirp = require('mkdirp'),
    global_schema = require('../utility/globalSchema'),
    search = require('./search'),
    winston = require('../utility/logging/winston_logger'),
    _ = require('lodash'),
    PropertiesReader = require('properties-reader'),
    hdb_properties = PropertiesReader(`${process.cwd()}/../hdb_boot_properties.file`);
    hdb_properties.append(hdb_properties.get('settings_path'));


const hdb_path = path.join(hdb_properties.get('HDB_ROOT'), '/schema');
const regex = /\//g;

module.exports = {
    insert: insertData,
    update:updateData
};

function validation(write_object, callback){
    global_schema.getTableSchema(write_object.schema, write_object.table, (err, table_schema) => {
        if (err) {
            callback(err);
            return;
        }
        //validate insert_object for required attributes
        let validator = insert_validator(write_object);
        if (validator) {
            callback(validator);
            return;
        }
        let hash_attribute = table_schema.hash_attribute;

        //validate that every record has hash_attribute populated
        let bad_records = _.filter(write_object.records, (record) => {
            return !record[hash_attribute];
        });

        if (bad_records && bad_records.length > 0) {
            callback(`hash attribute not populated: ${JSON.stringify(bad_records)}`);
            return;
        }

        callback(null, table_schema);
    });
}

function insertData(insert_object, callback){
    try {
        if (insert_object.operation !== 'insert') {
            callback('invalid operation, must be insert');
        }

        async.waterfall([
            validation.bind(null, insert_object),
            (table_schema, caller) => {
                let hash_attribute = table_schema.hash_attribute;
                let hash_paths = [];
                let base_path = hdb_path + '/' + insert_object.schema + '/' + insert_object.table + '/';
                for (let r in insert_object.records) {
                    let record = insert_object.records[r];
                    hash_paths.push(`${base_path}__hdb_hash/${hash_attribute}/${record[hash_attribute]}.hdb`);
                }
                caller(null, hash_paths);
            },
            checkRecordsExist,
            checkAttributeSchema.bind(null, insert_object),
            processData
        ], (err) => {
            if (err) {
                callback(err);
                return;
            }

            callback(null, `successfully wrote ${insert_object.records.length} records`);
            return;
        });
    } catch(e){
        callback(e);
    }
}

function updateData(update_object, callback){
    try {
        if (update_object.operation !== 'update') {
            callback('invalid operation, must be update');
        }

        async.waterfall([
            validation.bind(null, update_object),
            (table_schema, caller) => {
                let attributes = new Set();
                let hashes = [];
                update_object.records.forEach((record) => {
                    hashes.push(record[table_schema.hash_attribute]);
                    Object.keys(record).forEach((attribute) => {
                        attributes.add(attribute);
                    });
                });

                let search_obj = {
                    schema: update_object.schema,
                    table: update_object.table,
                    hash_attribute: 'id',
                    hash_values: hashes,
                    get_attributes: Array.from(attributes)
                };

                caller(null, search_obj);
            },
            search.searchByHash,
            (existing_records, caller) => {
                let hash_attribute = global.hdb_schema[update_object.schema][update_object.table].hash_attribute;
                caller(null, update_object, hash_attribute, existing_records);
            },
            compareUpdatesToExistingRecords,
            unlinkFiles,
            (update_objects, caller) => {
                update_object.records = update_objects;
                caller(null, update_object);
            },
            checkAttributeSchema,
            processData
        ], (err) => {
            if (err) {
                callback(err);
                return;
            }

            callback(null, `successfully wrote ${update_object.records.length} records`);
            return;
        });
    } catch(e){
        callback(e);
    }
}

function compareUpdatesToExistingRecords(update_object, hash_attribute, existing_records, callback){

    let base_path = hdb_path + '/' + update_object.schema + '/' + update_object.table + '/';

    let unlink_paths = [];
    let update_objects = [];

    try {
        let update_map = _.keyBy(update_object.records, function(record) {
            return record[hash_attribute];
        });

        existing_records.forEach((existing_record) => {
            let update_record = update_map[existing_record[hash_attribute]];
            if (!update_record) {
                return;
            }
            let update = {};

            for (let attr in update_record) {
                if (existing_record[attr] != update_record[attr]) {
                    update[attr] = update_record[attr];

                    let value_stripped = String(existing_record[attr]).replace(regex, '').substring(0, 4000);
                    if (existing_record[attr] !== null && existing_record[attr] !== undefined) {
                        unlink_paths.push(`${base_path}${attr}/${value_stripped}/${existing_record[hash_attribute]}.hdb`);
                    }

                    if (update_record[attr] === null || update_record[attr] === undefined) {
                        unlink_paths.push(`${base_path}__hdb_hash/${attr}/${existing_record[hash_attribute]}.hdb`);
                    }
                }
            }

            if (Object.keys(update).length > 0) {
                update[hash_attribute] = existing_record[hash_attribute];
                update_objects.push(update);
            }
        });

        callback(null, unlink_paths, update_objects);
    } catch(e){
        callback(e);
    }
}

function unlinkFiles(unlink_paths, update_objects, callback){
    async.each(unlink_paths, (path, caller)=>{
        fs.unlink(path, (err)=>{
            if(err){
                winston.error(err);
            }

            caller();
        });
    }, (error)=>{
        if(error){
            callback(error);
            return;
        }

        callback(null, update_objects);
    });
}

function checkAttributeSchema(insert_object, callerback) {
    let table_schema = global.hdb_schema[insert_object.schema][insert_object.table];
    let hash_attribute = table_schema.hash_attribute;
    let epoch = new Date().valueOf();
    //let date = new moment().format(`YYYY-MM-DD HH:mm:ss.${process.hrtime()[1]} ZZ`);

    let insert_objects = [];
    let symbolic_links = [];
    //let touch_links = [];

    let folders = {};
    let hash_folders = {};
    //let delete_folders = {};
    let hash_paths = {};
    let base_path = hdb_path + '/' + insert_object.schema + '/' + insert_object.table + '/';

    async.each(insert_object.records, function (record, callback) {
        let attribute_objects = [];
        let link_objects = [];
        hash_paths[`${base_path}__hdb_hash/${hash_attribute}/${record[hash_attribute]}.hdb`] = '';
        for (let property in record) {
            if(record[property] === null || record[property] === undefined){
                return;
            }

            let value = typeof record[property] === 'object' ? JSON.stringify(record[property]) : record[property];
            let value_stripped = String(value).replace(regex, '').substring(0, 4000);
            let attribute_file_name = record[hash_attribute] + '.hdb';
            let attribute_path = base_path + property + '/' + value_stripped;

            hash_folders[`${base_path}__hdb_hash/${property}`] = "";
            attribute_objects.push({
                file_name: `${base_path}__hdb_hash/${property}/${attribute_file_name}`,
                value: value
            });
            if (property !== hash_attribute) {
                folders[attribute_path] = "";

                link_objects.push({
                    link: `../../__hdb_hash/${property}/${attribute_file_name}`,
                    file_name: `${attribute_path}/${attribute_file_name}`
                });
            } else {
                hash_folders[attribute_path] = "";
                attribute_objects.push({
                    file_name: `${attribute_path}/${record[hash_attribute]}-${epoch}.hdb`,
                    value: JSON.stringify(record)
                });
            }
        }
        insert_objects = insert_objects.concat(attribute_objects);
        symbolic_links = symbolic_links.concat(link_objects);
        callback();
    }, function (err) {
        if (err) {
            callerback(err);
            return;
        }
        let data_wrapper = {
            data_folders: Object.keys(hash_folders),
            data: insert_objects,
            link_folders: Object.keys(folders),
            links: symbolic_links,
            hash_paths: hash_paths,
            operation: insert_object.operation
        };

        return callerback(null, data_wrapper);
    });
}

function checkRecordsExist(hash_paths, callback) {
    async.map(hash_paths, function(hash_path, inner_callback) {
        fs.access(hash_path, (err) => {
            if (err && err.code === 'ENOENT') {
                inner_callback();
            } else {
                inner_callback('record exists');
            }
        });
    }, function(err){
        if (err) {
            callback(err);
        } else {
            callback();
        }
    });
}

function processData(data_wrapper, callback) {
    async.parallel([
        writeRawData.bind(null, data_wrapper.data_folders, data_wrapper.data),
        writeLinks.bind(null, data_wrapper.link_folders, data_wrapper.links),
    ], (err, results) => {
        if (err) {
            callback(err);
            return;
        }
        callback();
    });
    //});
}

function writeRawData(folders, data, callback) {
    async.waterfall([
        createFolders.bind(null, folders),
        writeRawDataFiles.bind(null, data)
    ], (err, results) => {
        if (err) {
            callback(err);
            return;
        }
        callback();
    });
}

function writeRawDataFiles(data, callback) {
    async.each(data, (attribute, caller) => {
        fs.writeFile(attribute.file_name, attribute.value, (err) => {
            if (err) {
                caller(err);
                return;
            }

            caller();
        });
    }, function (err) {
        if (err) {
            callback(err);
            return;
        }

        callback();
    });
}

function writeLinks(folders, links, callback) {
    async.waterfall([
        createFolders.bind(null, folders),
        writeLinkFiles.bind(null, links)
    ], (err, results) => {
        if (err) {
            callback(err);
            return;
        }
        callback();
    });
}

function writeLinkFiles(links, callback) {
    async.each(links, (link, caller) => {
        fs.symlink(link.link, link.file_name, (err) => {
            if (err && err.code !== 'EEXIST') {
                caller(err);
                return;
            }

            caller();
        });
    }, function (err) {
        if (err) {
            callback(err);
            return;
        }

        callback();
    });
}

function createFolders(folders, callback) {
    async.each(folders, (folder, caller) => {
        mkdirp(folder, (err) => {
            if (err) {
                caller(`mkdir on: ${folder} failed ${err}`);
                return;
            }

            caller();
        });
    }, function (err) {
        if (err) {
            callback(err);
            return;
        }

        callback();
    });
}