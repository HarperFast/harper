const fs = require('fs');
const db_root = '../hdb';
const base_path = db_root + '/schema/';
const validate = require('validate.js');



function createSchema(schema_create_object, callback){
    var constraints = {
        schema : {
            presence : true,
            format: "[\\w\\-\\_]+"

        }
    };

    var validation_error = validate(schema_create_object, constraints);
    if(validation_error){
        callback(validation_error, null);
        return;
    }

    var schema = schema_create_object.schema;

    
    //need to insert record into hdb_schema
    function insertSchemaRecords(){
        
    }
    
    // create folder structrue
    function createSchemaStructure(){
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

    // delete this out once above insertSchemaRecords and trigger is working.
    createSchemaStructure();



}


createSchema({"schema":"test"}, function(err, result){
    console.log(err);
    console.log(result);
});

