'use strict';

const insert = require('../data_layer/insert.js'),
    randomstring = require('randomstring'),
    winston = require('../utility/logging/winston_logger');




let insert_object = {
    operation:'update',
    schema :  'dev',
    table:'genome',
    records: [
        {
            id:559,
            sequence:"kyle rocks this shit"
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