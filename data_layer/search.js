const fs = require('fs');
var settings = require('settings');
var path = require('path');
const base_path = path.join(settings.HDB_ROOT, "hdb/schema/");
const exec = require('child_process').exec;
const search_validator = require('../validation/searchValidator.js');
async = require('async');


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
    var hash_path = path.join(base_path,
        search_object.schema + '/' + search_object.table + '/' + search_object.hash_attribute + '/');

    fs.readFile(hash_path + search_object.hash_value + '.hdb', function(err, data){
       if(err){
           if (validation_error) {
               callback(validation_error, null);
               return;
           }

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
           callback('id does not exist');
           return;


       }
       var object = {};
       object[search_object.hash_attribute] = search_obj.hash_value;
       async.map(search_object.get_attributes,
            function (attribute, caller) {
                if (attribute == search_object.hash_attribute) {
                    caller();
                    return;
                }
                var attr_path = path.join(base_path,
                    search_object.schema + '/' + search_object.table + '/' + attribute);
                if (!fs.existsSync(attr_path)) {
                    caller('attribute does not exist');
                    return;
                }

                console.log('find ' + attr_path + ' -path  *-' + search_object.hash_value + '.hdb')
                exec('find ' + attr_path + ' -path  *-' + search_object.hash_value + '.hdb', function (error, stdout, stderr) {
                    if (error) {
                        caller(error);
                        return;
                    }

                    var tokens = stdout.replace('.hdb', '').split('/');
                    object[attribute] = tokens[tokens.length - 1].split('-')[0];
                    caller();


                });
            },
            function (err, data) {
                callback(null, object);
            }
        );


    });






}

var moment = require('moment')

var search_obj = {};

search_obj.schema = 'dev';
search_obj.table = 'person';
search_obj.hash_attribute = 'id';
search_obj.hash_value = '9';
search_obj.get_attributes = ['id', 'first_name', 'last_name']

var start = process.hrtime();

searchByHash(search_obj, function (err, result) {
    console.error(err);
    console.log(result);
    console.log(moment().format() + ' END!');
    var diff = process.hrtime(start);
    console.log(`finished took ${(diff[0] * 1e9 + diff[1]) / 1e9} seconds`);

})