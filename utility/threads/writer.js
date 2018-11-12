const Pool = require('threads').Pool;
const _ = require('lodash');
const insert = require('../../data_layer/insert');

const NUMBER_OF_CORES = require('os').cpus;

function init(records, schema, table, action){
    let pool = new Pool();
    let chunks = _.chunk(records, NUMBER_OF_CORES);
    let jobs = {};
    pool.run(insert.insert);
    for(let x = 0; x < chunks.length; x++){
        let target_object = {
            operation: 'insert',
            schema: schema,
            table: table,
            records: chunks[x]
        };
        jobs['job' + x] = pool.send(target_object);
    }

    pool
        .on('done', function(job, message) {
            console.log('Job done:', job + ' - ' + message);
        })
        .on('error', function(job, error) {
            console.error('Job errored:', job);
        })
        .on('finished', function() {
            console.log('all done ' + (Date.now() - start)/1000);
            console.log('Everything done, shutting down the thread pool.');
            pool.killAll();
        });
}