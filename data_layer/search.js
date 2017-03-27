'use strict';
const fs = require('fs')
    , settings = require('settings')
    , base_path = settings.HDB_ROOT + "/schema/"
    , exec = require('child_process').exec
    , search_validator = require('../validation/searchValidator.js')
    , async = require('async')
    , spawn = require('child_process').spawn,
    util = require('util');


// search by hash only
// what attributes are you selecting
// table selecting from
// condition criteria


//schema, table, hash_value, hash_attribute, get_attributues, callback
function searchByHash(search_object, callback) {

    var hash_path = base_path +
        search_object.schema + '/' + search_object.table + '/' + search_object.hash_attribute + '/' + search_object.hash_value;
    var validation_error = search_validator(search_object, 'hash');
    if (validation_error) {
        callback(validation_error, null);
        return;
    }
    var items = [];

    for (var attr in search_object.get_attributes) {
        if (search_object.get_attributes[attr] != search_object.hash_attribute) {
            var item = {};
            item.attribute = search_object.get_attributes[attr];
            item.hash_value = search_object.hash_value;
            item.hash_attribute = search_object.hash_attribute;
            items.push(item);
        }

    }


    fs.readdir(hash_path, function (err, data) {
        if (err) {
            console.error(err);
            handleError(search_object, err, callback);
            return;
        }

        if (!data)
            callback(null, null);


        var object = {};
        object[item.hash_attribute] = item.hash_value;

        var table_path = base_path +
            search_object.schema + '/' +search_object.table;


        async.map(items, function (item, caller) {
                var attr_path =  table_path + '/' + item.attribute + '/__hdb_hash/' +item.hash_value +'.hdb';


                readAttribute(attr_path, function(error, data){
                    if (err) {
                        console.error(err);
                        caller(err);
                        return;
                    }
                    object[item.attribute] = data;
                    caller();

                    return;
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


}

function searchByHashesParr(search_objectes, callback){
    var results = [];
    console.time('into map');

    for (var i = 0, len = search_objectes.length; i < len; i++) {
        console.timeEnd('into map');

        searchByHash(search_objectes[i], function(err, data){
            if(err){
                callback(err);
                console.error(err);
                return;
            }

            results.push(data);
            returnPayload();

        });
    }

    function returnPayload(){
        if(results.length == search_objectes.length)
            return callback(null, results);
    }


}


function searchByHashes(search_object, callback) {
    console.time('intest');
    var hash_attr_path = base_path +
        search_object.schema + '/' + search_object.table + '/' + search_object.hash_attribute + '/';

    // run validation
    var validation_error = search_validator(search_object, 'hashes');
    if (validation_error) {
        callback(validation_error, null);
        return;
    }

    // put everything in local scoped variable for aysnc

    var items = [];
    for (var attr in search_object.get_attributes) {
        if (search_object.get_attributes[attr] != search_object.hash_attribute) {
            var item = {};
            item.attribute = search_object.get_attributes[attr];
            item.hash_value = search_object.hash_value;
            item.hash_attribute = search_object.hash_attribute;
            items.push(item);
        }

    }

    var args = '';
    for (var hash in search_object.hash_values) {
        if(hash != 0){
            args+= ' -o '
        }
        args += hash_attr_path + search_object.hash_values[hash] + '  ';
    }
    console.timeEnd('intest');
    ls_multiple(args, function (err, version_hashes) {
        console.error(err);
        // this takes less then 1 millsecond
        version_hashes = version_hashes.replace('\n', '').split(' ');
        var hashes = [];
        for (item in version_hashes) {
            if (version_hashes[item].indexOf(':') > -1) {
                var tokens = version_hashes[parseInt(item) + 1].replace('.hdb', '').split('-');
                var hash_obj = {};
                hash_obj.hash = tokens[0];
                hash_obj.timestamp = tokens[1];
                hashes.push(hash_obj);
            }
        }

        var table_path = base_path +
            search_object.schema + '/' + search_object.table;


        var field_results = [];
        async.map(items, function (item, caller) {
                var attr_path = table_path + '/' + item.attribute;
                var pathArgs = '';
                for (var hash in hashes) {
                    if(hash != 0){
                        pathArgs+= ' -o ';
                    }
                    pathArgs += attr_path + '/*/'+hashes[hash].hash  +'.hdb ';

                }



                ls_multiple(pathArgs, function(error, stdout){

                    if (error) {
                        caller(error);
                        return;
                    }
                    if (stdout) {

                        var tempArray = parseStdout(stdout);
                        var exists = [];
                        async.map(tempArray, function (path, cal) {
                            if(exists.indexOf(getHashFromPath(path)) < 0){
                                exists.push(getHashFromPath(path));
                                renameMe(item.attribute, path, function (err, data) {
                                    field_results.push(data);
                                    cal();
                                });



                            }else{
                                cal();
                            }




                        }, function (err, data) {
                            caller();

                            return;

                        })


                    }


                });
            },
            function (err, data) {
                if (err) {
                    callback(err, null);
                    return;
                }


                var search_results = [];

                for(var hash in search_object.hash_values){
                        var attributes = field_results.filter(function(value){
                            return search_object.hash_values[hash] == value.hash;
                        });
                        var obj = {};
                        obj[search_object.hash_attribute] = attributes[0].hash;
                        for(attr in attributes){
                               obj[attributes[attr].field]  = attributes[attr].value;
                               
                        }
                    
                       search_results.push(obj);
                }









                callback(null, search_results);
                return;


            });


    });


}

function renameMe(field, path, callback) {
    var result = {};
    result.field = field;
    result.hash = getHashFromPath(path);
    readAttribute(path, function (err, data) {
        if (err) {
            callback(err);
            return;
        }
        result.value = data;
        callback(null, result);


    });

}


function getHashFromPath(path) {
    let token = path.replace('.hdb', '').split('/');
    return token[token.length - 1];
}


function ls_multiple(args, callback) {
    console.time('ls');

    var terminal = spawn('bash');
    var results = '';
    terminal.stdout.on('data', function (data) {
        results += data;
    });


    terminal.on('exit', function (code) {
        console.timeEnd('ls');
        console.log('exit with code ' + code);
        callback(null, results);
    });

    terminal.stdin.write(util.format('time sh %s ' + args, settings.PROJECT_DIR + '/bash/multi_ls.sh'));
    terminal.stdin.end();
}


function searchByValue(search_object, callback) {
    var hash_path = base_path + "/" +
        search_object.schema + '/' + search_object.table + '/' + search_object.hash_attribute + '/' + search_object.hash_value;
    var validation_error = search_validator(search_object, 'value');
    if (validation_error) {
        callback(validation_error, null);
        return;
    }

    var table_path = base_path + search_object.schema + '/' + search_object.table;
    var value_path = table_path + '/' + search_object.search_attribute;
    var search_string = search_object.search_value.split('*').join('[A-z,0-9]*');
    var cmd = 'find ' + value_path + ' -name \'' + search_string + '\'';
    exec(cmd, function (error, stdout, stderr) {
        if (error || stderr) {
            callback(error + ' ' + stderr);
            return;
        }

        var results = parseStdout(stdout);
        search_object.hash_values = [];
        if (!results || results.length < 1) {
            callback(null, null);
            return;
        }


        async.map(results, function (path, caller) {
            fs.readdir(path, function (err, dirData) {
                if (err) {
                    caller(err);
                    return;
                }

                for (var item in dirData) {
                    search_object.hash_values.push(dirData[item].replace('.hdb', ''));
                }

                caller();

            });

        }, function (err, data) {
            if (err) {
                callback(err, null);
                return;
            }

           /** var index_of_attr = search_object.get_attributes.indexOf(search_object.search_attribute);
            if (index_of_attr > -1) {
                search_object.get_attributes.splice(index_of_attr, 1);

            } **/

            searchByHashes(search_object, function (err, data) {



                callback(err, data);
            });


            return;
        });


    });


}

function parseStdout(stdout) {
     var results;
    if(stdout.indexOf('./') > -1 )
        results = stdout.split('./').join('').split('\n');
    else
        results = stdout.replace('\n', '').split(' ');
    var x = 0;
    while (x < results.length) {
        if (!results[x]) {
            results.splice(x, 1);
        }
        x++;
    }
    results.sort(sortByDate);
    return results;
}


function readAttributeSync(path, callback) {

    if (!path) {
        callback("Missing path");
        return;
    }

    fs.readFileSync(path, 'utf8', function (err, data) {
        if (err) {
            callback(err);
            return;
        }

        callback(null, data);
        return;
    });

}


function readAttribute(path, callback) {

    if (!path) {
        callback("Missing path");
        return;
    }
    fs.readFile(path, 'utf8', function (err, data) {
        if (err) {
            console.error(err);
            callback(err);
            return;
        }

        callback(null, data);
        return;
    });

}


function sortHashByData(a, b) {
    var a_date = Number(a.split('-')[1].replace('.hdb', ''));
    var b_date = Number(b.split('-')[1].replace('.hdb', ''));
    return a_date > b_date ? -1 : a < b ? 1 : 0;
}

function sortByDate(a, b) {
    var a_date = Number(a.split('-')[1]);
    var b_date = Number(b.split('-')[1]);
    return a_date > b_date ? -1 : a < b ? 1 : 0;
}


function handleError(search_object, err, callback) {
    console.error(err);
    var schema_path = base_path + '/' + search_object.schema + "/";

    if (!fs.existsSync(schema_path)) {
        callback("schema does not exist");
        return;
    }


    if (!fs.existsSync(schema_path + search_object.table)) {
        callback("table does not exist");
        return;

    }
    if (!fs.existsSync(schema_path + "/"
            + search_object.table + "/" + search_object.hash_attribute)) {
        callback("hash_atrribute does not exist");
        return;

    }
    callback(err, null);
    return;

}


var search_obj = {};
search_obj.schema = 'dev';
search_obj.table = 'person';
search_obj.hash_attribute = 'id';
search_obj.hash_values = [];

function getRandomInt(min, max) {
  min = Math.ceil(min);
  max = Math.floor(max);search_obj.hash_value = '9870';
  return Math.floor(Math.random() * (max - min)) + min;search_obj.search_value = 'Tuc*';
}

    var number_of_hashes = 100000;
var searchHashes = [];
while(number_of_hashes > 0){

    var search_obj_2 = {};
    search_obj_2.schema = 'dev';
    search_obj_2.table = 'person';
    search_obj_2.hash_attribute = 'id';
    search_obj_2.hash_value =getRandomInt(1, 10000);
    search_obj_2.get_attributes = ['id', 'first_name', 'last_name'];

    searchHashes.push(search_obj_2)


    number_of_hashes--;
}





console.time('test');
searchByHashesParr(searchHashes, function (err, data) {
    if (err)
        console.error(err);
    console.log(data);
    console.timeEnd('test');
});