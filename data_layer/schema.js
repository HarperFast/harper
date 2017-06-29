const fs = require('fs-extra')
    , validate = require('validate.js')
    , insert = require('./insert.js')
    , async = require('async')
    , table_validation = require('../validation/tableValidator.js')
    , attribute_validation = require('../validation/attributeInsertValidator')
    , describe_schema_validation = require('../validation/describeSchemaValidation.js')
    , search = require('./search.js')
    , uuidV4 = require('uuid/v4')
    , delete_ = require('../data_layer/delete')
    //this is to avoid a circular dependency with insert.
    // insert needs the describe all function but so does this module.
    // as such the functions have been broken out into a seperate module.
    , schema_describe = require('./schemaDescribe')
    , schema_ops = require('../utility/schema_ops')
    , PropertiesReader = require('properties-reader');
let hdb_properties = PropertiesReader(`${process.cwd()}/../hdb_boot_properties.file`);
hdb_properties.append(hdb_properties.get('settings_path'));


let schema_constraints = {
    schema: {
        presence: true,
        format: "[\\w\\-\\_]+"

    }
};


let drop_table_constraints = {
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
    createSchema: createSchema,
    createSchemaStructure: createSchemaStructure,
    dropSchema: dropSchema,
    deleteSchemaStructure: deleteSchemaStructure,
    describeTable: schema_describe.describeTable,
    describeSchema: describeSchema,
    createTable: createTable,
    createTableStructure: createTableStructure,
    dropTable: dropTable,
    deleteTableStructure: deleteTableStrucutre,
    createAttribute: createAttribute,
    createAttributeStructure: createAttributeStructure,
    dropAttribute: dropAttribute,
    describeAll: schema_describe.describeAll
};


/** schema methods **/

function createSchema  (schema_create_object, callback) {
    createSchemaStructure(schema_create_object, function (err, success) {
        if (err) {
            callback(err);
            return;
        }

        addAndRemoveFromQueue(schema_create_object, success, callback);
    });
}

function dropSchema (drop_schema_object, callback) {

    deleteSchemaStructure(drop_schema_object, function(err, success){
        if(err){
            callback(err);
            return;
        }
        delete global.hdb_schema[drop_schema_object.schema];
        addAndRemoveFromQueue(drop_schema_object, success, callback);
    });

}

function describeSchema (describe_schema_object, callback) {
    let validation = describe_schema_validation(describe_schema_object);
    if (validation) {
        callback(validation);
        return;
    }

    let table_search_obj = {};
    table_search_obj.schema = 'system';
    table_search_obj.table = 'hdb_table';
    table_search_obj.hash_attribute = 'id';
    table_search_obj.search_attribute = 'schema';
    table_search_obj.search_value = describe_schema_object.schema;
    table_search_obj.hash_values = [];
    table_search_obj.get_attributes = ['hash_attribute', 'id', 'name', 'schema'];
    let table_result = {};
    search.searchByValue(table_search_obj, function (err, tables) {
        if (err) {
            console.error(err);
            callback(err);
            return;
        }
        callback(null, tables);
    });
}

function createSchemaStructure(schema_create_object, callback) {


    let validation_error = validate(schema_create_object, schema_constraints);
    if (validation_error) {
        callback(validation_error, null);
        return;
    }

    if (global.hdb_schema[schema_create_object.schema]) {
        callback(`Schema ${schema_create_object.schema} already exists`);
        return;
    }

    let insertObject = {
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
            callback(err);
            return;
        }


        let schema = schema_create_object.schema;
        fs.mkdir(hdb_properties.get('HDB_ROOT') + '/schema/' + schema, function (err, data) {
            if (err) {
                if (err.errno === -17) {
                    callback("schema already exists", null);
                    return;

                } else {
                    callback(err.message, null);
                    return;
                }
            }
            callback(err, `schema ${schema_create_object.schema} successfully created`);
        });


    });
}

function deleteSchemaStructure (drop_schema_object, callback) {

    let validation_error = validate(drop_schema_object, schema_constraints);
    if (validation_error) {
        callback(validation_error, null);
        return;
    }


    let schema = drop_schema_object.schema;




    let delete_schema_object = {"table":"hdb_schema", "schema":"system", "hash_value": schema};

    delete_.delete(delete_schema_object, function(err, data){
        if(err){
            callback(err);
            return;
        }

        let search_obj = {};
        search_obj.schema = 'system';
        search_obj.table = 'hdb_table';
        search_obj.hash_attribute = 'id';
        search_obj.search_attribute = 'schema';
        search_obj.search_value = schema;
        search_obj.hash_values = [];
        search_obj.get_attributes = ['id'];
        search.searchByValue(search_obj, function (err, tables) {
            if (err){
                callback(err);
                return;

            }
            if(tables && tables.length > 0) {
                let delete_table_object = {"table": "hdb_table", "schema": "system", "hash_values": []};
                for(t in tables){
                    delete_table_object.hash_values.push(tables[t].id);

                }

                delete_.bulkDelete(delete_table_object, function (err, data) {
                    if (err) {
                        callback(err);
                        return;
                    }

                    fs.rmrf(`${hdb_properties.get('HDB_ROOT')}/schema/${schema}/`, function (err) {
                        if (err) {
                            callback(err);
                            return;
                        }

                        deleteAttributeStructure(drop_schema_object, function(err, data){

                            if(err){
                                callback(err);
                                return;
                            }

                            callback(null, `successfully delete ${schema}`);
                        });
                    });

                });

            }else{
                callback(null, `Schema ${delete_schema_object.schea} successfully deleted.`)
            }
        });
    });



}

