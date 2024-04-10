const installer = require('../utility/install/installer');
const hdb_logger = require('../utility/logging/harper_logger');

module.exports = install;

async function install() {
	try {
		await installer.install();
	} catch (err) {
		console.error('There was an error during the install.');
		console.error(err);
		hdb_logger.error(err);
		process.exit(1);
	}
}
