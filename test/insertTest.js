var insert = require('../data_layer/insert.js'),
    settings = require('settings'),
    first_names = require('./firstNames'),
    last_names = require('./lastNames'),
    glob = require('glob'),
    moment = require('moment'),
    cluster = require('cluster'),
    os = require('os'),
    chunk = require('chunk');

/*glob('*-1.hdb', {cwd: '../hdb/schema/dev/person/first_name/', nodir:true}, function(err, data){
    if(err){
        console.error(err);
    } else {
        console.log(data);
    }
});*/








/*insert.insert(insert_object, function(err, data){
    console.log(moment().format() + ' ' + data);
});*/
console.log('blerg');

if (cluster.isMaster) {
    console.log(moment().format() + ' BEGIN!');
    var objects = [];
    for(var x = 0; x < 100000; x++){
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
    var cpu_count = 4;
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
        insert.insert(insert_object, function(err, data){
            console.log(moment().format() + ' ' + data);
        });
    });
    //console.log('work: ' + process.env["OBJECTS"]);
    /*var insert_object = {
        schema :  'dev',
        table:'person',
        hash_attribute: 'id',
        records: JSON.parse(process.env["OBJECTS"])
    };
    insert.insert(insert_object, function(err, data){
        console.log(moment().format() + ' ' + data);
    });*/
    //initializeAPIWorker();
}




