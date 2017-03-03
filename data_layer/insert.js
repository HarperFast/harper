const insert_validator = require('../validation/insertValidator.js'),
    fs = require('fs'),
    async = require('async');

const hdb_path = '../hdb/schema';
const insert_object = {
    schema: 'dev',
    table :  'person'
};
insert(insert_object, function(err, data){
    console.error(err);
});

function insert(insert_object, callback) {
    //validate insert_object for required attributes
    /*var validator = insert_validator(insert_object);
    if (validator) {
        callback(validator);
        return;
    }*/

    //check if schema / table directories exist
    var table_path = hdb_path + '/' + insert_object.schema + '/' + insert_object.table;

    if(!checkPathExists(table_path)){
        callback('Table: ' + insert_object.schema + '.' + insert_object.table + ' does not exist');
        return;
    }

    //verify hash_attribute is correct for this table

    //deconstruct object into seperate peices
    var attribute_array = deconstructObject(insert_object);




    callback();
}

function checkPathExists(path){
    return fs.existsSync(path);
}

function deconstructObject(insert_object){
    var attribute_array = [];

    for (var property in insert_object) {
        if (insert_object.hasOwnProperty(property)) {
            var attribute_object = {
                schema : insert_object.schema,
                table : insert_object.table,
                attribute_name : property,
                attribute_value : insert_object[property],
                hash_value :  insert_object.hash_value
            };

            attribute_array.push(insert_object);
        }
    }

    return attribute_array;
}

function insertObject(attribute_array){
    //if attribute is new create atribute folder

    // insert record into /table/attribute/value-timestamp-hash.hdb
    async.each(attribute_array, function(attribute, callback){
        //compare object attributes to known schema, if new attributes add to system.hdb_attribute table
        var attribute_path = hdb_path + '/' + attribute.schema + '/' + attribute.table + '/' + attribute.attribute_name;
        checkPathExists(attribute_path)
    }, function(err){

    });
}

function checkAttributeSchema(){

}