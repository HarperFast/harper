'use strict'

const insert_validator = require('../validation/insertValidator.js'),
    fs = require('fs'),
    async = require('async'),
    path = require('path'),
    settings = require('settings'),
    spawn = require('child_process').spawn,
    util = require('util');

const hdb_path = path.join(settings.PROJECT_DIR, '/hdb/schema');
const regex = /[^0-9a-z]/gi;
const printf_command = 'printf "%s" > %s';
const mkdir_command = 'mkdir -p %s';
const cd_command = 'cd %s';
const insert_script_command = 'time sh %s';
const shebang = '#!/usr/bin/env bash';

module.exports = {
    insert: function (insert_object, callback) {
        //TODO move this all into async waterfall
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
                callback(null, 'success');
            });
        });

    }
};

function checkAttributeSchema(insert_object, callerback) {
    console.time('script_builder');
    //var attributes = [insert_object.hash_attribute];
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
            var value = property === insert_object.hash_attribute ? JSON.stringify(record) : record[property];
            folders[attribute_path] = "";
            attribute_objects.push(util.format(printf_command, value, attribute_path + '/' + attribute_file_name));
        }
        //joining the attribute printf commands with & allows all printfs to execute together
        insert_objects.push(attribute_objects.join(' & '));
        callback();
    }, function(err){
        console.timeEnd('script_builder');

        insert_objects.unshift(util.format(mkdir_command, Object.keys(folders).join(" ")));
        insert_objects.unshift(util.format(cd_command, base_path));
        insert_objects.unshift(shebang);

        return callerback(null, insert_objects);
    });
}

function checkPathExists (path) {
    return fs.existsSync(path);
}

function insertObject(attribute_array, callback) {
    //TODO verify that object has hash attribute defined, if not throw error

    var filename = path.join(settings.PROJECT_DIR, `hdb/staging/scripts/${process.pid}-${new Date().getTime()}-${process.hrtime()[1]}.sh`);
    console.time('file_write');
    fs.writeFile(filename,attribute_array.join('\n'), function(err, data){
        console.timeEnd('file_write');
        console.time('script_run');

        var terminal = spawn('bash');

        terminal.stdout.on('data', function (data) {
            console.log('stdout: ' + data);
        });

        terminal.on('exit', function (code) {
            console.log('child process exited with code ' + code);
            console.timeEnd('script_run');
            callback(null, null);
        });

        terminal.stdin.write(util.format(insert_script_command, filename));
        terminal.stdin.end();
    });
}