'use strict'

var insert = require('../data_layer/insert.js'),
    settings = require('settings'),
    first_names = require('./data/firstNames'),
    last_names = require('./data/lastNames'),
    moment = require('moment'),
    cluster = require('cluster'),
    os = require('os'),
    chunk = require('chunk');

const record_size  = 65000;
const schema = 'dev';
const worker_count = 1;
console.time('build_data');
var objects = [];
for(var x = 0; x < record_size; x++){
    objects.push(
        {
            id : x + 1,
            first_name: first_names[Math.floor(Math.random() * first_names.length)],
            last_name: last_names[Math.floor(Math.random() * last_names.length)]
        }
    );
}

var insert_object = {
    schema :  schema,
    table:'person',
    hash_attribute: 'id',
    records: objects
};
console.timeEnd('build_data');
console.time('insertTest');
insert.insert(insert_object, function(err, data){

    console.timeEnd('insertTest');
    //process.exit(0);
});
/*
if (cluster.isMaster) {
    console.log(moment().format() + ' ' + process.hrtime()[1] + ' BEGIN!');
    var objects = [];
    for(var x = 0; x < record_size; x++){
        objects.push(
            {
                id : x + 1,
                first_name: first_names[Math.floor(Math.random() * first_names.length)],
                last_name: last_names[Math.floor(Math.random() * last_names.length)]
            }
        );
    }

    var insert_object = {
        schema :  schema,
        table:'person',
        hash_attribute: 'id',
        records: objects
    };
    var cpu_count = worker_count;
    var chunks = chunk(objects, objects.length / cpu_count);
    for (var i = 0; i < cpu_count; i += 1) {
        cluster.fork().send({objects: chunks[i]});
    }
} else {
    process.on('message', function(msg) {
        //console.log('Worker ' + process.pid + ' received message from master.', msg);
        var insert_object = {
            schema :  'dev',
            table:'person',
            hash_attribute: 'id',
            records: msg.objects
        };
        var start = process.hrtime();
        insert.insert(insert_object, function(err, data){
            var diff = process.hrtime(start);
            console.log(`inserting ${insert_object.records.length} records took ${(diff[0] * 1e9 + diff[1]) / 1e9} seconds`);
            process.exit(0);
        });
    });
}*/





