var insert = require('../data_layer/insert.js'),
    settings = require('settings'),
    first_names = require('./firstNames'),
    last_names = require('./lastNames'),
    glob = require('glob');

/*glob('*-1.hdb', {cwd: '../hdb/schema/dev/person/first_name/', nodir:true}, function(err, data){
    if(err){
        console.error(err);
    } else {
        console.log(data);
    }
});*/
var objects = [];
for(var x = 0; x < 10; x++){
    objects.push(
        {
            id : x + 1,
            first_name: first_names[Math.floor(Math.random() * first_names.length)],
            last_name: last_names[Math.floor(Math.random() * last_names.length)]
        }
    );
}

var insert_object = {
    schema :  'dev',
    table:'person',
    hash_attribute: 'id',
    records: objects
};

insert.insert(insert_object, function(err, data){
    console.error(err);
    console.log(data);
});
