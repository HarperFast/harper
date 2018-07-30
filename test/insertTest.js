'use strict';

const insert = require('../data_layer/insert.js'),
    first_names = require('./data/firstNames'),
    last_names = require('./data/lastNames'),
    randomstring = require('randomstring');


const record_size  = 10000;
const schema = 'dev';

let objects = [];
for(let x = 0; x < record_size; x++){
    objects.push(
        {
            id : x + 1,
            sequence: randomstring.generate(Math.floor(Math.random() * (2000 - 100)))
        }
    );
}

let insert_object = {
    operation:'insert',
    schema :  'dev',
    table:'genome',
    records: objects
};

console.time('insertTest');
insert.insert(insert_object, function(err, data){
    if(err) {
        console.error(err);
    } else {
        console.log(data);
    }
    console.timeEnd('insertTest');
    process.exit(0);
});