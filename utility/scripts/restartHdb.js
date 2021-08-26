'use strict';

const pm2_utils = require('../pm2/utilityFunctions');
const hdb_terms = require('../hdbTerms');

/**
 * Gets a list of all the running HarperDB processes and calls reload on each one.
 * NOTE: Calling reload on the "HarperDB" service was causing only some of the processes to restart so I went with the
 * loop and call each individual process approach. I also needed to be sure all processes had been reloaded before calling delete.
 */
(async function restartHdb() {
    try {
        const hdb_process_meta = await pm2_utils.describe(hdb_terms.PROCESS_DESCRIPTORS.HDB);
        for (const proc of hdb_process_meta) {
            await pm2_utils.reload(proc.pm_id);
        }

        // Once this script has finished reloading all the HarperDB processes, delete this process from pm2.
        await pm2_utils.deleteProcess(hdb_terms.PROCESS_DESCRIPTORS.RESTART_HDB);
    } catch(err) {
        console.error(err);
        throw err;
    }
})();