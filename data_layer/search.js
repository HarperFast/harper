const fs = require('fs');
var settings = require('settings');
var path = require('path');
const base_path = path.join(settings.HDB_ROOT, "hdb/schema/");
const exec = require('child_process').exec;
const search_validator = require('../validation/searchValidator.js');
async = require('async');
console.time('whole test');


// search by hash only
// what attributes are you selecting
// table selecting from
// condition criteria


//schema, table, hash_value, hash_attribute, get_attributues, callback
function searchByHash(search_object, callback) {


    var validation_error =search_validator(search_object);
    if (validation_error) {
        callback(validation_error, null);
        return;
    }



    var hash_path =  path.join(base_path,
        search_object.schema + '/' + search_object.table + '/' + search_object.hash_attribute + '/');

    fs.readFile(hash_path + search_object.hash_value + '.hdb', 'utf8', function(err, data){
         if(err){
            handleError();
            return;
       }
       var object = {};
       object[search_object.hash_attribute] = data;

       var base_attr_path = path.join(base_path,
            search_object.schema + '/' + search_object.table + '/');

        console.time('asyncStart');
        async.map(search_object.get_attributes,
            function (attribute, caller) {
                console.timeEnd('asyncStart');
                if (attribute == search_object.hash_attribute) {
                    caller();
                    return;
                }




                var attr_path = base_attr_path + attribute;


                if (!fs.existsSync(attr_path)) {
                    caller('attribute does not exist');
                    return;
                }

                console.time(attribute +' find command');
                console.log('cd  ' + attr_path + '; find ./ -iname \'*-' + search_object.hash_value + '.hdb\'')
                // by using cd to get to the directory instead of providing the path as part of the find command the overall time drops by half for the find.

                exec('cd  ' + attr_path + '; find ./ -iname \'*-' + search_object.hash_value + '.hdb\'', function (error, stdout, stderr) {
                    console.timeEnd(attribute +' find command');
                     if (error) {
                        caller(error);
                        return;
                    }

                        fs.readFile(path.join(attr_path,  stdout.replace('\n', '').replace('.//', '')), 'utf8', function(err, data){
                            object[attribute] = data;
                            caller();
                        });



                });
            },
            function (err, data) {
                callback(null, object);
            }
        );


    });

    function handleError(){

        if (!fs.existsSync(base_path + search_object.schema)) {
            callback("schema does not exist");
            return;
        }


        if (!fs.existsSync(path.join(base_path, search_object.schema + "/" + search_object.table))) {
            callback("table does not exist");
            return;

        }
        if (!fs.existsSync(path.join(base_path, search_object.schema + "/"
                + search_object.table + "/" + search_object.hash_attribute))) {
            callback("hash_atrribute does not exist");
            return;

        }
        callback(null, null);
        return;

    }




}



var search_obj = {};

search_obj.schema = 'dev';
search_obj.table = 'person';
search_obj.hash_attribute = 'id';
search_obj.hash_value = '1';
search_obj.get_attributes = ['first_name', 'last_name', 'id']

searchByHash(search_obj, function (err, result) {

    if(err)
        console.error(err);
    console.log(result);
    console.timeEnd('whole test');






})