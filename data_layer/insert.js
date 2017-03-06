const insert_validator = require('../validation/insertValidator.js'),
    fs = require('fs'),
    async = require('async'),
    path = require('path'),
    settings = require('settings'),
    hidefile = require('hidefile'),
    glob = require('glob');

const hdb_path = path.join(settings.PROJECT_DIR, '/hdb/schema');

module.exports = {
    insert: function (insert_object, callback) {
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
        checkAttributeSchema(insert_object);

        insertRecords(insert_object, function(err, data){
            callback();
        });

    }
};

function insertRecords(insert_object, callback){
    var schema = {
        schema:insert_object.schema,
        table:insert_object.table,
        hash_attribute: insert_object.hash_attribute
    };
    async.each(insert_object.records, function(record, callback){
        //deconstruct object into seperate peices
        var attribute_array = deconstructObject(schema, record);

        insertObject(attribute_array);
    }, function(err){
        //TODO handle errors
        callback();
    });
}

function checkAttributeSchema(insert_object) {
    var attributes = [insert_object.hash_attribute];

    insert_object.records.forEach(function(insert_object){
        for (var property in insert_object.object) {
            if(attributes.indexOf(property) < 0){
                attributes.push(property);
            }
        }
    });

    attributes.forEach(function(attribute){
        createAttributeFolder(insert_object.schema, insert_object.table, attribute);
    });
}

function checkPathExists (path) {
    return fs.existsSync(path);
}

function deconstructObject(schema, record) {
    var attribute_array = [];

    //add hash
    attribute_array.push(createAttributeObject(schema, record, schema.hash_attribute));

    for (var property in record.object) {
        if (record.object.hasOwnProperty(property)) {
            attribute_array.push(createAttributeObject(schema, record, property));
        }
    }

    return attribute_array;
}

function createAttributeObject(schema, record, attribute_name) {
    var attribute_object = {
        schema: schema.schema,
        table: schema.table,
        attribute_name: attribute_name,
        attribute_value: attribute_name === schema.hash_attribute ? record.hash_value : record.object[attribute_name],
        hash_value: record.hash_value,
        is_hash: attribute_name === schema.hash_attribute ? true : false
    };

    return attribute_object;
}

function createAttributeFolder(schema, table, attribute_name) {
    var attribute_path = path.join(hdb_path, schema, table, attribute_name);
    if (!checkPathExists(attribute_path)) {
        //need to write new attribute to the hdb_attribute table
        fs.mkdirSync(attribute_path);
    }
}

function insertObject(attribute_array) {
    //if attribute is new create atribute folder

    // insert record into /table/attribute/value-timestamp-hash.hdb

    async.each(attribute_array, function (attribute, callback) {
        //compare object attributes to known schema, if new attributes add to system.hdb_attribute table
        var attribute_path = path.join(hdb_path, attribute.schema, attribute.table, attribute.attribute_name);
        if (!checkPathExists(attribute_path)) {
            //need to write new attribute to the hdb_attribute table
            fs.mkdirSync(attribute_path);
        }
        createAttributeValueFile(attribute, function (err, data) {
            if (err) {
                callback(err);
            } else {
                //TODO mark pre - existing attribute value file for grep exclusion
                callback();
            }
        });
    }, function (err) {

    });
}

function createAttributeValueFile(attribute, callback) {
    var attribute_path = path.join(hdb_path, attribute.schema, attribute.table, attribute.attribute_name) + '/';

    var value_stripped = String(attribute.attribute_value).replace(/[^0-9a-z]/gi, '').substring(0, 206);
    var attribute_file_name = attribute.is_hash ? attribute.hash_value + '.hdb' :
        value_stripped + '-' + new Date().getTime() + '-' + attribute.hash_value + '.hdb';
    fs.writeFile(attribute_path + attribute_file_name, attribute.attribute_value, function (err, data) {
        if (err) {
            callback(err);
        } else {
            if(!attribute.is_hash) {
                glob('*-' + attribute.hash_value + '.hdb', {cwd: attribute_path}, function (err, d) {
                    if (err) {
                        console.error(err);
                    } else {
                        if(d.length > 0) {
                            console.log(d.sort(sortByDate));
                            //  d.forEach(function)
                        }
                    }
                });
            }
            callback(data);

        }
    });
}

function sortByDate(a,b) {
    a_date = Number(a.split('-')[1]);
    b_date = Number(b.split('-')[1]);
    return a_date>b_date ? -1 : a<b ? 1 : 0;
}