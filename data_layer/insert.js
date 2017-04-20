'use strict'

const insert_validator = require('../validation/insertValidator.js'),
    fs = require('fs'),
    async = require('async'),
    path = require('path'),
    settings = require('settings'),
    spawn = require('child_process').spawn,
    util = require('util'),
    moment = require('moment'),
    mkdirp = require('mkdirp');

const hdb_path = path.join(settings.HDB_ROOT, '/schema');
const regex = /[^0-9a-z]/gi;
const printf_command = 'printf "%s" > %s &';
const mkdir_command = 'mkdir -p %s';
const cd_command = 'cd %s';
const insert_script_command = 'time dash %s & nohup dash %s >/dev/null 2>&1 & ';
const delete_command = 'rm -f %s';
const symbolic_link_command = 'ln -sfT %s %s';
const shebang = '#!/usr/bin/env bash';
const touch_date_command = 'touch -m -h -d "%s" %s';

module.exports = {
    insert: function (insert_object, callback) {

        //validate insert_object for required attributes
        var validator = insert_validator(insert_object);
        if (validator) {
            callback(validator);
            return;
        }

        //check if schema / table directories exist
        var table_path = path.join(hdb_path, insert_object.schema, insert_object.table);
        /*if (!checkPathExists(table_path)) {
            callback('Table: ' + insert_object.schema + '.' + insert_object.table + ' does not exist');
            return;
        }*/
        //TODO verify hash_attribute is correct for this table

        //preprocess all record attributes
        async.waterfall([
            checkAttributeSchema.bind(null, insert_object),
            writeScripts.bind(null, insert_object.schema, insert_object.table),
            executeScripts
        ], (err) =>{
            if(err){
                callback(err);
                return;
            }

            callback(null, `successfully wrote ${insert_object.records.length} records`);
        });
        /*checkAttributeSchema(insert_object, function(error, attributes, links){
            insert_object(insert_object.schema, insert_object.table, attributes, links, function(err, data){
                if(err) {
                    callback(err);
                    return;
                }

                callback(null, `successfully wrote ${insert_object.records.length} records`);
            });
        });
        */
    }
};

