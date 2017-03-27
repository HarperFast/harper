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



    var indexOfHash = search_object.get_attributes.indexOf(search_object.hash_attribute);
    if (indexOfHash > -1) {
        search_object.get_attributes.splice(indexOfHash, 1);
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
        object[search_object.hash_attribute] = search_object.hash_value;

        var table_path = base_path +
            search_object.schema + '/' + search_object.table;


        async.map(search_object.get_attributes, function (attribute, caller) {
                var attr_path = table_path + '/' + attribute + '/__hdb_hash/' + search_object.hash_value + '.hdb';

                console.time('readattr');
                readAttribute(attr_path, function (error, data) {
                    console.timeEnd('readattr');

                    if (err) {
                        console.error(err);
                        caller(err);
                        return;
                    }
                    object[attribute] = data;
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

function searchByHashes(search_object, callback) {
    var validation_error = search_validator(search_object, 'hashes');
    if (validation_error) {
        callback(validation_error, null);
        return;
    }

    var results = [];

    var indexOfHash = search_object.get_attributes.indexOf(search_object.hash_attribute);
    if (indexOfHash > -1) {
        search_object.get_attributes.splice(indexOfHash, 1);
    }


    async.map(search_object.hash_values, function (hash, caller) {
        var hash_path = base_path +
            search_object.schema + '/' + search_object.table + '/' + search_object.hash_attribute + '/' + hash;

        console.time('readdir')
        fs.readdir(hash_path, function (err, data) {
            console.timeEnd('readdir')
            if (err) {
               caller();
               return;
            }

            if (!data)
                callback(null, null);


            var object = {};
            object[search_object.hash_attribute] = hash;

            var table_path = base_path +
                search_object.schema + '/' + search_object.table;


            async.map(search_object.get_attributes, function (attribute, caller2) {
                    var attr_path = table_path + '/' + attribute + '/__hdb_hash/' + hash + '.hdb';


                    readAttribute(attr_path, function (error, data) {

                        if (err) {
                            console.error(err);
                            caller2(err);
                            return;
                        }
                        object[attribute] = data;
                        caller2();

                        return;
                    });


                },
                function (err, data) {
                    if (err) {
                        caller(err);
                        return;
                    }
                    results.push(object);
                    caller();
                    return;
                });


        });

    }, function (err, data) {
        if (err) {
            console.error(err);
            callback(err);
            return;
        }

        callback(null, results);
        return;


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

function checkFolderExists(path, callback) {

    console.time('ls');

    let terminal = spawn('bash');
    var results = '';

   terminal.stderr.on('data', function(data) {
        console.error('stderr: ' + data);
        //Here is where the error output goes
    });


    terminal.stdout.on('data', function (data) {

        results += data;
    });


    terminal.on('exit', function (code) {
        console.timeEnd('ls');
        console.log('exit with code ' + code);
        callback(null, results);
    });

    terminal.stdin.write(util.format('sh %s ' + path, settings.PROJECT_DIR + '/bash/search.sh'));
    terminal.stdin.end();


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
    if (stdout.indexOf('./') > -1)
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
search_obj.get_attributes = ['id', 'first_name', 'last_name'];

function getRandomInt(min, max) {
    min = Math.ceil(min);
    max = Math.floor(max);
    search_obj.hash_value = '9870';
    return Math.floor(Math.random() * (max - min)) + min;
}

var number_of_hashes = 1000;
var searchHashes = [];

//var command = "awk '{ print }'"

while (number_of_hashes > 0) {

    //command +=" 'first_name/__hdb_hash/"+getRandomInt(1, 10000)+".hdb' 'last_name/__hdb_hash/"+getRandomInt(1, 10000)+".hdb' ";

    search_obj.hash_values.push(getRandomInt(1, 10000));



    number_of_hashes--;
}
//console.log(command);


search_obj.hash_values.push('a');


 console.time('test');
 searchByHashes(search_obj, function (err, data) {
    if (err)
        console.error(err);
    console.log(data);
    console.timeEnd('test');
});