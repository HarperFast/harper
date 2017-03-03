const fs = require('fs');
const db_root = '../hdb';
const base_path = db_root + '/schema/';
const validate = require('validate.js');




function dropTable(drop_table_object, callback) {

    var constraints = {
        schema : {
            presence : true,
            format: "[\\w\\-\\_]+",
            exclusion: {
                within: ["system"],
                message: "You cannot alter the system schema!"
            }

        },

        table : {
            presence : true,
            format: "[\\w\\-\\_]+",

        }
    };

    var validation_error = validate(drop_table_object, constraints);
    if(validation_error){
        callback(validation_error, null);
        return;
    }


    var schema = drop_table_object.schema;
    var table = drop_table_object.table;


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
                callback("table does not exist");
                return;
            }
        }

        if (fs.existsSync(base_path + schema + "/")) {
            var path = base_path + schema + "/" + table;
            deleteFolderRecursive(path, true);
        }else{
            callback("schema does not exist");

        }

    }


    // delete this out once above insertSchemaRecords and trigger is working.

    deleteSchemaStructure()


}

dropTable({schema:"test", table:"person"}, function (err, result) {
    console.log(err);
    console.log(result);
});
