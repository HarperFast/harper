'use strict';

const pm2Utils = require('../processManagement/processManagement.js');
const hdbTerms = require('../hdbTerms.ts');

/**
 * Gets a list of all the running HarperDB processes and calls reload on each one.
 * NOTE: Calling reload on the "HarperDB" service was causing only some of the processes to restart so I went with the
 * loop and call each individual process approach. I also needed to be sure all processes had been reloaded before calling delete.
 */
(async function restartHdb() {
	try {
		const hdbProcessMeta = await pm2Utils.describe(hdbTerms.PROCESS_DESCRIPTORS.HDB);
		for (const proc of hdbProcessMeta) {
			await pm2Utils.reload(proc.pm_id);
		}

		// Once this script has finished reloading all the HarperDB processes, delete this process from processManagement.
		await pm2Utils.deleteProcess(hdbTerms.PROCESS_DESCRIPTORS.RESTART_HDB);
	} catch (err) {
		console.error(err);
		throw err;
	}
})();