/** table methods **/

function createTableStructure (create_table_object, callback) {

    let validator = table_validation(create_table_object);
    if (validator) {
        callback(validator);
        return;
    }

    let search_obj = {};
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

        let table = {
            name: create_table_object.table,
            schema: create_table_object.schema,
            id: uuidV4(),
            hash_attribute: create_table_object.hash_attribute
        };

        let insertObject = {
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
                    if (err.errno === -2) {
                        callback("schema does not exist", null);
                        return;
                    }

                    if (err.errno === -17) {
                        callback("table already exists", null);
                        return;

                    } else {
                        callback('createTableStrucuture:' + err.message);
                        return
                    }
                }

                callback(null, `table ${create_table_object.schema}.${create_table_object.table} successfully created.`);
            });


        });


    });



}

function deleteTableStrucutre (drop_table_object, callback) {
    let validation_error = validate(drop_table_object, drop_table_constraints);
    if (validation_error) {
        callback(validation_error, null);
        return;
    }
    let schema = drop_table_object.schema;
    let table = drop_table_object.table;
    let search_obj = {};
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

        let delete_tb = null;
        for (let item in data) {
            if (data[item].name == drop_table_object.table && data[item].schema == drop_table_object.schema) {
                delete_tb = data[item];
            }
        }

        if (delete_tb) {
            let delete_table_object = {
                "table": "hdb_table",
                "schema": "system",
                "hash_attribute": "id",
                "hash_value": delete_tb.id
            };

            delete_.delete(delete_table_object, function (err, data) {
                if(err){
                    callback(err);
                    return;
                }


                let path = `hdb_properties.get('HDB_ROOT')/schema/${schema}/${table}`;

                fs.rmrf(`${hdb_properties.get('HDB_ROOT')}/schema/${schema}/${table}`, function (err) {
                    if (err) {
                        callback(err);
                        return;
                    }

                    deleteAttributeStructure(drop_table_object, function(err, data){

                        if(err){
                            callback(err);
                            return;
                        }

                        callback(null,`successfully deleted ${table}`);
                    });



                });






            });
        } else {
            callback("Table not found!");
        }


    });



}

function createTable (create_table_object, callback) {
    createTableStructure(create_table_object, function(err, success){
        if(err){
            callback(err);
            return;
        }
        addAndRemoveFromQueue(create_table_object, success, callback);

    });


}

function dropTable (drop_table_object, callback) {
    deleteTableStrucutre(drop_table_object, function(err, sucess){
        if(err){
            callback(err);
            return;
        }
        addAndRemoveFromQueue(drop_table_object, sucess, callback);

    });

}

/*** attribute methods **/

function createAttributeStructure(create_attribute_object, callback){
    let validation_error = attribute_validation(create_attribute_object);
    if (validation_error) {
        callback(validation_error, null);
        return;
    }

    let record = {
        schema: create_attribute_object.schema,
        table: create_attribute_object.table,
        attribute: create_attribute_object.attribute,
        id: uuidV4(),
        schema_table: create_attribute_object.schema + '.' + create_attribute_object.table
    };

    let insertObject = {
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

function deleteAttributeStructure(attribute_drop_object, callback){


    let search_obj = {};
    search_obj.schema = 'system';
    search_obj.table = 'hdb_attribute';
    search_obj.hash_attribute = 'id';
    search_obj.get_attributes = ['id', 'attribute'];

    if(attribute_drop_object.table && attribute_drop_object.schema){
        search_obj.search_attribute = 'schema_table';
        search_obj.search_value = `${attribute_drop_object.schema}.${attribute_drop_object.table}`;
    }else if(attribute_drop_object.schema){
        search_obj.search_attribute = 'schema';
        search_obj.search_value = `${attribute_drop_object.schema}`;
    }else{
        callback('attribute drop requires table and or schema.');
        return;
    }

    search.searchByValue(search_obj, function(err, attributes){
        if(err){
            callback(err);
            return;
        }

        if(attributes && attributes.length > 0){
            let delete_table_object = {"table": "hdb_attribute", "schema": "system", "hash_values": []};
            for(att in attributes){
                if((attribute_drop_object.attribute && attribute_drop_object.attribute == attributes[att].attribute)
                    || !attribute_drop_object.attribute ){

                    delete_table_object.hash_values.push(attributes[att].id);
                }


            }

            delete_.bulkDelete(delete_table_object, function(err, success){
                if(err){
                    callback(err);
                    return;
                }

                callback(null, `succesfully deleted ${delete_table_object.hash_values.length} attributes`);

            });


        }else{
            callback(null, null);
        }


    });




}

function createAttribute (create_attribute_object, callback) {
    createAttributeStructure(create_attribute_object, function(err, sucess){
        if(err){
            callback(err);
            return;
        }
        addAndRemoveFromQueue(create_attribute_object, success, callback);

    });

}

function dropAttribute (drop_attribute_object, callback){
    let validation_error = attribute_validation(create_attribute_object);
    if (validation_error) {
        callback(validation_error, null);
        return;
    }
    deleteAttributeStructure(drop_attribute_object, function(err, sucess){
        if(err){
            callback(err);
            return;
        }
        addAndRemoveFromQueue(drop_attribute_object, sucess, callback);
    });

}


/**** utility methods **/

function addAndRemoveFromQueue(ops_object, success_message, callback){
    schema_ops.addToQueue(ops_object, function(err, id){
        if(err){
            callback(err);
            return;
        }
        schema_ops.addToQueue(id, function(err){
            if(err){
                callback(err);
                return;
            }

            callback(null, success_message);
        });



    });
}
