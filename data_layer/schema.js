const fs = require('fs')
    , settings = require('settings')
    , validate = require('validate.js')
    , insert = require('./insert.js')
    , async = require('async')
    , table_validation = require('../validation/tableValidator.js')
    , describe_table_validation = require('../validation/describeTableValidator.js')
    , describe_schema_validation = require('../validation/describeSchemaValidation.js')
    , exec = require('child_process').exec
    , search = require('./search.js')
    , uuidV4 = require('uuid/v4')
    , attribute_validation = require('../validation/attributeInsertValidator.js');


var schema_constraints = {
    schema: {
        presence: true,
        format: "[\\w\\-\\_]+"

    }
};


var drop_table_constraints = {
    schema: {
        presence: true,
        format: "[\\w\\-\\_]+",
        exclusion: {
            within: ["system"],
            message: "You cannot alter the system schema!"
        }

    },

    table: {
        presence: true,
        format: "[\\w\\-\\_]+",

    }
};

module.exports = {
    createSchema: function (schema_create_object, callback) {


        var validation_error = validate(schema_create_object, schema_constraints);
        if (validation_error) {
            callback(validation_error, null);
            return;
        }

        var search_obj = {};
        search_obj.schema = 'system';
        search_obj.table = 'hdb_schema';
        search_obj.hash_attribute = 'name';
        search_obj.hash_value = schema_create_object.schema;
        search_obj.get_attributes = ['name'];
        search.searchByHash(search_obj, function (err, data) {
            if (data && data.length > 1) {
                callback("schema already exsits");
                return;
            }

            var insertObject = {};
            insertObject.schema = "system";
            insertObject.table = 'hdb_schema';
            insertObject.hash_attribute = 'name';
            insertObject.records = [{"name": schema_create_object.schema, "createddate": '' + Date.now()}];
            insert.insert(insertObject, function (err, result) {
                console.log('createSchema:' + err);
                console.log(result);
                callback(err, result);
            });

        });


    },

    // create folder structrue
    createSchemaStructure: function (schema_create_object, callback) {
        var validation_error = validate(schema_create_object, schema_constraints);
        if (validation_error) {
            callback(validation_error, null);
            return;
        }

        var schema = schema_create_object.schema;
        fs.mkdir(settings.HDB_ROOT + '/schema/' + schema, function (err, data) {
            if (err) {
                if (err.errno == -17) {
                    callback("schema already exists", null);
                    return;

                } else {
                    callback(err.message, null);
                    return;
                }
            }
            callback(null, "success");
            return;


        });
    },


    dropSchema: function (drop_schema_object, callback) {


        var validation_error = validate(drop_schema_object, constraints);
        if (validation_error) {
            callback(validation_error, null);
            return;
        }


        var schema = drop_schema_object.schema;


    },

    // need to listen to https://nodejs.org/api/events.html#events_event_newlistener for the insert of a file
    // this event will  then call the code below

    deleteSchemaStructure: function (drop_schema_object, callback) {

        var validation_error = validate(drop_schema_object, schema_constraints);
        if (validation_error) {
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
                if (root)
                    return callback(null, "success");


            } else {
                callback("schema does not exist");
                return;
            }
        }

        deleteFolderRecursive(settings.HDB_ROOT + '/schema/' + schema, true);


    },

    describeTable: descTable,

    describeSchema: function (describe_schema_object, callback) {
        var validation = describe_schema_validation(describe_schema_object);
        if (validation) {
            callback(validation);
            return;
        }

        var table_search_obj = {};
        table_search_obj.schema = 'system';
        table_search_obj.table = 'hdb_table';
        table_search_obj.hash_attribute = 'id';
        table_search_obj.search_attribute = 'schema';
        table_search_obj.search_value = describe_schema_object.schema;
        table_search_obj.hash_values = [];
        table_search_obj.get_attributes = ['hash_attribute', 'id', 'name', 'schema'];
        var table_result = {};
        search.searchByValue(table_search_obj, function (err, tables) {
            if (err) {
                console.error(err);
                //initialize();
                return;
            }


            callback(null, tables);
            return;


        });


    },


    //need to insert record in hdb_table
    // need to insert hash into hdb_attribute
    createTable: function (create_table_object, callback) {

        var validator = table_validation(create_table_object);
        if (validator) {
            callback(validator);
            return;
        }

        var search_obj = {};
        search_obj.schema = 'system';
        search_obj.table = 'hdb_table';
        search_obj.hash_attribute = 'id';
        search_obj.search_attribute = 'name';
        search_obj.search_value = create_table_object.table;
        search_obj.get_attributes = ['name', 'schema'];
        search.searchByValue(search_obj, function (err, data) {
            if (data) {
                for (item in data) {
                    if (data[item].schema == create_table_object.schema) {
                        callback('Table already exists');
                        return;
                    }
                }
            }

            var table = {};
            table.name = create_table_object.table;
            table.schema = create_table_object.schema;
            table.id = uuidV4();
            table.hash_attribute = create_table_object.hash_attribute;
            var insertObject = {};
            insertObject.schema = "system";
            insertObject.table = 'hdb_table';
            insertObject.hash_attribute = 'id';
            insertObject.records = [table];
            insert.insert(insertObject, function (err, result) {
                console.log(err);
                console.log(result);
                callback(err, result);
            });


        });


    },

    // need to listen to https://nodejs.org/api/events.html#events_event_newlistener for the insert of a file
    // this event will  then call the code below

    createTableStructure: function (create_table_object, callback) {
        var validator = table_validation(create_table_object);
        if (validator) {
            callback(validator);
            return;
        }
        fs.mkdir(settings.HDB_ROOT + '/schema/' + create_table_object.schema + '/' + create_table_object.table, function (err, data) {
            if (err) {
                if (err.errno == -2) {
                    callback("schema does not exist", null);
                    return;
                }

                if (err.errno == -17) {
                    callback("table already exists", null);
                    return;

                } else {
                    callback('createTableStrucuture:' + err.message);
                    return
                }
            }

            callback(null, "success");
            return;

        });
    },

    dropTable: function (drop_table_object, callback) {

        // need to add logic to remove files from system tables.

        var validation_error = validate(drop_table_object, drop_table_constraints);
        if (validation_error) {
            callback(validation_error, null);
            return;
        }


        var schema = drop_table_object.schema;
        var table = drop_table_object.table;


    },

    // need to listen to https://nodejs.org/api/events.html#events_event_newlistener for the insert of a file
    // this event will  then call the code below

    deleteTableStructure: function (drop_table_object, callback) {

        var validation_error = validate(drop_table_object, constraints);
        if (validation_error) {
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
                if (root)
                    return callback(null, "success");


            } else {
                callback("table does not exist");
                return;
            }
        }

        if (fs.existsSync(settings.HDB_ROOT + '/schema/' + schema + "/")) {
            var path = settings.HDB_ROOT + '/schema/' + schema + "/" + table;
            deleteFolderRecursive(path, true);
        } else {
            callback("schema does not exist");

        }

    },
    createAttribute: function (create_attribute_object, callback) {

        var validation_error = attribute_validation(create_attribute_object);
        if (validation_error) {
            callback(validation_error, null);
            return;
        }

        var record = {};
        record.schema = create_attribute_object.schema;
        record.table = create_attribute_object.table;
        record.attribute = create_attribute_object.attribute;
        record.id = uuidV4();
        record.schema_table = record.schema + '.' + record.table;

        var insertObject = {};
        insertObject.schema = "system";
        insertObject.table = 'hdb_attribute';
        insertObject.hash_attribute = 'id';
        insertObject.records = [record];
        insert.insert(insertObject, function (err, result) {
            console.log('attribute:' + err);
            console.log(result);
            callback(err, result);
        });
    },
    describeAll: function (callback) {

        var table_search_obj = {};
        table_search_obj.schema = 'system';
        table_search_obj.table = 'hdb_table';
        table_search_obj.hash_attribute = 'id';
        table_search_obj.search_attribute = 'id';
        table_search_obj.search_value = '*';
        table_search_obj.hash_values = [];
        table_search_obj.get_attributes = ['hash_attribute', 'id', 'name', 'schema'];
        search.searchByValue(table_search_obj, function (err, tables) {
            if (err) {
                console.error(err);
                //initialize();
                return;
            }


            var t_results = [];
            async.map(tables, function (table, caller) {
                descTable({"schema": table.schema, "table": table.name}, function (err, desc) {
                    if (err) {
                        caller(err)
                        return;
                    }
                    t_results.push(desc);
                    caller();

                })

            }, function (err, data) {
                if (err) {
                    callback(err);
                    return;
                }

                var hdb_description = {};
                for (t in t_results) {
                    if (hdb_description[t_results[t].schema] == null) {
                        hdb_description[t_results[t].schema] = {};

                    }

                    hdb_description[t_results[t].schema][t_results[t].name] = t_results[t];



                }
                callback(null, hdb_description);

            });


        });


    }
};

