const installer = require('../utility/install/installer.js');
const hdbLogger = require('../utility/logging/harper_logger.js');

module.exports = install;

async function install() {
	try {
		await installer.install();
	} catch (err) {
		console.error('There was an error during the install.');
		console.error(err);
		hdbLogger.error(err);
		process.exit(1);
	}
}
