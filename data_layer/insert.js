const insert_validator = require('../validation/insertValidator.js'),
    fs = require('fs'),
    async = require('async'),
    path = require('path'),
    settings = require('settings');

const hdb_path = settings.PROJECT_DIR + '\\hdb\\schema';
module.exports = {
    insert: function (insert_object, callback) {
        //validate insert_object for required attributes
        var validator = insert_validator(insert_object);
        if (validator) {
            callback(validator);
            return;
        }

        //check if schema / table directories exist
        var table_path = hdb_path + '\\' + insert_object.schema + '\\' + insert_object.table;
        if (!this.checkPathExists(table_path)) {
            callback('Table: ' + insert_object.schema + '.' + insert_object.table + ' does not exist');
            return;
        }

        //verify hash_attribute is correct for this table

        //deconstruct object into seperate peices
        var attribute_array = this.deconstructObject(insert_object);
        console.log(attribute_array);
        this.insertObject(attribute_array);

        callback();
    },
    checkPathExists: function (path) {
        return fs.existsSync(path);
    },

    deconstructObject: function (insert_object) {
        var attribute_array = [];

        //add hash
        attribute_array.push(this.createAttributeObject(insert_object, insert_object.hash_attribute));

        for (var property in insert_object.object) {
            if (insert_object.object.hasOwnProperty(property)) {
                attribute_array.push(this.createAttributeObject(insert_object, property));
            }
        }

        return attribute_array;
    },

    createAttributeObject: function (insert_object, attribute_name) {
        var attribute_object = {
            schema: insert_object.schema,
            table: insert_object.table,
            attribute_name: attribute_name,
            attribute_value: attribute_name === insert_object.hash_attribute ? insert_object.hash_value : insert_object.object[attribute_name],
            hash_value: insert_object.hash_value,
            is_hash: attribute_name === insert_object.hash_name ? true : false
        };

        return attribute_object;
    },

    checkAttributeSchema: function (attribute) {
        var attribute_path = hdb_path + '\\' + attribute.schema + '\\' + attribute.table + '\\' + attribute.attribute_name;
        if (!this.checkPathExists(attribute_path)) {
            //need to write new attribute to the hdb_attribute table
            fs.mkdirSync(attribute_path);
        }
    },

    insertObject: function (attribute_array) {
        //if attribute is new create atribute folder
        console.log(attribute_array);
        // insert record into /table/attribute/value-timestamp-hash.hdb
        var checkPathExists = this.checkPathExists;
        var createAttributeValueFile = this.createAttributeValueFile;
        async.each(attribute_array, function (attribute, callback) {
            //compare object attributes to known schema, if new attributes add to system.hdb_attribute table
            var attribute_path = hdb_path + '\\' + attribute.schema + '\\' + attribute.table + '\\' + attribute.attribute_name;
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
    },

    createAttributeValueFile: function (attribute, callback) {
        var attribute_path = hdb_path + '\\' + attribute.schema + '\\' + attribute.table + '\\' + attribute.attribute_name + '\\';

        var value_stripped = attribute.attribute_value.replace(/[^0-9a-z]/gi, '').substring(0, 206);
        var attribute_file_name = attributevalue_stripped + '-' + new Date().getTime() + '-' + attribute.hash_value + '.hdb';
        fs.writeFile(attribute_path + attribute_file_name, attribute.attribute_value, function (err, data) {
            if (err) {
                callback(err);
            } else {
                callback(data);
            }
        });
    }
};