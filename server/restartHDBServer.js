'use strict';

const hdb_utils = require('../utility/common_utils');
const hdb_terms = require('../utility/hdbTerms');
const hdb_license = require('../utility/registration/hdb_license');
const path = require('path');
const fork = require('child_process').fork;

const HDB_SERVER_CWD = __dirname;
const HDB_STOP_ERR = 'Restart had an error trying to stop HDB server.';

/**
 * This function it used by HDB serverParent to stop all HDB core processes and then restart them.
 */
(async function restartHDBServer() {
    try {
        try {
            await hdb_utils.stopProcess(path.join(HDB_SERVER_CWD, hdb_terms.HDB_PROC_NAME));
        } catch(err) {
            console.error(HDB_STOP_ERR);
            throw err;
        }

        const hdb_args = hdb_utils.createForkArgs(path.join(HDB_SERVER_CWD, hdb_terms.HDB_PROC_NAME));
        const license = hdb_license.licenseSearch();
        const mem_value = license.ram_allocation ? hdb_terms.MEM_SETTING_KEY + license.ram_allocation
            : hdb_terms.MEM_SETTING_KEY + hdb_terms.RAM_ALLOCATION_ENUM.DEFAULT;
        const hdb_child = fork(hdb_args[0], [hdb_args[1]], {
            detached: true,
            stdio: 'ignore',
            execArgv: [mem_value]
        });
        hdb_child.unref();
        process.exit(0);
    } catch(err) {
        console.error(err);
        throw err;
    }
})();
