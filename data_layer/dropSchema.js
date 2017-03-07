const fs = require('fs');
var settings = require('settings');
var path = require('path');
const base_path =path.join(settings.HDB_ROOT, "hdb/schema/");
const validate = require('validate.js');


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

module.exports = {


    dropSchema: function(drop_schema_object, callback) {



    var validation_error = validate(drop_schema_object, constraints);
    if(validation_error){
        callback(validation_error, null);
        return;
    }


    var schema = drop_schema_object.schema;




    },

    // need to listen to https://nodejs.org/api/events.html#events_event_newlistener for the insert of a file
    // this event will  then call the code below

   deleteSchemaStructure: function(drop_schema_object, callback) {

       var validation_error = validate(drop_schema_object, constraints);
       if(validation_error){
           callback(validation_error, null);
           return;
       }


       var schema = drop_schema_object.schema;



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





};


