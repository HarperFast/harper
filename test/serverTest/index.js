'use strict';
var net = require('net'),
    first_names = require('../data/firstNames'),
    last_names = require('../data/lastNames');

const record_size  = 100;
const schema = 'dev';

var client = new net.Socket();
client.connect(9925, '127.0.0.1', function() {
    console.log('Connected');
    client.write(JSON.stringify(createData()));
});

client.on('data', function(data) {
    console.log('Received: ' + data);
    client.destroy(); // kill client after server's response
});

client.on('close', function() {
    console.log('Connection closed');
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