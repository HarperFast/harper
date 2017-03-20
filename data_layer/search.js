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
    var validation_error = search_validator(search_object, 'hash');
    if (validation_error) {
        callback(validation_error, null);
        return;
    }
    var hash_path = path.join(base_path,
        search_object.schema + '/' + search_object.table + '/' + search_object.hash_attribute + '/');

    fs.readFile(hash_path + search_object.hash_value + '.hdb', 'utf8', function (err, data) {
        if (err) {
            handleError();
            return;
        }
        var object = {};
        object[search_object.hash_attribute] = data;


        async.map(search_object.get_attributes,
            function (attribute, caller) {
                if (attribute == search_object.hash_attribute) {
                    caller();
                    return;
                }

                var getObject = {};
                getObject.table = search_object.table;
                getObject.schema = search_object.schema;
                getObject.hashes = [search_object.hash_value];
                getObject.attribute = attribute;
                getAttributePathByHash(getObject, function (err, data) {
                    if (err) {
                        caller(err);
                        return;
                    }
                    if (data) {
                        readAttribute(data, function (err, value) {
                            if (err) {
                                caller(err);
                            }
                            object[attribute] = value;
                            caller();
                            return;
                        });
                    } else {
                        caller();
                        return;
                    }


                });

            },
            function (err, data) {
                if (err) {
                    callback(err, null);
                    return;
                }

                callback(null, object);
                return;
            }
        );


    });

    function handleError() {

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




function readAttribute(path, callback) {

    if (!path) {
        callback("Missing path");
        return;
    }

    fs.readFile(path, 'utf8', function (err, data) {
        if (err) {
            callback(err);
            return;
        }

        callback(null, data);
        return;
    });

}

function getAttributePathByHash(get_object, callback) {
    var attr_path = path.join(base_path,
        get_object.schema + '/' + get_object.table + '/' + get_object.attribute);


    console.time(get_object.attribute + ' find command');
    console.log('cd  ' + attr_path + '; find ./ -name \'*-' + get_object.hash_value + '.hdb\'')
    // by using cd to get to the directory instead of providing the path as part of the find command the overall time drops by half for the find.
    var cmd = "cd  " + attr_path + "; find . -maxdepth 1 -mount";
    for(hash in get_object.hashes){
        cmd += " -wholename  '*-" + get_object.hashes[hash] + ".hdb'";
        if(!(hash == get_object.hashes.length -1)){
            cmd+= " -o ";
        }

    }



    exec(cmd, function (error, stdout, stderr) {
        console.timeEnd(get_object.attribute + ' find command');
        if (error) {
            callback(error);
            return;
        }

        if (stdout) {
            var results = stdout.split('./').join('').split('\n');
            results.sort(sortByDate);
            callback(null, path.join(attr_path, results[0]));
            return;
        }

        callback(null, null);
        return;


    });

}

function getAttributePathByValue(get_object, callback) {
    var attr_path = path.join(base_path,
        get_object.schema + '/' + get_object.table + '/' + get_object.search_attribute);

    var substr = get_object.search_value.substr(0, 200);

    console.time(get_object.attribute + ' find command');
    console.log('cd  ' + attr_path + ';  grep "\\<' + get_object.search_value + '\\>" ./'+substr+'*.hdb');
    // by using cd to get to the directory instead of providing the path as part of the find command the overall time drops by half for the find.

    exec('cd  ' + attr_path + ';  grep "\\<' + get_object.search_value + '\\>" ./'+substr+'*.hdb', function (error, stdout, stderr) {
        console.timeEnd(get_object.attribute + ' find command');
        if (error) {
            callback(error);
            return;
        }

        var results = stdout.split('./').join('').split(':' + get_object.search_value).join('').split('\n');
        results.splice(results.length - 1);
        callback(null, results);
        return


    });

}


function sortByDate(a, b) {
    a_date = Number(a.split('-')[1]);
    b_date = Number(b.split('-')[1]);
    return a_date > b_date ? -1 : a < b ? 1 : 0;
}


var get_obj = {};
get_obj.schema = 'system';
get_obj.table = 'hdb_attribute';
get_obj.search_attribute = 'table';
get_obj.search_value = 'person';
get_obj.hash_attribute = 'hash';
get_obj.get_attributes = ['schema', 'name'];



/**
var get_obj = {};
get_obj.schema = 'dev';
get_obj.table = 'person';
get_obj.search_attribute = 'first_name';
get_obj.search_value = 'Ana';
get_obj.hash_attribute = 'id';
get_obj.get_attributes = ['id', 'first_name', 'last_name'];
**/

/** not working
getAttributePathByValue(get_obj, function(err, data){
    console.time('whole');
    if(err){
        console.error(err);
        return;
    }

    var hashes = [];
    for(hash in data){
        if(data[hash].indexOf('-') > -1)
            hashes.push(data[hash].split('-')[2].split('.hdb').join(''));
        else{
            hashes.push(data[hash].split('.hdb').join(''));
        }
    }


    var results = [];

    async.map(get_obj.get_attributes,
        function (attribute, caller) {

            var search_obj = {};


            var getObject = {};
            getObject.table =  get_obj.table;
            getObject.schema = get_obj.schema;
            getObject.hashes = hashes
            getObject.attribute = attribute;



            getAttributePathByHash(getObject, function (err, result) {

                if (err){
                    console.error(err);
                    caller(err);
                    return;
                }


                results.push(result);
                caller();
                return;


            });
        }, function(err, data){
            console.log(results);
            console.timeEnd('whole');
            return;

        });

}); **/



getAttributePathByValue(get_obj, function(err, data){
    console.time('whole');
    if(err){
        console.error(err);
        return;
    }

    console.log(data);
    var results = [];

    async.mapLimit(data,40,
        function (hash_value, caller) {

        var search_obj = {};

        search_obj.schema = get_obj.schema;
        search_obj.table = get_obj.table;
        search_obj.hash_attribute = get_obj.hash_attribute;

        if(hash_value.indexOf('-') > -1)
            search_obj.hash_value = hash_value.replace('.hdb', '').split('-')[2];
        else
            search_obj.hash_value = hash_value.replace('.hdb', '')
        search_obj.get_attributes = get_obj.get_attributes;

        searchByHash(search_obj, function (err, result) {

            if (err){
                console.error(err);
                caller(err);
                return;
            }


            results.push(result);
            caller();
            return;


        });
    }, function(err, data){
            console.log(results);
            console.timeEnd('whole');
            return;

        });

});
