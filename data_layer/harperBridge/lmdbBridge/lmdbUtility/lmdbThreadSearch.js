'use strict';

const ThreadSearchObject = require('./ThreadSearchObject');
const lmdb_search = require('./lmdbSearch');
const environment_utility = require('../../../../utility/lmdb/environmentUtility');
const init_paths = require('./initializePaths');
const uuid = require('uuid');
const fs = require('fs-extra');

process.on('message', searcher);

/**
 *
 * @param {ThreadSearchObject} thread_search_object
 */
async function searcher(thread_search_object){
    try {
        let results = await lmdb_search.executeSearch(thread_search_object.search_object, thread_search_object.search_type, thread_search_object.hash_attribute, thread_search_object.return_map);
        let env = await environment_utility.openEnvironment(init_paths.getSystemSchemaPath(), 'hdb_temp');

        environment_utility.initializeDBIs(env, 'id', ['id']);
        let results_id = uuid.v4();
        let txn = env.beginTxn();
        console.time('stringify');
        let j = JSON.stringify(results);
        console.timeEnd('stringify');
        console.time('thread');

        console.time('while');


        console.timeEnd('while');

        txn.putString(env.dbis['id'], results_id, j);
        txn.commit();
        console.timeEnd('thread');
        process.send(results_id);
    }catch(e){
        process.send({error: e.message, stack: e.stack});
    }
}

module.exports = searcher;