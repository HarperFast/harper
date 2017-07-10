var schema = require('../data_layer/schema.js');

var schema_value = 'dev';
var table = 'person';

// author sgeezy
function describeSchema(schema_val){
    schema.describeSchema ({"schema":schema_val}, function(err, result){
            winston.info(result);
    });
}



function deleteTest(delete_obj, callback){
    schema.dropTable({schema: delete_obj.schema, table: delete_obj.table}, function (err, result) {
        if (err) {
            callback(err);
        } else {

            schema.dropSchema({schema: delete_obj.schema}, function (err, result) {
                if (err) {
                    callback(err);
                } else {
                    callback(null, result);
                }


            });
        }

    });
}



function fullTest(callback) {


    createTest(function (err, result) {
        if (err) {
            callback(err);

        } else {
            schema.dropTable({schema: result.schema, table: result.table}, function (err, result) {
                if (err) {
                    callback(err);
                } else {

                    schema.dropSchema({schema: result.table}, function (err, result) {
                        if (err) {
                            callback(err);
                        } else {
                            callback(null, result);
                        }


                    });
                }

            });

        }


    });
}

// create schema test

function createSchema(callback){
    schema.createSchema({"schema": schema_value}, function (err, result) {
        winston.error(err);
        winston.info(result);
        callback(err, result);
        return;
    });
}

function createTable(callback){
    var person_table_object = {};
    person_table_object.table = table;
    person_table_object.schema = schema_value;
    person_table_object.hash_attribute = "id";
    schema.createTable(person_table_object, function (err, result) {
        winston.info(err);
        winston.info(result);
        if (err) {
            callback(err);
        } else {
            callback(null, {"schema": schema_value, "table": table});
        }


    });
}

createSchema(function(err, data){
    if(err){
        winston.info("ERROR: " + err);
        return;
    }
    createTable(function(err, data){
        if(err){
            winston.info(err);
            return;
        }
        winston.info(data);
    });
})


//deleteTest({"schema": "test_schema_8", "table" : "test_table_8"});


