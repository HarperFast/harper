const insert_validator = require('../validation/insertValidator.js'),
    fs = require('fs'),
    async = require('async'),
    path = require('path'),
    settings = require('settings'),
    hidefile = require('hidefile'),
    glob = require('glob');

const relative_path = path.relative(__dirname, settings.PROJECT_DIR);
const hdb_path = relative_path + '/hdb/schema';

module.exports = {
    bulkInsert:function(insert_array, callback){
        var insert = this.insert;
        insert_array.forEach(function(insert_object){
            insert(insert_object, function(err, data){
                if(err){
                    callback(err);
                    return;
                }
                callback();
            });
        });
    },
    insert: function (insert_object, callback) {
        //validate insert_object for required attributes
        var validator = insert_validator(insert_object);
        if (validator) {
            callback(validator);
            return;
        }

        //check if schema / table directories exist
        var table_path = hdb_path + '/' + insert_object.schema + '/' + insert_object.table;
        if (!checkPathExists(table_path)) {
            callback('Table: ' + insert_object.schema + '.' + insert_object.table + ' does not exist');
            return;
        }

        //verify hash_attribute is correct for this table

        //deconstruct object into seperate peices
        var attribute_array = deconstructObject(insert_object);

        insertObject(attribute_array);

        callback();
    }
};

function checkPathExists (path) {
    return fs.existsSync(path);
}

function deconstructObject(insert_object) {
    var attribute_array = [];

    //add hash
    attribute_array.push(createAttributeObject(insert_object, insert_object.hash_attribute));

    for (var property in insert_object.object) {
        if (insert_object.object.hasOwnProperty(property)) {
            attribute_array.push(createAttributeObject(insert_object, property));
        }
    }

    return attribute_array;
}

function createAttributeObject(insert_object, attribute_name) {
    var attribute_object = {
        schema: insert_object.schema,
        table: insert_object.table,
        attribute_name: attribute_name,
        attribute_value: attribute_name === insert_object.hash_attribute ? insert_object.hash_value : insert_object.object[attribute_name],
        hash_value: insert_object.hash_value,
        is_hash: attribute_name === insert_object.hash_attribute ? true : false
    };

    return attribute_object;
}

function checkAttributeSchema(attribute) {
    var attribute_path = hdb_path + '/' + attribute.schema + '/' + attribute.table + '/' + attribute.attribute_name;
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
        var attribute_path = hdb_path + '/' + attribute.schema + '/' + attribute.table + '/' + attribute.attribute_name;
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
    var attribute_path = hdb_path + '/' + attribute.schema + '/' + attribute.table + '/' + attribute.attribute_name + '/';

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
                        console.log(d);
                      //  d.forEach(function)

                    }
                });
            }
            callback(data);

        }
    });
}