const UpgradeDirective = require('../UpgradeDirective.js');
const { databases, table } = require('../../resources/databases.ts');
const systemSchema = require('../../json/systemSchema.json');
const log = require('../../utility/logging/harper_logger.js');

let directive470 = new UpgradeDirective('4.7.0');
let directives = [];

async function convertToUsageBlockLicenses() {
	const licenseTable = databases.system?.hdb_license;

	if (!licenseTable) {
		log.debug?.('system.hdb_license table not found; no migration necessary');
		return;
	}

	log.debug?.('Dropping existing system.hdb_license table');
	await licenseTable.dropTable();

	log.debug?.('Creating new usage block system.hdb_license table');
	return table(systemSchema.hdb_license);
}

directive470.async_functions.push(convertToUsageBlockLicenses);

directives.push(directive470);

module.exports = directives;
