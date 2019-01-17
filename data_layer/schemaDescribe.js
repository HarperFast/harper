//this is to avoid a circular dependency with insert.  insert needs the describe all function but so does the main schema module.  as such the functions have been broken out into a seperate module.

const async = require('async'),
    search = require('./search'),
    logger = require('../utility/logging/harper_logger'),
    validator = require('../validation/schema_validator'),
    _ = require('lodash');


module.exports = {
    describeAll:function (op_obj, callback) {
        try {
            let schema_search = {};
            schema_search.schema = 'system';
            schema_search.table = 'hdb_schema';
            schema_search.hash_attribute = 'name';
            schema_search.search_attribute = 'name';
            schema_search.search_value = '*';
            schema_search.hash_values = [];
            schema_search.get_attributes = ['name'];
            search.searchByValue(schema_search, function(err, schemas){

                let schema_list = {};
                for(let s in schemas){
                    schema_list[schemas[s].name] = true;
                }


                let table_search_obj = {};
                table_search_obj.schema = 'system';
                table_search_obj.table = 'hdb_table';
                table_search_obj.hash_attribute = 'id';
                table_search_obj.search_attribute = 'id';
                table_search_obj.search_value = '*';
                table_search_obj.hash_values = [];
                table_search_obj.get_attributes = ['hash_attribute', 'id', 'name', 'schema'];
                search.searchByValue(table_search_obj, function (err, tables) {
                    if (err) {
                        logger.error(err);
                        //initialize();
                        return;
                    }


                    let t_results = [];
                    async.map(tables, function (table, caller) {
                        descTable({"schema": table.schema, "table": table.name}, function (err, desc) {
                            if (err) {

                                caller(err);
                                return;
                            }
                            t_results.push(desc);
                            caller();

                        });

                    }, function (err, data) {
                        if (err) {
                            callback(err);
                            return;
                        }

                        let hdb_description = {};
                        for (let t in t_results) {
                            if (hdb_description[t_results[t].schema] == null) {
                                hdb_description[t_results[t].schema] = {};

                            }

                            hdb_description[t_results[t].schema][t_results[t].name] = t_results[t];
                            if(schema_list[t_results[t].schema]){
                                delete schema_list[t_results[t].schema];
                            }

                        }

                        for(let schema in schema_list){
                            hdb_description[schema] = {};
                        }
                        callback(null, hdb_description);

                    });

                });
            });


        }catch(e){
            callback(e);
        }
    },
    describeTable: descTable,
    describeSchema(describe_schema_object, callback) {
    try {
        let validation_msg = validator.schema_object(describe_schema_object);
        if (validation_msg) {
            callback(validation_msg);
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
                logger.error(err);
                callback(err);
                return;
            }
            if (tables && tables.length < 1) {

                let schema_search_obj = {};
                schema_search_obj.schema = 'system';
                schema_search_obj.table = 'hdb_schema';
                schema_search_obj.hash_attribute = 'name';
                schema_search_obj.hash_values = [describe_schema_object.schema];
                schema_search_obj.get_attributes = ['name'];

                search.searchByHash(schema_search_obj, function (err, schema) {
                    if (err) {
                        logger.error(err);
                        callback(err);
                        return;
                    }
                    if(schema && schema.length < 1){
                        return callback('schema not found');

                    }else{
                        return callback(null, {});

                    }
                });



            }else{
                let results = [];
                async.map(tables, function (table, caller) {
                    descTable({"schema": describe_schema_object.schema, "table":table.name}, function(err, data){
                       if(err){
                            caller(err);
                       }

                        results.push(data);
                       caller();
                    });

                },function(err, data){
                    return callback(null, results);

                });

            }
        });
    } catch (e) {
        callback(e);
    }
}
};

function descTable(describe_table_object, callback) {
    try {
        let validation = validator.describe_table(describe_table_object);
        if (validation) {
            callback(validation);
            return;
        }

        if (describe_table_object.schema == 'system') {
            //let global_schema = require('../utility/globalSchema');
            //global_schema.setSchemaDataToGlobal(function (err, data) {
                return global.hdb_schema['system'][describe_table_object.table];
        } else {

            let table_search_obj = {};
            table_search_obj.schema = 'system';
            table_search_obj.table = 'hdb_table';
            table_search_obj.hash_attribute = 'id';
            table_search_obj.search_attribute = 'name';
            table_search_obj.search_value = describe_table_object.table;
            table_search_obj.hash_values = [];
            table_search_obj.get_attributes = ['*'];
            let table_result = {};
            search.searchByValue(table_search_obj, function (err, tables) {
                if (err) {
                    logger.error(err);
                    return;
                }

                async.map(tables, function (table, caller) {
                    if (table.schema === describe_table_object.schema) {
                        table_result = table;
                    }
                    caller();

                }, function (err, data) {
                    if (err) {
                        callback(err);
                        return;
                    }

                    if(!table_result.hash_attribute){
                        return callback("Invalid table");
                    }

                    let attribute_search_obj = {};
                    attribute_search_obj.schema = 'system';
                    attribute_search_obj.table = 'hdb_attribute';
                    attribute_search_obj.hash_attribute = 'id';
                    attribute_search_obj.search_attribute = 'schema_table';
                    attribute_search_obj.search_value = describe_table_object.schema + "." + describe_table_object.table;
                    attribute_search_obj.get_attributes = ['attribute'];


                    search.searchByValue(attribute_search_obj, function (err, attributes) {
                        if (err) {
                            logger.error(err);
                            //initialize();
                            return;
                        }

                        //need to remove possible dups
                        attributes = _.uniqBy(attributes, (attribute)=>{
                            return attribute.attribute;
                        });

                        table_result.attributes = attributes;
                        callback(null, table_result);


                    });

                });


            });
        }
    }catch(e){
        callback(e);
    }
}