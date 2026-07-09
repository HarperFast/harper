'use strict';

const pm2Utils = require('../processManagement/processManagement.js');
const hdbTerms = require('../hdbTerms.ts');

/**
 * Gets a list of all the running Harper processes and calls reload on each one.
 * NOTE: Calling reload on the "Harper" service was causing only some of the processes to restart so I went with the
 * loop and call each individual process approach. I also needed to be sure all processes had been reloaded before calling delete.
 */
(async function () {
	try {
		const hdbProcessMeta = await pm2Utils.describe(hdbTerms.PROCESS_DESCRIPTORS.HDB);
		for (const proc of hdbProcessMeta) {
			await pm2Utils.reload(proc.pm_id);
		}

		await pm2Utils.deleteProcess(hdbTerms.PROCESS_DESCRIPTORS.RESTART_HDB);
		// Once this script has finished reloading all the Harper processes, delete this process from processManagement.
	} catch (err) {
		console.error(err);
		throw err;
	}
})();
