var createTable = require('../data_layer/createTable.js');
var createSchema = require('../data_layer/createSchema.js');
var dropTable = require('../data_layer/dropTable.js');
var dropSchema = require('../data_layer/dropSchema');




function createTest(){
    createSchema({"schema":"test"}, function(err, result){
        console.log(err);
        console.log(result);
        var person_table_object = {};
        person_table_object.table = 'person';
        person_table_object.schema = 'test';
        person_table_object.hash_attribute = 'id';
        createTable(person_table_object, function(err, result){
            console.log(err);
            console.log(result);
            return;

        });


    });
}


function fullTest(){
    createSchema({"schema":"test"}, function(err, result){
        console.log(err);
        console.log(result);
        var person_table_object = {};
        person_table_object.table = 'person';
        person_table_object.schema = 'test';
        person_table_object.hash_attribute = 'id';
        createTable(person_table_object, function(err, result){
            console.log(err);
            console.log(result);
            dropTable({schema:"test", table:"person"}, function (err, result) {
                console.log(err);
                console.log(result);
                dropSchema({schema:"test"}, function (err, result) {
                    console.log(err);
                    console.log(result);
                    return;
                });
            });
        });


    });
}


//createTest();
fullTest();


