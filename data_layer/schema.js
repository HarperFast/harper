const fs = require('fs');
var settings = require('settings');
var path = require('path');
const base_path =path.join(settings.HDB_ROOT, "hdb/schema/");
const validate = require('validate.js');
const insert = require('./insert.js');
const table_validation = require('../validation/table_validation.js');
const exec = require('child_process').exec;




var schema_constraints = {
    schema: {
        presence: true,
        format: "[\\w\\-\\_]+"

    }
};



var drop_table_constraints = {
    schema : {
        presence : true,
        format: "[\\w\\-\\_]+",
        exclusion: {
            within: ["system"],
            message: "You cannot alter the system schema!"
        }

    },

    table : {
        presence : true,
        format: "[\\w\\-\\_]+",

    }
};

module.exports = {
    createSchema: function(schema_create_object, callback) {


        var validation_error = validate(schema_create_object, schema_constraints);
        if (validation_error) {
            callback(validation_error, null);
            return;
        }

        var insertObject = {};
        insertObject.schema = "system";
        insertObject.table = 'hdb_schema';
        insertObject.hash_attribute = 'name';
        insertObject.records = [{"name": schema_create_object.schema}];
        insert.insert(insertObject, function (err, result) {
            console.log(err);
            console.log(result);
            callback(err, result);
        });


    },

    // create folder structrue
    createSchemaStructure: function(schema_create_object, callback){
        var validation_error = validate(schema_create_object, constraints);
        if (validation_error) {
            callback(validation_error, null);
            return;
        }

        var schema = schema_create_object.schema;
        fs.mkdir(base_path + schema, function(err, data){
            if(err){
                if(err.errno == -17){
                    callback("schema already exists", null);
                    return;

                }else{
                    callback(err.message, null);
                    return;
                }
            }
            callback(null, "success");
            return;


        });
    },


    dropSchema: function(drop_schema_object, callback) {



        var validation_error = validate(drop_schema_object, constraints);
        if(validation_error){
            callback(validation_error, null);
            return;
        }


        var schema = drop_schema_object.schema;




    },

    // need to listen to https://nodejs.org/api/events.html#events_event_newlistener for the insert of a file
    // this event will  then call the code below

    deleteSchemaStructure: function(drop_schema_object, callback) {

        var validation_error = validate(drop_schema_object, constraints);
        if(validation_error){
            callback(validation_error, null);
            return;
        }


        var schema = drop_schema_object.schema;



        var deleteFolderRecursive = function (path, root) {
            if (fs.existsSync(path)) {
                fs.readdirSync(path).forEach(function (file, index) {
                    var curPath = path + "/" + file;
                    if (fs.lstatSync(curPath).isDirectory()) { // recurse
                        deleteFolderRecursive(curPath, false);
                    } else { // delete file
                        fs.unlinkSync(curPath);
                    }
                });

                fs.rmdirSync(path);
                if(root)
                    return callback(null, "success");


            }else{
                callback("schema does not exist");
                return;
            }
        }
        var path = base_path + schema;
        deleteFolderRecursive(path, true);


    }, 
    
    describeTable: function(describe_table_object, callback){
        var table_path = path.join(base_path, describe_table_object.schema +'/' + describe_table_object.table);
        exec('ls ' + table_path, function (error, stdout, stderr) {
            if(stderr){
                callback(stderr);
                return;
            }
            var result = {};
            result.schema = describe_table_object.schema;
            result.table = describe_table_object.table;
            result.attibutes = stdout.split('\n');
            result.attibutes.splice(result.attibutes.length -1, 1);
            callback(null, result);
            return;




        });
        
    },



    //need to insert record in hdb_table
    // need to insert hash into hdb_attribute
    insertTable: function (create_table_object, callback) {

        var validator = table_validation(create_table_object);
        if (validator) {
            callback(validator);
            return;
        }
        var table = {};
        table.name = create_table_object.table;
        table.schema = create_table_object.schema;
        table.schema_name = create_table_object.schema + "." + create_table_object.table;
        table.hash_attribute = create_table_object.hash_attribute;
        var insertObject = {};
        insertObject.schema = "system";
        insertObject.table = 'hdb_table';
        insertObject.hash_attribute = 'schema_name';
        insertObject.records = [table];
        insert.insert(insertObject, function (err, result) {
            console.log(err);
            console.log(result);
            callback(err, result);
        });


    },

    // need to listen to https://nodejs.org/api/events.html#events_event_newlistener for the insert of a file
    // this event will  then call the code below

    createTable: function (create_table_object, callback) {
        var validator = table_validation(create_table_object);
        if (validator) {
            callback(validator);
            return;
        }
        fs.mkdir(base_path + create_table_object.schema + '/' + create_table_object.table, function (err, data) {
            if (err) {
                if (err.errno == -2) {
                    callback("schema does not exist", null);
                    return;
                }

                if (err.errno == -17) {
                    callback("table already exists", null);
                    return;

                } else {
                    return err.message;
                }
            }

            callback(null, "success");
            return;

        });
    },

    dropTable:   function (drop_table_object, callback)
    {

        // need to add logic to remove files from system tables.

        var validation_error = validate(drop_table_object, drop_table_constraints);
        if(validation_error){
            callback(validation_error, null);
            return;
        }


        var schema = drop_table_object.schema;
        var table = drop_table_object.table;



    },

    // need to listen to https://nodejs.org/api/events.html#events_event_newlistener for the insert of a file
    // this event will  then call the code below

    deleteTableStructure:   function  (drop_table_object, callback) {

        var validation_error = validate(drop_table_object, constraints);
        if(validation_error){
            callback(validation_error, null);
            return;
        }


        var schema = drop_table_object.schema;
        var table = drop_table_object.table;

        var deleteFolderRecursive = function (path, root) {
            if (fs.existsSync(path)) {
                fs.readdirSync(path).forEach(function (file, index) {
                    var curPath = path + "/" + file;
                    if (fs.lstatSync(curPath).isDirectory()) { // recurse
                        deleteFolderRecursive(curPath, false);
                    } else { // delete file
                        fs.unlinkSync(curPath);
                    }
                });

                fs.rmdirSync(path);
                if(root)
                    return callback(null, "success");


            }else{
                callback("table does not exist");
                return;
            }
        }

        if (fs.existsSync(base_path + schema + "/")) {
            var path = base_path + schema + "/" + table;
            deleteFolderRecursive(path, true);
        }else{
            callback("schema does not exist");

        }

    }


};

