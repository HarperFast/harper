var schema = require('../data_layer/schema.js');

var schema_value = 'test_schema';
var table = 'test_table';





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
        console.error(err);
        console.log(result);
        callback(err, result);
        return;
    });
}

function createTable(callback){
    var person_table_object = {};
    person_table_object.table = table;
    person_table_object.schema = schema_value;
    person_table_object.hash_attribute = "id";
    schema.insertTable(person_table_object, function (err, result) {
        console.log(err);
        console.log(result);
        if (err) {
            callback(err);
        } else {
            callback(null, {"schema": schema_value, "table": table});
        }


    });
}

createSchema(function(err, data){
    if(err){
        console.log("ERROR: " + err);
        return;
    }
    createTable(function(err, data){
        if(err){
            console.log(err);
            return;
        }
        console.log(data);
    });
})


//deleteTest({"schema": "test_schema_8", "table" : "test_table_8"});


