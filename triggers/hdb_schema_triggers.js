'use strict';
const winston = require('winston');
const PropertiesReader = require('properties-reader'),
hdb_properties = PropertiesReader(`${process.cwd()}/../hdb_boot_properties.file`);
hdb_properties.append(hdb_properties.get('settings_path'));

winston.configure({
    transports: [
        new (winston.transports.File)({filename: 'hdb_triggers.log'})
    ]
});

const fs = require('fs')
    , base_path = hdb_properties.get('HDB_ROOT') + "/schema/"
    , async = require('async')
    , spawn = require('child_process').spawn
    , util = require('util')
    , schema = require('../data_layer/schema')
    , attribute_trigger = require('./attribute_trigger');


function initalize() {

    var terminal = spawn('bash');

    terminal.stderr.on('data', function (data) {
        winston.error('stderr: ' + data);
        //Here is where the error output goes
    });


    terminal.stdout.on('data', function (data) {
        parseEventData(data);


    });


    terminal.on('exit', function (code) {
        // initalize();
    });

    terminal.stdin.write(util.format('inotifywait -o hdb_inotify -m -r -e create -e delete -e move -e moved_from %s ', hdb_properties.get('HDB_ROOT') + '/schema/system'));
    terminal.stdin.end();
}

function parseEventData(data) {
    winston.log("EVENT DATA PACKET:" + data);

    var eventData = '' + data;


    var tokens = eventData.split('\n');
    for (var item in tokens) {
        winston.log(tokens[item]);
        if (tokens[item])
            eventHandler(tokens[item]);
    }
}


function eventHandler(data) {
    winston.log(data);
    var tokens = String(data).split(' ');
    var path = tokens[0];
    var event = tokens[1];
    var file = tokens[2];

    if (data.indexOf('ISDIR') > 0) {
        return;
    }


    if (path.indexOf('__hdb_hash') < 0 && file.indexOf('__hdb_hash') < 0) {
        // need to remove value in path from path.
        winston.log('PATH:' + path);
        winston.log('EVENT:' + event);
        winston.log('FILE:' + file);
        systemHandleEvent(path, file, event);

    }


}

function systemHandleEvent(path, file, event) {


    if (path.indexOf('hdb_table/id') > 0) {
        fs.readFile(path + file.replace('\n', ''), 'utf8', function (err, data) {
            if (err) {
                winston.error('readFileError' + err);
                return;
            }

            var tableObject = JSON.parse(data);
            winston.log(tableObject);
            var table_object = {};
            table_object.table = tableObject.name;
            table_object.schema = tableObject.schema;
            table_object.hash_attribute = tableObject.hash_attribute;

            winston.log('TABLE OBJECT: ' + JSON.stringify(tableObject));
            if (event == 'CREATE') {
                schema.createTableStructure(table_object, function (err, result) {
                    if (err) {
                        winston.error('createTableError:' + err);
                    } else {

                        attribute_trigger.fireTableTrigger(tableObject);

                    }


                });


            } else {
                schema.deleteTableStructure(table_object, function (err, result) {
                    if (err)
                        winston.error('deleteTableError' + err);
                    return;

                });
            }


        });


    }

    if (path.indexOf('hdb_schema/name') > 0) {


        var schema_object = {"schema": file.split("-")[0]};
        if (event == 'CREATE') {
            schema.createSchemaStructure(schema_object, function (err, result) {
                if (err) {
                    winston.error('schemaError' + err);
                    return;
                }

                return;

            });

        } else {
            schema.deleteSchemaStructure(schema_object, function (err, result) {
                if (err)
                    winston.error('deleteSchemaErr' + err);


            });
        }


    }


    return;
}

function deleteSchema(name) {
    var schemaObject = makeSchema(path);
    schema.deleteSchemaStructure(schemaObject, function (err, result) {
        if (err)
            winston.error(err);

    });

}


initalize();
//parseEventData("/home/stephen/hdb/schema/system/hdb_schema/name/dev/ CREATE dev-1491497413605.hdb")
//parseEventData("/home/stephen/hdb/schema/system/hdb_table/id/9eb52e5c96e94b5486d5f628e579685c/ CREATE 9eb52e5c-96e9-4b54-86d5-f628e579685c-1491493900895.hdb");
