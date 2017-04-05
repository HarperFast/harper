'use strict';
const fs = require('fs')
    , settings = require('settings')
    , base_path = settings.HDB_ROOT + "/schema/"
    , exec = require('child_process').exec
    , search_validator = require('../validation/searchValidator.js')
    , async = require('async')
    , spawn = require('child_process').spawn
    , util = require('util')
    , schema = require('../data_layer/schema')
    , insert = require('../data_layer/insert.js')
    , search = require('../data_layer/search.js');


function initalize() {

    var terminal = spawn('bash');

    terminal.stderr.on('data', function (data) {
        console.error('stderr: ' + data);
        //Here is where the error output goes
    });


    terminal.stdout.on('data', function (data) {
        console.log('Whole Enchilada:' + data);
        if (data.indexOf('ISDIR') > 0) {
            return;
        }

        var eventData = '' + data;


        var tokens = eventData.split('\n');
        for (var item in tokens) {
            console.log(tokens[item]);
            if (tokens[item])
                eventHandler(tokens[item]);
        }


    });


    terminal.on('exit', function (code) {
        //initalize();
    });

    terminal.stdin.write(util.format('inotifywait -m -r -e create -e delete -e move -e moved_from %s ', settings.HDB_ROOT + '/schema/system'));
    terminal.stdin.end();
}

initalize();


function eventHandler(data) {
    console.log(data);
    var tokens = String(data).split(' ');
    var path = tokens[0];
    var event = tokens[1];
    var file = tokens[2];


        if (path.indexOf('__hdb_hash') < 0 && file.indexOf('__hdb_hash') < 0) {
            // need to remove value in path from path.
            console.log('PATH:' + path);
            console.log('EVENT:' + event);
            console.log('FILE:' + file);

            fs.readFile(path + file.replace('\n', ''), 'utf8', function (err, data) {
                if (err) {
                    console.error('readFileError' + err);
                    initalize();
                    setTimeout(function () {
                        systemHandleEvent(path, file, data, event)
                    }, 2500);
                    return;
                }

                systemHandleEvent(path, file, data, event);

            });
        }



}

function systemHandleEvent(path, file, fileValue, event) {


        if (path.indexOf('hdb_attribute') > 0) {
            console.log('attr event' + data);
            return;
        }

        if (path.indexOf('hdb_table/schema_name') > 0) {
            var tableObject = JSON.parse(fileValue);
            console.log(tableObject);
            var table_object = {};
            table_object.table = tableObject.name;
            table_object.schema = tableObject.schema;
            table_object.hash_attribute = tableObject.hash_attribute;

            console.log('TABLE OBJECT: ' + JSON.stringify(tableObject));
            if (event == 'CREATE') {
                schema.createTableStructure(table_object, function (err, result) {
                    if (err)
                        console.error('createTableError:' + err);


                });
                return;

            }

            schema.deleteTableStructure(table_object, function (err, result) {
                if (err)
                    console.error('deleteTableError' + err);
                return;

            });


        }

        if (path.indexOf('hdb_schema') > 0) {
            var schema_object = {"schema": JSON.parse(fileValue).name};
            if (event == 'CREATE') {
                schema.createSchemaStructure(schema_object, function (err, result) {
                    if (err)
                        console.error('schemaErrpr' + err);

                });
                return;
            }

            schema.deleteSchemaStructure(schema_object, function (err, result) {
                if (err)
                    console.error('deleteSchemaErr' + rerr);


            });

        }


        return;
}

function deleteSchema(name) {
        var schemaObject = makeSchema(path);
        schema.deleteSchemaStructure(schemaObject, function (err, result) {
            if (err)
                console.error(err);

        });

}

