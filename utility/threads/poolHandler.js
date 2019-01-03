"use strict";

const _ = require('lodash');
/**
 * general handler for multi-process pooling, this handler chunks the_array into desired size,
 * executes a module/function  to the pool and sends each chunk.  the handler then puts each returned result (if any) in an array
 * @param pool
 * @param the_array
 * @param chunk_size
 * @param run_module - path to the module or the function to execute in the pool
 * @returns {Promise<Array>}
 */
module.exports = async (pool, the_array, chunk_size, run_module) => {
    let chunks = _.chunk(the_array, chunk_size);
    let results = [];
    await Promise.all(
        chunks.map(async chunk => {
            let return_array = await pool.run(run_module).send(chunk).promise();
            if(return_array) {
                return_array.forEach((ret) => {
                    results.push(ret);
                });
            }
        })
    );
    chunks = undefined;
    return results;
};