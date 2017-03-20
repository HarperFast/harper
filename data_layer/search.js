const fs = require('fs'),
    spawn = require('child_process').spawn,
    util = require('util');
var settings = require('settings');
var path = require('path');
const base_path = path.join(settings.HDB_ROOT, "schema/");
const exec = require('child_process').exec;
const search_validator = require('../validation/searchValidator.js');
async = require('async');
const search_comand = 'time sh %s';


// search by hash only
// what attributes are you selecting
// table selecting from
// condition criteria


//schema, table, hash_value, hash_attribute, get_attributues, callback
function searchByHash(search_object, callback) {
    console.time('time before');
    var hash_path = path.join(base_path,
        search_object.schema + '/' + search_object.table + '/' + search_object.hash_attribute + '/' + search_object.hash_value);



    var validation_error = search_validator(search_object, 'hash');
    if (validation_error) {
        callback(validation_error, null);
        return;
    }


    fs.readdir(hash_path, function (err, data) {

        if (err) {
            handleError();
            return;
        }

        var timestamp = data.sort(sortHashByData)[0].split('-')[1].replace('.hdb', '');

        var object = {};
        object[search_object.hash_attribute] = search_object.hash_value;


        //find ./ -name '1.hdb' -mtime -900000s
        var table_path = path.join(base_path,
            search_object.schema + '/' + search_object.table);


        async.map(search_object.get_attributes, function (attribute, caller) {

                if (attribute == search_object.hash_attribute) {
                    caller();
                    return;
                }
                console.log('find ' + table_path + '/' + attribute + ' -name \'' + search_object.hash_value + '.hdb\' -mtime -' + Math.round((Date.now() - timestamp) / 1000 + 1))
                var cmd = 'find ' + table_path + '/' + attribute + ' -name \'' + search_object.hash_value + '.hdb\' -mtime -' + Math.round((Date.now() - timestamp) / 1000 + 1);
                exec(cmd, function (error, stdout, stderr) {
                    console.time('time after');
                    if (error) {
                        caller(error);_path + '/' + attr
                        return;
                    }
                    if (stdout) {

                        var results = stdout.split('./').join('').split('\n');
                        var x = 0;
                        while (x < results.length) {
                            if (!results[x]) {
                                results.splice(x, 1);
                            }
                            x++;
                        }
                        console.time('loop');
                        results.sort(sortByDate);
                        readAttribute(results[0], function (err, data) {
                            if (err) {
                                caller(err);
                                return;
                            }
                            object[attribute] = data;
                            caller();
                            console.timeEnd('time after');
                            return;


                        });


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
            });


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


}

function getAttributePathByValue(get_object, callback) {
    //find ./ -name '1.hdb' -mtime -900000s
    var attr_path = path.join(base_path,
        get_object.schema + '/' + get_object.table + '/' + get_object.search_attribute);

    var substr = get_object.search_value.substr(0, 200);

    console.time(get_object.attribute + ' find command');
    console.log('cd  ' + attr_path + ';  grep "\\<' + get_object.search_value + '\\>" ./' + substr + '*.hdb');
    // by using cd to get to the directory instead of providing the path as part of the find command the overall time drops by half for the find.

    exec('cd  ' + attr_path + ';  grep "\\<' + get_object.search_value + '\\>" ./' + substr + '*.hdb', function (error, stdout, stderr) {
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

function sortHashByData(a, b) {
    a_date = Number(a.split('-')[1].replace('.hdb', ''));
    b_date = Number(b.split('-')[1].replace('.hdb', ''));
    return a_date > b_date ? -1 : a < b ? 1 : 0;
}

function sortByDate(a, b) {
    a_date = Number(a.split('-')[1]);
    b_date = Number(b.split('-')[1]);
    return a_date > b_date ? -1 : a < b ? 1 : 0;
}

/**
 var get_obj = {};
 get_obj.schema = 'system';
 get_obj.table = 'hdb_attribute';
 get_obj.search_attribute = 'table';
 get_obj.search_value = 'person';
 get_obj.hash_attribute = 'hash';
 get_obj.get_attributes = ['schema', 'name'];
 **/



var get_obj = {};
get_obj.schema = 'dev';
get_obj.table = 'person';
get_obj.hash_value = '3000';
get_obj.hash_attribute = 'id';
get_obj.get_attributes = ['id', 'first_name', 'last_name'];

console.time('test');
searchByHash(get_obj, function (err, data) {
    if (err)
        console.error(err);
    console.log(data);
    console.timeEnd('test');
});

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

});



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

}); **/
