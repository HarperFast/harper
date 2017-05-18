'use strict'

const insert_validator = require('../validation/insertValidator.js'),
    fs = require('fs'),
    async = require('async'),
    path = require('path'),
    settings = require('settings'),
    child_process = require('child_process'),
    util = require('util'),
    moment = require('moment'),
    mkdirp = require('mkdirp'),
    global_schema = require('../utility/globalSchema'),
    search = require('./search');

const hdb_path = path.join(settings.HDB_ROOT, '/schema');
const regex = /[^0-9a-z]/gi;

module.exports = {
    insert: function (insert_object, callback) {
        global_schema.setSchemaDataToGlobal((err, data) => {
            if (err) {
                callback(err);
                return;
            }
            //validate insert_object for required attributes
            let validator = insert_validator(insert_object);
            if (validator) {
                callback(validator);
                return;
            }

            //check if schema / table directories exist
            if (!global.hdb_schema[insert_object.schema][insert_object.table]) {
                callback('Table: ' + insert_object.schema + '.' + insert_object.table + ' does not exist');
                return;
            }
            //TODO verify hash_attribute is correct for this table
            // create hashpaths
            var hash_paths = [];
            let table_schema = global.hdb_schema[insert_object.schema][insert_object.table];
            let hash_attribute = table_schema.hash_attribute;
            let base_path = hdb_path + '/' + insert_object.schema + '/' + insert_object.table + '/';
            var hashes = [];

            for (var r in insert_object.records) {
                var record = insert_object.records[r];
                hash_paths.push(`${base_path}__hdb_hash/${hash_attribute}/${record[hash_attribute]}.hdb`)
                hashes.push(record[hash_attribute]);
            }


            checkRecordsExist(hash_paths, insert_object.operation, function (err) {
                if (err) {
                    callback(err);
                    return;
                }

                if (insert_object.operation == 'update') {
                    proccessUpdate(insert_object, hash_attribute, hash_paths, hashes, callback);

                } else {
                    async.waterfall([
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
                }


            });


            //  remove symbolic links for attributes that are being updated. fs.unlink


        });
    }
};

function proccessUpdate(insert_object, hash_attribute, hash_paths, hashes, callback) {
    var attributes = [];
    for (let attr in insert_object.records[0]) {
        attributes.push(attr);
    }
    var search_obj = {};
    search_obj.schema = insert_object.schema;
    search_obj.table = insert_object.table;
    search_obj.hash_attribute = 'id';
    search_obj.hash_values = hashes;
    search_obj.get_attributes = attributes;
    let base_path = hdb_path + '/' + insert_object.schema + '/' + insert_object.table + '/';

    search.searchByHashes(search_obj, function (err, search_results) {
        var hashMap = [];
        for (var search_result in search_results) {
            hashMap[search_results[search_result][hash_attribute]] = search_results[search_result];
        }

        async.each(insert_object.records, function (record, wallyback) {
            var existingRecord = hashMap[record[hash_attribute]];
            for (let attr in record) {
                if (existingRecord && existingRecord[attr] && existingRecord[attr] == record[attr] && hash_attribute != attr) {
                    console.log(`removed attribute ${attr}`);
                    delete record[attr];
                } else if (existingRecord && existingRecord[attr] && attr != hash_attribute) {
                    fs.unlink(`${base_path}${attr}/${existingRecord[attr]}/${existingRecord[hash_attribute]}.hdb`,
                        function (err, callback) {
                            if (err) {
                                console.error(err);

                            }
                            console.log(`unliked ${base_path}${attr}/${existingRecord[attr]}/${existingRecord[hash_attribute]}.hdb `);


                        });
                } else if (!existingRecord) {
                    console.log('No existing record for ' + JSON.stringify(record));
                }
            }
            wallyback();


        }, function (err) {
            if (err) {
                callback(err);
                return;
            }
            async.waterfall([
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
        });
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
            let value_stripped = String(record[property]).replace(regex, '').substring(0, 4000);
            let attribute_file_name = record[hash_attribute] + '.hdb';
            let attribute_path = base_path + property + '/' + value_stripped;

            hash_folders[`${base_path}__hdb_hash/${property}`] = "";
            attribute_objects.push({
                file_name: `${base_path}__hdb_hash/${property}/${attribute_file_name}`,
                value: record[property]
            });
            if (property !== hash_attribute && record[property]) {
                folders[attribute_path] = "";

                link_objects.push({
                    link: `../../__hdb_hash/${property}/${attribute_file_name}`,
                    file_name: `${attribute_path}/${attribute_file_name}`
                });
            } else if (property === hash_attribute) {
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

function checkRecordsExist(hash_paths, operation, callback) {


    async.map(hash_paths, function(hash_path, inner_callback) {
        fs.access(hash_path, (err) => {
            switch (operation) {
                case 'update':
                    if (err && err.code === 'ENOENT') {
                        inner_callback('record does not exist');
                    } else {
                        inner_callback();
                    }
                    break;
                case 'insert':
                    if (err && err.code === 'ENOENT') {
                        inner_callback();
                    } else {
                        inner_callback('record exists');
                    }
                    break;
                default:
                    inner_callback('invalid operation ' + operation);
                    break;
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
    /*checkRecordsExist(data_wrapper.hash_paths, data_wrapper.operation, (err, data)=>
     {
     if(err){
     callback(err);
     return;
     }
     **/
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