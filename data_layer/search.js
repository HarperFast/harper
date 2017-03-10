const fs = require('fs');
var settings = require('settings');
var path = require('path');
const base_path = path.join(settings.HDB_ROOT, "hdb/schema/");
const exec = require('child_process').exec;
const validate = require('validate.js');
async = require('async');


// search by hash only
// what attributes are you selecting
// table selecting from
// condition criteria


var search_by_hash_constraints = {
    schema: {
        presence: true,
        format: "[\\w\\-\\_]+",
        exclusion: {
            within: ["system"],
            message: "You cannot create tables within the system schema"
        }

    },
    table: {
        presence: true,
        format: "[\\w\\-\\_]+"

    },
    hash_attribute: {
        presence: true,
        format: "[\\w\\-\\_]+"

    },
    hash_value: {
        presence: true
    },
    get_attributes: {
        presence: true,
    }
};

//schema, table, hash_value, hash_attribute, get_attributues, callback
function searchByHash(search_object, callback) {

    var validation_error = validate(search_object, search_by_hash_constraints);
    if (validation_error) {
        callback(validation_error, null);
        return;
    }

    if (!validate.isArray(search_object.get_attributes)) {
        callback("get_attributes needs to be an array");
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

    }    //
    var hash_path = path.join(base_path,
        search_object.schema + '/' + search_object.table + '/' + search_object.hash_attribute);

    var object = {};
    exec('find ' + hash_path + ' -path  */' + search_object.hash_value + '.hdb', function (error, stdout, stderr) {
        if (error) {
            callback(error);
            return;
        }

        if (stdout) {
            var id_tokens = stdout.replace('.hdb', '').replace('\n', '').split('/');
            object[search_object.hash_attribute] = id_tokens[id_tokens.length - 1];

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


        }


    });


}

var moment = require('moment')

var search_obj = {};

search_obj.schema = 'dev';
search_obj.table = 'person';
search_obj.hash_attribute = 'id';
search_obj.hash_value = '9';
search_obj.get_attributes = ['id', 'first_name', 'last_name']

console.log(moment().format() + ' BEGIN!');

searchByHash(search_obj, function (err, result) {
    console.error(err);
    console.log(result);
    console.log(moment().format() + ' END!');

})