'use strict'

const insert_validator = require('../validation/insertValidator.js'),
    fs = require('graceful-fs'),
    async = require('async'),
    path = require('path'),
    settings = require('settings'),
    moment = require('moment');

const hdb_path = path.join(settings.PROJECT_DIR, '/hdb/schema');

module.exports = {
    insert: function (insert_object, callback) {
        //TODO move this all into async waterfall
        //validate insert_object for required attributes
        var validator = insert_validator(insert_object);
        if (validator) {
            callback(validator);
            return;
        }

        //check if schema / table directories exist
        var table_path = path.join(hdb_path, insert_object.schema, insert_object.table);
        if (!checkPathExists(table_path)) {
            callback('Table: ' + insert_object.schema + '.' + insert_object.table + ' does not exist');
            return;
        }
        //TODO verify hash_attribute is correct for this table

        //preprocess all record attributes
        var attributes = checkAttributeSchema(insert_object);

        insertRecords(insert_object, attributes, function(err, data){
            callback(null, 'success');
        });

    }
};

function insertRecords(insert_object, attributes, callback){
    var schema = {
        schema:insert_object.schema,
        table:insert_object.table,
        hash_attribute: insert_object.hash_attribute,
        date: new Date().getTime(),
        attributes:attributes
    };

    async.eachLimit(insert_object.records, 100, function(record, callback){
        async.waterfall([
            //deconstruct object into seperate peices
            deconstructObject.bind(null, schema, record),
            //insert the row attribute values
            insertObject
        ], function(err, data){
            if(err){
                callback(err);
                return;
            }

            callback();
        });
    }, function(err){
        //TODO handle errors

        callback(null, null);
    });
}

function checkAttributeSchema(insert_object) {
    var attributes = [insert_object.hash_attribute];

    insert_object.records.forEach(function(insert_object){
        for (var property in insert_object) {
            if(attributes.indexOf(property) < 0){
                attributes.push(property);
            }
        }
    });

    attributes.forEach(function(attribute){
        createAttributeFolder(insert_object.schema, insert_object.table, attribute);
    });

    return attributes;
}

function checkPathExists (path) {
    return fs.existsSync(path);
}

function deconstructObject(schema, record, callback) {
    var attribute_array = [];

    async.map(schema.attributes,
        function(attribute, caller){
            createAttributeObject(schema, record, attribute, function(err, attribute_object){
                if(err){
                    caller(err);
                    return;
                }

                attribute_array.push(attribute_object);
                caller();
            });
        },
        function(err, data){
            callback(null, attribute_array);
        }
    );
    /*schema.attributes.forEach(function(attribute){
     if (record.hasOwnProperty(attribute)) {
     attribute_array.push(createAttributeObject(schema, record, attribute));
     }
     });

     callback(null, attribute_array);*/
}

function createAttributeObject(schema, record, attribute_name, callback) {
    var value_stripped = String(record[attribute_name]).replace(/[^0-9a-z]/gi, '').substring(0, 206);
    var attribute_file_name = attribute_name === schema.hash_attribute ? record[schema.hash_attribute] + '.hdb' :
        value_stripped + '-' + schema.date + '-' + record[schema.hash_attribute] + '.hdb';
    var attribute_path = path.join(hdb_path, schema.schema, schema.table, attribute_name, attribute_file_name);

    var attribute = {
        path:attribute_path,
        value:record[attribute_name],
        is_hash:attribute_name === schema.hash_attribute
    };

    callback(null, attribute);
}

function createAttributeFolder(schema, table, attribute_name) {
    var attribute_path = path.join(hdb_path, schema, table, attribute_name);
    if (!checkPathExists(attribute_path)) {
        //need to write new attribute to the hdb_attribute table
        try {
            fs.mkdirSync(attribute_path);
        } catch(e){
            console.log(e);
        }
    }
}

function insertObject(attribute_array, callback) {
    // insert record into /table/attribute/value-timestamp-hash.hdb

    //TODO verify that object has hash attribute defined, if not throw error
    //var start = process.hrtime();
    async.each(attribute_array, function (attribute, callback) {

        createAttributeValueFile(attribute, function (err, data) {
            if (err) {
                callback(err);
                return;
            }

            callback(null, null);
        });
    }, function (err) {
        if(err) {
            console.error(`record ${attribute_array} failed due to: ${err}`);
            callback(err);
            return;
        }
        /*var diff = process.hrtime(start);
         console.log(`Record ${start} took ${(diff[0] * 1e9 + diff[1]) / 1e9} seconds`);*/
        callback(null, null)
    });
}

function createAttributeValueFile(attribute, callback) {
    fs.writeFile(attribute.path, attribute.value, {flag:'wx', encoding:'utf8'}, function (err, data) {
        if (err) {
            if(err.code === 'EEXIST'){
                callback();
            } else {
                callback(err);
            }
            return;
        }

        callback(null, data);
    });
}