function checkAttributeSchema(insert_object, callerback) {
    //console.time('script_builder')
    var epoch = new Date().valueOf();
    var date = new moment().format(`YYYY-MM-DD HH:mm:ss.${process.hrtime()[1]} ZZ`);

    var insert_objects = [];
    var symbolic_links = [];
    var touch_links = [];

    var folders = {};
    var hash_folders = {};
    var delete_folders = {};
    var base_path = hdb_path + '/' + insert_object.schema + '/' + insert_object.table + '/';
    async.each(insert_object.records, function(record, callback){
        var attribute_objects = [];
        var link_objects = [];

        for(var property in record){
            delete_folders[`${property}/*/${record[insert_object.hash_attribute]}.hdb`] = "";
            var value_stripped = String(record[property]).replace(regex, '').substring(0, 4000);
            var attribute_file_name = record[insert_object.hash_attribute] + '.hdb';
            var attribute_path =  property + '/' + value_stripped;

            hash_folders[property + '/__hdb_hash'] = "";
            attribute_objects.push(util.format(printf_command, record[property].toString().replace(/"/g, '\\\"'), `${property}/__hdb_hash/${attribute_file_name}`));
            if(property !== insert_object.hash_attribute && record[property]) {
                folders[attribute_path] = "";


                link_objects.push(util.format(symbolic_link_command, `../__hdb_hash/${attribute_file_name}`, `${attribute_path}/${attribute_file_name}`));
                //touch_links.push(`${attribute_path}/${attribute_file_name}`);
            } else if(property === insert_object.hash_attribute){
                hash_folders[attribute_path] = "";
                attribute_objects.push(util.format(printf_command, JSON.stringify(record).replace(/"/g, '\\\"'), `${attribute_path}/${record[insert_object.hash_attribute]}-${epoch}.hdb`));
            }
        }
        insert_objects.push(attribute_objects.join('\n'));
        insert_objects.push('wait');
        symbolic_links.push(link_objects.join('\n'));
        callback();
    }, function(err){
        if(err) {
            callerback(err);
            return;
        }

        // insert_objects.unshift(util.format(delete_command, Object.keys(delete_folders).join(" ")));
        insert_objects.unshift(util.format(mkdir_command, Object.keys(hash_folders).join(" ")));
        insert_objects.unshift(util.format(cd_command, base_path));

        //symbolic_links.push(touch_links.length > 0 ? util.format(touch_date_command, date, touch_links.join(' ')): "");

        symbolic_links.unshift(Object.keys(folders).length > 0 ? util.format(mkdir_command, Object.keys(folders).join(" ")) : "");
        symbolic_links.unshift(util.format(cd_command, base_path));

        insert_objects.unshift(shebang);
        symbolic_links.unshift(shebang);

        return callerback(null, insert_objects, symbolic_links);
    });
}

function checkPathExists (path) {
    return fs.existsSync(path);
}

function writeScripts(schema, table, attribute_array, links, callback){
    let date = new moment();
    let part_file_name = `${process.pid}-${date.format('HH:mm:ss.' + process.hrtime()[1])}.sh`;
    let script_path = path.join(settings.HDB_ROOT, `/staging/scripts/${schema}/${table}/${date.format('YYYY-MM-DD')}`);
    let data_script_path = path.join(script_path, `data-${part_file_name}`);
    let link_script_path = path.join(script_path, `link-${part_file_name}`);
    mkdirp(script_path, function (err) {
        if (err) {
            callback(err);
            return;
        }

        async.parallel([
            writeScript.bind(null, data_script_path, attribute_array),
            writeScript.bind(null, link_script_path, links)
        ], function(err, results){

            if(err){
                callback(err);
                return;
            }

            callback(null, results);
        });
    });
}

function writeScript(script_name, data, callback){
    fs.writeFile(script_name,data.join('\n'), function(err, data){
        if(err) {
            callback(err);
        } else {
            callback(null, script_name);
        }
    });
}

function executeScripts(files, callback){
    let terminal = spawn('bash');

    terminal.stdout.on('data', function (data) {
        console.log('stdout: ' + data);
    });

    terminal.stderr.on('data', function (data) {
        console.log('stderr: ' + data);
        //callback(data);
    });

    terminal.on('exit', function (code) {
        callback(null, null);
    });

    terminal.stdin.write(util.format(insert_script_command, files[0], files[1]));
    terminal.stdin.end();
}

/*
function insertObject(schema, table, attribute_array, links, callback) {
    //TODO verify that object has hash attribute defined, if not throw error
    let date = new moment();
    let part_file_name = `${process.pid}-${date.format('HH:mm:ss.' + process.hrtime()[1])}.sh`;
    let script_path = path.join(settings.HDB_ROOT, `/staging/scripts/${schema}/${table}/${date.format('YYYY-MM-DD')}`);

    mkdirp(script_path, function (err) {
        if (err) {
            callback(err);
            return;
        }

        async.parallel([
            function(caller){
                let filename = path.join(script_path, `data-${part_file_name}`);
                fs.writeFile(filename,attribute_array.join('\n'), function(err, data){
                    if(err) {
                        caller(err);
                    } else {
                        caller(null, filename);
                    }
                });
            },
            function(caller){
                let filename = path.join(script_path, `link-${part_file_name}`);
                fs.writeFile(filename,links.join('\n'), function(err, data){
                    if(err) {
                        caller(err);
                    } else {
                        caller(null, filename);
                    }
                });
            }
        ], function(err, results){

            if(err){
                callback(err);
            } else {

                var terminal = spawn('bash');

                terminal.stdout.on('data', function (data) {
                    console.log('stdout: ' + data);
                });

                terminal.stderr.on('data', function (data) {
                    console.log('stderr: ' + data);
                    //callback(data);
                });

                terminal.on('exit', function (code) {

                    callback(null, null);
                });

                terminal.stdin.write(util.format(insert_script_command, results[0], results[1]));
                terminal.stdin.end();
            }
        });
    });

}*/
