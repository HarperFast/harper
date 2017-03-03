var createTable = require('../createTable.js')



var person_table_object = {};
person_table_object.table = 'credit_score';
person_table_object.schema = 'test';
person_table_object.hash_attribute = 'id';

createTable(person_table_object, function(err, result){
    console.log(err);
    console.log(result);
});


