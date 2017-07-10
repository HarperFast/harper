//this is to avoid a circular dependency with insert.  insert needs the describe all function but so does the main schema module.  as such the functions have been broken out into a seperate module.

const async = require('async'),
    search = require('./search'),
    winston = require('../utility/logging/winston_logger'),
    describe_table_validation = require('../validation/describeTableValidator.js');


module.exports = {
    describeAll:function (op_obj, callback) {
        try {
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
                    winston.error(err);
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

                    })

                }, function (err, data) {
                    if (err) {
                        callback(err);
                        return;
                    }

                    let hdb_description = {};
                    for (t in t_results) {
                        if (hdb_description[t_results[t].schema] == null) {
                            hdb_description[t_results[t].schema] = {};

                        }

                        hdb_description[t_results[t].schema][t_results[t].name] = t_results[t];


                    }
                    callback(null, hdb_description);

                });


            });

        }catch(e){
            callback(e);
        }
    },
    describeTable: descTable
};

function descTable(describe_table_object, callback) {
    try {
        let validation = describe_table_validation(describe_table_object);
        if (validation) {
            callback(validation);
            return;
        }

        if (describe_table_object.schema == 'system') {
            let global_schema = require('../utility/globalSchema');
            global_schema.setSchemaDataToGlobal(function (err, data) {
                callback(null, global.hdb_schema['system'][describe_table_object.table]);
                return;
            });
        } else {

            let table_search_obj = {};
            table_search_obj.schema = 'system';
            table_search_obj.table = 'hdb_table';
            table_search_obj.hash_attribute = 'id';
            table_search_obj.search_attribute = 'name';
            table_search_obj.search_value = describe_table_object.table;
            table_search_obj.hash_values = [];
            table_search_obj.get_attributes = ['hash_attribute', 'id', 'name', 'schema'];
            let table_result = {};
            search.searchByValue(table_search_obj, function (err, tables) {
                if (err) {
                    winston.error(err);
                    //initialize();
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

                    let attribute_search_obj = {};
                    attribute_search_obj.schema = 'system';
                    attribute_search_obj.table = 'hdb_attribute';
                    attribute_search_obj.hash_attribute = 'id';
                    attribute_search_obj.search_attribute = 'schema_table';
                    attribute_search_obj.search_value = describe_table_object.schema + "." + describe_table_object.table;
                    attribute_search_obj.get_attributes = ['attribute'];


                    search.searchByValue(attribute_search_obj, function (err, attributes) {
                        if (err) {
                            winston.error(err);
                            //initialize();
                            return;
                        }

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