function descTable(describe_table_object, callback) {
    var validation = describe_table_validation(describe_table_object);
    if (validation) {
        callback(validation);
        return;
    }

    var table_search_obj = {};
    table_search_obj.schema = 'system';
    table_search_obj.table = 'hdb_table';
    table_search_obj.hash_attribute = 'id';
    table_search_obj.search_attribute = 'name';
    table_search_obj.search_value = describe_table_object.table;
    table_search_obj.hash_values = [];
    table_search_obj.get_attributes = ['hash_attribute', 'id', 'name', 'schema'];
    var table_result = {};
    search.searchByValue(table_search_obj, function (err, tables) {
        if (err) {
            console.error(err);
            //initialize();
            return;
        }

        async.map(tables, function (table, caller) {
            if (table.schema == describe_table_object.schema) {
                table_result = table;
            }
            caller();

        }, function (err, data) {
            if (err) {
                callback(err);
                return;
            }

            var attribute_search_obj = {};
            attribute_search_obj.schema = 'system';
            attribute_search_obj.table = 'hdb_attribute';
            attribute_search_obj.hash_attribute = 'id';
            attribute_search_obj.search_attribute = 'schema_table';
            attribute_search_obj.search_value = describe_table_object.schema + "." + describe_table_object.table;
            attribute_search_obj.get_attributes = ['attribute'];


            search.searchByValue(attribute_search_obj, function (err, attributes) {
                if (err) {
                    console.error(err);
                    //initialize();
                    return;
                }

                table_result.attributes = attributes
                callback(null, table_result);


            });

        });


    });


}