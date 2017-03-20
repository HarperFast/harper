'use strict'

var insert = require('../data_layer/insert.js'),
    first_names = require('./data/firstNames'),
    last_names = require('./data/lastNames');

const record_size  = 1000;
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
    if(err) {
        console.error(err);
    }
    console.timeEnd('insertTest');
    //process.exit(0);
});