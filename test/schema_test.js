var createTable = require('../data_layer/createTable.js');
var createSchema = require('../data_layer/createSchema.js');
var dropTable = require('../data_layer/dropTable.js');
var dropSchema = require('../data_layer/dropSchema');


function createTest(callback) {
   // var schema = "test_schema_" + JSON.stringify(Date.now());
    //var table = "test_schema_" + JSON.stringify(Date.now());
    var schema = 'test';
    var table = 'person';

    createSchema.createSchema({"schema": schema}, function (err, result) {
        console.log(err);
        console.log(result);
        var person_table_object = {};
        person_table_object.table = table;
        person_table_object.schema = schema;
        person_table_object.hash_attribute = 'id';
        createTable.insertTable(person_table_object, function (err, result) {
            console.log(err);
            console.log(result);
            if (err) {
                callback(err);
            } else {
                callback(null, {"schema": schema, "table": table});
            }


        });


    });
}


function tableTest() {
    var person_table_object = {};
    person_table_object.table = 'person';
    person_table_object.schema = 'test';
    person_table_object.hash_attribute = 'id';
    createTable(person_table_object, function (err, result) {
        console.log(err);
        console.log(result);
        return;

    });
}


function fullTest(callback) {


    createTest(function (err, result) {
        if (err) {
            callback(err);

        } else {
            dropTable({schema: result.schema, table: result.table}, function (err, result) {
                if (err) {
                    callback(err);
                } else {

                    dropSchema({schema: result.table}, function (err, result) {
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

    createTest(function (err, result) {
        console.error(err);
        console.log(result);
        return;
    });



