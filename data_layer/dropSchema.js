const fs = require('fs');
var settings = require('settings');
const base_path =settings.HDB_ROOT +  '/hdb/schema/';

const validate = require('validate.js');




module.exports = function dropSchema(drop_schema_object, callback) {

    var constraints = {
        schema : {
            presence : true,
            format: "[\\w\\-\\_]+",
            exclusion: {
                within: ["system"],
                message: "You cannot drop the system schema!"
            }

        }
    };

    var validation_error = validate(drop_schema_object, constraints);
    if(validation_error){
        callback(validation_error, null);
        return;
    }


    var schema = drop_schema_object.schema;


    // need to delete schema record from hdb_schema
    function deleteSchemaRecords() {

    }

    // need to listen to https://nodejs.org/api/events.html#events_event_newlistener for the insert of a file
    // this event will  then call the code below

    function deleteSchemaStructure() {
        var deleteFolderRecursive = function (path, root) {
            if (fs.existsSync(path)) {
                fs.readdirSync(path).forEach(function (file, index) {
                    var curPath = path + "/" + file;
                    if (fs.lstatSync(curPath).isDirectory()) { // recurse
                        deleteFolderRecursive(curPath, false);
                    } else { // delete file
                        fs.unlinkSync(curPath);
                    }
                });

                fs.rmdirSync(path);
                if(root)
                    return callback(null, "success");


            }else{
                callback("schema does not exist");
                return;
            }
        }
        var path = base_path + schema;
        deleteFolderRecursive(path, true);


    }


    // delete this out once above insertSchemaRecords and trigger is working.

    deleteSchemaStructure()


};


