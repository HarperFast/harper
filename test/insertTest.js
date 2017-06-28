'use strict'

var insert = require('../data_layer/insert.js'),
    first_names = require('./data/firstNames'),
    last_names = require('./data/lastNames');

/*const record_size  = 1;
const schema = 'dev';

var objects = [];
for(var x = 0; x < record_size; x++){
    objects.push(
        {
            id : x + 1,
            first_name: first_names[Math.floor(Math.random() * first_names.length)],
            last_name: first_names[Math.floor(Math.random() * first_names.length)],
            num_children: Math.floor(Math.random() * (10 - 0)) + 1
        }
    );
}

var insert_object = {
    operation:'insert',
    schema :  'dev',
    table:'person',
    hash_attribute: 'id',
    records: objects
};*/

let insert_object = {
    "operation":"update",
    "schema" :  "dev",
    "table":"dog",
    "records": [
    {
        "id" : 1,
        "dog_name" : "Penny",
        "owner_name": "Kyle",
        "breed_id":154,
        "age":5,
        "weight_lbs":35,
        "adorable":true
    }
]
};

console.time('insertTest');
insert.update(insert_object, function(err, data){
    if(err) {
        console.error(err);
    } else {
        console.log(data);
    }
    console.timeEnd('insertTest');
    process.exit(0);
});