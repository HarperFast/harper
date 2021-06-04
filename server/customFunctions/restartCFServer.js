'use strict';

const hdb_utils = require('../../utility/common_utils');
const hdb_terms = require('../../utility/hdbTerms');
const path = require('path');
const fork = require('child_process').fork;

const CF_SERVER_CWD = path.resolve(__dirname, '../customFunctions');
const CF_STOP_ERR = 'Restart had an error trying to stop Custom Functions server.';

/**
 * This function it used by customFunctions/serverParent to stop all CF processes and then restart them.
 */
(async function restartCFServer() {
    try {
        try {
            await hdb_utils.stopProcess(path.join(CF_SERVER_CWD, hdb_terms.CUSTOM_FUNCTION_PROC_NAME));
        } catch(err) {
            console.error(CF_STOP_ERR);
            console.error(err);
            throw err;
        }

        const cf_args = hdb_utils.createForkArgs(path.join(CF_SERVER_CWD, hdb_terms.CUSTOM_FUNCTION_PROC_NAME));
        const cf_child = fork(cf_args[0], [cf_args[1]], {
            detached: true,
            stdio: 'ignore'
        });
        cf_child.unref();
        process.exit(0);
    } catch(err) {
        console.error(err);
        throw err;
    }
})();
