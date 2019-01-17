"use strict";

const _ = require('lodash');
const logger = require('../logging/harper_logger');


module.exports = handler;

/**
 * general handler for multi-process pooling, this handler chunks the_array into desired size,
 * executes a module/function  to the pool and sends each chunk.  the handler then puts each returned result (if any) in an array
 * @param pool
 * @param the_array
 * @param chunk_size
 * @param run_module - path to the module or the function to execute in the pool
 * @returns {Promise<Array>}
 */
async function handler(pool, the_array, chunk_size, run_module) {
    let chunks = _.chunk(the_array, chunk_size);
    let results = [];
    await Promise.all(
        chunks.map(async chunk => {
            try {
                let return_array = await pool.run(run_module).send(chunk).promise();
                if (return_array) {
                    return_array.forEach((ret) => {
                        results.push(ret);
                    });
                }
            } catch (e) {
                logger.error(e);
            }
        })
    );
    chunks = undefined;
    return results;
}