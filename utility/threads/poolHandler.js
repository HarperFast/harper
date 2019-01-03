const _ = require('lodash');
const os = require('os');
const cpus = os.cpus().length;
/**
 *
 * @param pool
 * @param the_array
 * @param chunk_size
 * @param run_module
 * @returns {Promise<Array>}
 */
module.exports = async (pool, the_array, chunk_size, run_module) => {
    let chunks = _.chunk(the_array, chunk_size);
    let results = [];
    console.time(run_module);
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
    console.timeEnd(run_module);
    return results;
};