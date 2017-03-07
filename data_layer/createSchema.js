const fs = require('fs');
var settings = require('settings');
var path = require('path');
const base_path =path.join(settings.HDB_ROOT, "hdb/schema/");
const validate = require('validate.js');
const insert = require('./insert.js');


var constraints = {
    schema: {
        presence: true,
        format: "[\\w\\-\\_]+"

    }
};

module.exports = {
     createSchema: function(schema_create_object, callback) {


         var validation_error = validate(schema_create_object, constraints);
         if (validation_error) {
             callback(validation_error, null);
             return;
         }

         var insertObject = {};
         insertObject.schema = "system";
         insertObject.table = 'hdb_schema';
         insertObject.hash_attribute = 'name';
         insertObject.records = [{"name": schema_create_object.schema}];
         insert.insert(insertObject, function (err, result) {
             console.log(err);
             console.log(result);
             callback(err, result);
         });


     },
    
    // create folder structrue
    createSchemaStructure: function(schema_create_object, callback){
        var validation_error = validate(schema_create_object, constraints);
        if (validation_error) {
            callback(validation_error, null);
            return;
        }

        var schema = schema_create_object.schema;
        fs.mkdir(base_path + schema, function(err, data){
            if(err){
                if(err.errno == -17){
                    callback("schema already exists", null);
                    return;

                }else{
                    callback(err.message, null);
                    return;
                }
            }
            callback(null, "success");
            return;


        });
    }




};



