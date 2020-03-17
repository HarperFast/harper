'use strict';

const ThreadSearchObject = require('./ThreadSearchObject');
const lmdb_search = require('./lmdbSearch');

process.on('message', searcher);

/**
 *
 * @param {ThreadSearchObject} thread_search_object
 */
async function searcher(thread_search_object){
    try {
        let results = await lmdb_search.executeSearch(thread_search_object.search_object, thread_search_object.search_type, thread_search_object.hash_attribute, thread_search_object.return_map);

        process.send(results);
    }catch(e){
        process.send({error: e.message, stack: e.stack});
    }
}

module.exports = searcher;