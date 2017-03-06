const fs = require('fs');
var settings = require('settings');
const base_path =settings.HDB_ROOT +  '/hdb/schema/';
const create_table_validation = require('../validation/createTableValidator.js');
const insert = require('./insert.js');



module.exports = function createTable(create_table_object, callback){

    var validator = create_table_validation(create_table_object);
     if (validator) {
        callback(validator);
        return;
     }

    //need to insert record in hdb_table
    // need to insert hash into hdb_attribute
    function insertTableRecords(){

        var table = {};
        table.name = create_table_object.table;
        table.hash_attribute = create_table_object.hash_attribute;
        table.schema = create_table_object.schema;
        var insertObject = {};
        insertObject.schema = "system";
        insertObject.table = 'hdb_table'; 
        insertObject.hash_attribute = 'name';
        insertObject.records = [table];
        insert.insert(insertObject, function(err, result){
            console.log(err);
            console.log(result);
        });



    }

    // need to listen to https://nodejs.org/api/events.html#events_event_newlistener for the insert of a file
    // this event will  then call the code below

    function createTableStructure(){
        fs.mkdir(base_path + create_table_object.schema + '/' + create_table_object.table, function(err, data){
            if(err){
                if(err.errno == -2){
                    callback("schema does not exist", null);
                    return;
                }
                
                if(err.errno == -17){
                    callback("table already exists", null);
                    return;

                }else{
                    return err.message;
                }
            }

            callback(null, "success");
            return;

        });
    }

    // delete this out once above insertSchemaRecords and trigger is working.

    //createTableStructure()
    insertTableRecords();
    


};



