var insert = require('../data_layer/insert.js');
var settings = require('settings');

const insert_object = {
    schema :  'dev',
    table:'person',
    hash_attribute: 'id',
    hash_value : '123',
    object:{
        first_name : 'Kyle',
        last_name: 'Bernhardy'
    }
};

insert.insert(insert_object, function(err, data){
    console.error(err);
});
