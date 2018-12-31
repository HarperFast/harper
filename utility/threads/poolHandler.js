const _ = require('lodash');

/**
 *
 * @param pool
 * @param the_array
 * @param chunk_size
 * @param run_moduke
 * @returns {Promise<Array>}
 */
module.exports = async (pool, the_array, chunk_size, run_moduke) => {
    let chunks = _.chunk(the_array, chunk_size);
    let results = [];
    await Promise.all(
        chunks.map(async chunk => {
            let return_array = await pool.run(run_moduke).send(chunk).promise();
            if(return_array) {
                return_array.forEach((ret) => {
                    results.push(ret);
                });
            }
        })
    );

    return results;
};