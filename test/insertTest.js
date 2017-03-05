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
for(var x = 0; x < 10000; x++){

    objects.push(
        {
            schema :  'dev',
            table:'person',
            hash_attribute: 'id',
            hash_value : x+1,
            object:{
                first_name : first_names[Math.floor(Math.random() * first_names.length)],
                last_name: last_names[Math.floor(Math.random() * last_names.length)]
            }
        }
    );
}

insert.bulkInsert(objects, function(err, data){
    console.error(err);
});
