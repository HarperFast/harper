'use strict';
const PropertiesReader = require('properties-reader'),
    hdb_properties = PropertiesReader('/etc/hdb_boot_properties.file');
hdb_properties.append(hdb_properties.get('settings_path'));

const fs = require('fs')
    , base_path = hdb_properties.get('HDB_ROOT') + "/schema/"
    , exec = require('child_process').exec
    , search_validator = require('../validation/searchValidator.js')
    , async = require('async')
    , spawn = require('child_process').spawn
    , util = require('util')
    , schema = require('../data_layer/schema')
    , insert = require('../data_layer/insert.js')
    , search = require('../data_layer/search.js');



module.exports = {
    fireTableTrigger: spinUpTableTrigger

};

function initialize(){

    var search_obj = {};
    search_obj.schema = 'system';
    search_obj.table = 'hdb_table';
    search_obj.hash_attribute = 'id';
    search_obj.search_attribute = 'name';
    search_obj.search_value = '*'
    search_obj.hash_values = [];
    search_obj.get_attributes = ['hash_attribute', 'id', 'name', 'schema'];
    search.searchByValue(search_obj, function (err, tables) {
        if (err) {
            console.error(err);
            //initialize();
            return;
        }

        async.map(tables, function(table, caller){
           spinUpTableTrigger(table);

        },function(err, data){
            return;
            //initialize()

        });



    });




}


function spinUpTableTrigger(table){



    var terminal = spawn('bash');

    terminal.stderr.on('data', function (data) {
        console.error('stderr: ' + data);
        //Here is where the error output goes
    });


    terminal.stdout.on('data', function (data) {

        var eventData = '' + data;


        var events = eventData.split('\n');
        for (var item in events) {
            console.log(events[item]);
            if (events[item]){
                console.log(data);
                var tokens = String(events[item]).split(' ');
                var path = tokens[0];
                var event = tokens[1];
                var folder = tokens[2].replace('\n','');
                // /home/stephen/hdb/schema/dev/person/ CREATE,ISDIR first_name
                var create_attribute_object = {};
                create_attribute_object.attribute = folder;
                create_attribute_object.table = table.name;
                create_attribute_object.schema = table.schema;
                schema.createAttribute(create_attribute_object, function(err, data){
                    if(err){
                        console.error(err);
                        //initialize();
                    }
                    console.log(data);
                });
            }

        }










    });


    terminal.on('exit', function (code) {
        //initalize();
    });

    // change this to monitor __hdb_hash instead then can avoid picking up this folder.

    terminal.stdin.write(util.format('inotifywait -m  -e create  %s ', hdb_properties.get('HDB_ROOT') + '/schema/' +table.schema + '/' + table.name));
    terminal.stdin.end();

    console.log("trigger fired:" +'inotifywait -m  -e create  %s ', hdb_properties.get('HDB_ROOT') + '/schema/' +table.schema + '/' + table.name );


}

initialize();