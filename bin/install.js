const installer = require('../utility/install/installer');
const hdb_logger = require('../utility/logging/harper_logger');
const hdb_terms = require('../utility/hdbTerms');

module.exports = install;

async function install() {
	try {
		hdb_logger.createLogFile(hdb_terms.PROCESS_LOG_NAMES.INSTALL, hdb_terms.PROCESS_DESCRIPTORS.INSTALL);
		await installer();
	} catch (err) {
		console.error('There was an error during the install.');
		console.error(err);
		hdb_logger.error(err);
		process.exit(1);
	}
}
