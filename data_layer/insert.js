'use strict'

const insert_validator = require('../validation/insertValidator.js'),
    fs = require('fs'),
    async = require('async'),
    path = require('path'),
    settings = require('settings'),
    spawn = require('child_process').spawn,
    util = require('util');

const hdb_path = path.join(settings.HDB_ROOT, '/schema');
const regex = /[^0-9a-z]/gi;
const printf_command = 'printf "%s" > %s';
const mkdir_command = 'mkdir -p %s';
const cd_command = 'cd %s';
const insert_script_command = 'sh %s';
const shebang = '#!/usr/bin/env bash';

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
        if (!checkPathExists(table_path)) {
            callback('Table: ' + insert_object.schema + '.' + insert_object.table + ' does not exist');
            return;
        }
        //TODO verify hash_attribute is correct for this table

        //preprocess all record attributes
        checkAttributeSchema(insert_object, function(error, attributes){
            insertObject(attributes, function(err, data){
                if(err) {
                    callback(err);
                    return;
                }

                callback(null, `successfully wrote ${insert_object.records.length} records`);
            });
        });

    }
};

function checkAttributeSchema(insert_object, callerback) {
    //console.time('script_builder');

    var date = new Date().getTime();
    var insert_objects = [];
    var folders = {};
    var base_path = hdb_path + '/' + insert_object.schema + '/' + insert_object.table + '/';
    async.each(insert_object.records, function(record, callback){
        var attribute_objects = [];
        for(var property in record){
            var value_stripped = String(record[property]).replace(regex, '').substring(0, 4000);
            var attribute_file_name = property === insert_object.hash_attribute ? `${record[insert_object.hash_attribute]}-${date}.hdb` :
                record[insert_object.hash_attribute] + '.hdb';
            var attribute_path =  property + '/' + value_stripped;
            var value = property === insert_object.hash_attribute ? JSON.stringify(record).replace(/"/g, '\\\"') : record[property];
            folders[attribute_path] = "";
            folders[property + '/__hdb_hash'] = "";
            attribute_objects.push(util.format(printf_command, value, `${attribute_path}/${attribute_file_name}`));
            if(property !== insert_object.hash_attribute) {
                attribute_objects.push(util.format(printf_command, value, `${property}/__hdb_hash/${attribute_file_name}`));
            }
        }
        //joining the attribute printf commands with & allows all printfs to execute together
        insert_objects.push(attribute_objects.join('\n'));
        callback();
    }, function(err){
        //console.timeEnd('script_builder');

        insert_objects.unshift(util.format(mkdir_command, Object.keys(folders).join(" ")));
        insert_objects.unshift(util.format(cd_command, base_path));
        //insert_objects.unshift(shebang);

        return callerback(null, insert_objects);
    });
}

function checkPathExists (path) {
    return fs.existsSync(path);
}

function insertObject(attribute_array, callback) {
    //TODO verify that object has hash attribute defined, if not throw error

    var filename = path.join(settings.HDB_ROOT, `/staging/scripts/${process.pid}-${new Date().getTime()}-${process.hrtime()[1]}.sh`);
    //console.time('file_write');
    fs.writeFile(filename,attribute_array.join('\n'), function(err, data){
        //console.timeEnd('file_write');
        //console.time('script_run');

        var terminal = spawn('bash');

        terminal.stdout.on('data', function (data) {
            console.log('stdout: ' + data);
        });

        terminal.stderr.on('data', function (data) {
            console.log('stderr: ' + data);
            callback(data);
        });

        terminal.on('exit', function (code) {
          //  console.timeEnd('script_run');
            callback(null, null);
        });

        terminal.stdin.write(util.format(insert_script_command, filename));
        terminal.stdin.end();
    });
}