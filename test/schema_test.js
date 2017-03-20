var schema = require('../data_layer/schema.js');


function createTest(callback) {
   // var schema = "test_schema_" + JSON.stringify(Date.now());
    //var table = "test_schema_" + JSON.stringify(Date.now());
    var schema_value = 'dev';
    var table = 'person';

    schema.createSchema({"schema": schema_value}, function (err, result) {
        console.log(err);
        console.log(result);
        var person_table_object = {};
        person_table_object.table = table;
        person_table_object.schema = schema_value;
        person_table_object.hash_attribute = 'id';
        schema.insertTable(person_table_object, function (err, result) {
            console.log(err);
            console.log(result);
            if (err) {
                callback(err);
            } else {
                callback(null, {"schema": schema_value, "table": table});
            }


        });


    });
}


function tableTest() {
    var person_table_object = {};
    person_table_object.table = 'person';
    person_table_object.schema = 'dev';
    person_table_object.hash_attribute = 'id';
    schema(person_table_object, function (err, result) {
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

createTest(function(err,data){
    if(err)
        console.error(err);
    console.log(data);
});


