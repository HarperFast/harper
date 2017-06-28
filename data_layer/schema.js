const fs = require('fs.extra')
    , validate = require('validate.js')
    , insert = require('./insert.js')
    , async = require('async')
    , table_validation = require('../validation/tableValidator.js')
    , describe_table_validation = require('../validation/describeTableValidator.js')
    , describe_schema_validation = require('../validation/describeSchemaValidation.js')
    , exec = require('child_process').exec
    , search = require('./search.js')
    , uuidV4 = require('uuid/v4')
    , delete_ = require('../data_layer/delete')
    , attribute_validation = require('../validation/attributeInsertValidator.js')
    //this is to avoid a circular dependency with insert.
    // insert needs the describe all function but so does this module.
    // as such the functions have been broken out into a seperate module.
    , schema_describe = require('./schemaDescribe')
    , schema_ops = require('../utility/schema_ops')
    , PropertiesReader = require('properties-reader');
var hdb_properties = PropertiesReader(`${process.cwd()}/../hdb_boot_properties.file`);
hdb_properties.append(hdb_properties.get('settings_path'));


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
        createSchemaStructure(schema_create_object, function (err, success) {
            if (err) {
                callback(err);
                return;
            }
            schema_ops.addToQueue(schema_create_object, function (err, id) {
                if (err) {
                    callback(err);
                    return;
                }
                schema_ops.addToLog(id, function (err) {
                    if (err) {
                        callback(err);
                        return;
                    }
                    callback(null, success);
                    return;


                });
            });
        });
    },
    createSchemaStructure: createSchemaStructure,
    dropSchema: function (drop_schema_object, callback) {

            deleteSchemaStructure(drop_schema_object, function(err, success){
               if(err){
                   callback(err);
                   return;
               }
               schema_ops.addToQueue(drop_schema_object, function(err, id){
                   if(err){
                       callback(err);
                       return;
                   }
                   schema_ops.addToLog(id, function(err){
                      if(err){
                          callback(err);
                          return;
                      }
                      delete global.hdb_schema[drop_schema_object.schema];
                      callback(null, success);
                      return;

                   });

               });
            });




    },
    deleteSchemaStructure: deleteSchemaStructure,

    describeTable: schema_describe.describeTable,

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
           createTableStructure(create_table_object, function(err, success){
             if(err){
                 callback(err);
                 return;
             }
             schema_ops.addToQueue(create_table_object, function(err, id){
                 if(err){
                     callback(err);
                     return
                 }
                 schema_ops.addToLog(id, function(err){
                    if(err){
                        callback(err);
                        return;
                    }

                    callback(null, success);

                 });

             });



           });


    },

    // need to listen to https://nodejs.org/api/events.html#events_event_newlistener for the insert of a file
    // this event will  then call the code below

    createTableStructure: createTableStructure,

    dropTable: function (drop_table_object, callback) {
        deleteTableStrucutre(drop_table_object, function(err, sucess){
           if(err){
               callback(err);
               return;
           }
           schema_ops.addToQueue(drop_table_object, function(err, id){
               if(err){
                   callback(err);
                   return;
               }
               schema_ops.addToQueue(id, function(err){
                   if(err){
                       callback(err);
                       return;
                   }

                   callback(null, sucess);
               });



           });


        });


    },

    // need to listen to https://nodejs.org/api/events.html#events_event_newlistener for the insert of a file
    // this event will  then call the code below

    deleteTableStructure: deleteTableStrucutre,
    createAttribute: function (create_attribute_object, callback) {
        createAttributeStructure(create_attribute_object, function(err, sucess){
            if(err){
                callback(err);
                return;
            }
            schema_ops.addToQueue(create_attribute_object, function(err, id){
                if(err){
                    callback(err);
                    return;
                }
                schema_ops.addToQueue(id, function(err){
                    if(err){
                        callback(err);
                        return;
                    }

                    callback(null, sucess);
                });



            });
        });

    },
    createAttributeStructure: createAttributeStructure,
    describeAll: schema_describe.describeAll
};


function createAttributeStructure(create_attribute_object, callback){
    var validation_error = attribute_validation(create_attribute_object);
    if (validation_error) {
        callback(validation_error, null);
        return;
    }

    var record = {
        schema: create_attribute_object.schema,
        table: create_attribute_object.table,
        attribute: create_attribute_object.attribute,
        id: uuidV4(),
        schema_table: create_attribute_object.schema + '.' + create_attribute_object.table
    };

    var insertObject = {
        operation: 'insert',
        schema: 'system',
        table: 'hdb_attribute',
        hash_attribute: 'id',
        records: [record]
    };

    insert.insert(insertObject, function (err, result) {
        console.log('attribute:' + err);
        console.log(result);
        callback(err, result);
    });
}

