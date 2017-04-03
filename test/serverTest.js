'use strict';
var net = require('net'),
    first_names = require('./data/firstNames'),
    last_names = require('./data/lastNames'),
    ReadStream = require('../lib/streams/ReadableStream');

const args = processArgs();
const port = args.port ? args.port : 9925;
const address = args.address ? args.address : '127.0.0.1';
const record_size = args.record_size ? args.record_size : 10000;
const schema = args.schema ? args.schema : 'dev';

function processArgs(){
    let arg_object = {};
    if(process.argv.length > 2) {
        process.argv.slice(2).forEach(function (arg) {
            let arg_array = arg.split('=');
            arg_object[arg_array[0]] = arg_array[1];
        });
    }

    return arg_object;
}

var client = new net.Socket();
client.connect(port, address, function() {
    console.log('Connected');
    client.write(JSON.stringify(createData()));
});

client.on('data', function(data) {
    console.log('Received: ' + data);
});

client.on('close', function() {
    console.log('Connection closed');
});

client.on('err', function(err) {
    console.error(err);
});


function createData(){
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

    return {
        schema :  schema,
        table:'person',
        hash_attribute: 'id',
        records: objects
    };
}