function createSchemaStructure(schema_create_object, callback) {


    var validation_error = validate(schema_create_object, schema_constraints);
    if (validation_error) {
        callback(validation_error, null);
        return;
    }

    if (global.hdb_schema[schema_create_object.schema]) {
        callback(`Schema ${schema_create_object.schema} already exists`);
        return;
    }

    var insertObject = {
        operation: 'insert',
        schema: 'system',
        table: 'hdb_schema',
        records: [
            {
                name: schema_create_object.schema,
                createddate: '' + Date.now()
            }
        ]
    };

    insert.insert(insertObject, function (err, result) {
        if (err) {
            callback('Schema exists');
            return;
        }
        console.log('createSchema:' + err);
        var validation_error = validate(schema_create_object, schema_constraints);
        if (validation_error) {
            callback(validation_error, null);
            return;
        }

        var schema = schema_create_object.schema;
        fs.mkdir(hdb_properties.get('HDB_ROOT') + '/schema/' + schema, function (err, data) {
            if (err) {
                if (err.errno == -17) {
                    callback("schema already exists", null);
                    return;

                } else {
                    callback(err.message, null);
                    return;
                }
            }
            callback(err, `schema ${schema_create_object.schema} successfully created`);
            return;


        });


    });
}


function deleteSchemaStructure (drop_schema_object, callback) {

    var validation_error = validate(drop_schema_object, schema_constraints);
    if (validation_error) {
        callback(validation_error, null);
        return;
    }


    var schema = drop_schema_object.schema;




    var delete_schema_object = {"table":"hdb_schema", "schema":"system", "hash_value": schema}

    delete_.delete(delete_schema_object, function(err, data){
        if(err){
            callback(err);
            return;
        }

        var search_obj = {};
        search_obj.schema = 'system';
        search_obj.table = 'hdb_table';
        search_obj.hash_attribute = 'id';
        search_obj.search_attribute = 'schema';
        search_obj.search_value = schema
        search_obj.hash_values = [];
        search_obj.get_attributes = ['id'];

        console.time('searchByValue');
        search.searchByValue(search_obj, function (err, data) {
            if (err){
                callback(err);
                return;

            }
            if(data)
                async.each(data, function (table, caller) {
                    let delete_table_object = {"table":"hdb_table", "schema":"system", "hash_value": table.id}

                    delete_.delete(delete_table_object, function(err, data){
                       if(err){
                           caller(err);
                           retun;
                       }
                       caller();
                    });
                }, function(err) {
                    if(err){
                        callback(err);
                        return;
                    }

                    fs.rmrf(`${hdb_properties.get('HDB_ROOT')}/schema/${schema}/`, function (err) {
                        if (err) {
                            callback(err);
                            return;
                        }

                        callback(null, `successfully delete ${schema}`);



                    });


                });






        });




    });



}

function createTableStructure (create_table_object, callback) {

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

        var table = {
            name: create_table_object.table,
            schema: create_table_object.schema,
            id: uuidV4(),
            hash_attribute: create_table_object.hash_attribute
        };

        var insertObject = {
            operation: 'insert',
            schema: 'system',
            table: 'hdb_table',
            hash_attribute: 'id',
            records: [table]
        };

        insert.insert(insertObject, function (err, result) {
            if (err) {
                callback(err);
                return;
            }

            fs.mkdir(hdb_properties.get('HDB_ROOT') + '/schema/' + create_table_object.schema + '/' + create_table_object.table, function (err, data) {
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

                callback(null, `table ${create_table_object.schema}.${create_table_object.table} successfully created.`);
                return;

            });


        });


    });



}


function deleteTableStrucutre (drop_table_object, callback) {


    // need to add logic to remove files from system tables.
    // TODO remove from global

    var validation_error = validate(drop_table_object, drop_table_constraints);
    if (validation_error) {
        callback(validation_error, null);
        return;
    }


    var schema = drop_table_object.schema;
    var table = drop_table_object.table;
    var search_obj = {};
    search_obj.schema = 'system';
    search_obj.table = 'hdb_table';
    search_obj.hash_attribute = 'id';
    search_obj.search_attribute = 'name';
    search_obj.search_value = drop_table_object.table;
    search_obj.get_attributes = ['name', 'schema', 'id'];
    search.searchByValue(search_obj, function (err, data) {

        if (err) {
            callback(err);
            return;
        }

        var delete_tb = null;
        for (let item in data) {
            if (data[item].name == drop_table_object.table && data[item].schema == drop_table_object.schema) {
                delete_tb = data[item];
            }
        }

        if (delete_tb) {
            var delete_table_object = {
                "table": "hdb_table",
                "schema": "system",
                "hash_attribute": "id",
                "hash_value": delete_tb.id
            }

            delete_.delete(delete_table_object, function (err, data) {
                if(err){
                    callback(err);
                    return;
                }


                var path = `hdb_properties.get('HDB_ROOT')/schema/${schema}/${table}`;

                fs.rmrf(`${hdb_properties.get('HDB_ROOT')}/schema/${schema}/${table}`, function (err) {
                    if (err) {
                        callback(err);
                        return;
                    }

                    callback(null,`successfully deleted ${table}`);
                    return;


                });






            });
        } else {
            callback("Table not found!");
        }


    });



}