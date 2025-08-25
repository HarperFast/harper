'use strict';

const path = require('path');
const fs = require('fs-extra');
const UpgradeDirective = require('../UpgradeDirective.js');
const hdbLog = require('../../utility/logging/harper_logger.js');
const configUtils = require('../../config/configUtils.js');
const env = require('../../utility/environment/environmentManager.js');
const terms = require('../../utility/hdbTerms.ts');
const commonUtils = require('../../utility/common_utils.js');
const PropertiesReader = require('properties-reader');
const SearchObj = require('../../dataLayer/SearchObject.js');
const UpdateObj = require('../../dataLayer/UpdateObject.js');
const search = require('../../dataLayer/search.js');
const util = require('util');
const pSearchByValue = search.searchByValue;
const insert = require('../../dataLayer/insert.js');
const routes = require('../../utility/clustering/routes.js');
const natsTerms = require('../../server/nats/utility/natsTerms.js');
const reindexUpgrade = require('./upgrade_scripts/4_0_0_reindex_script.js');
const keys = require('../../security/keys.js');
const upgradePrompts = require('../upgradePrompt.js');

let directive400 = new UpgradeDirective('4.0.0');
let directives = [];

let oldCertPath;
let oldPrivatePath;

async function generateNewKeys() {
	try {
		const generateCerts = await upgradePrompts.upgradeCertsPrompt();
		if (generateCerts) {
			console.log(`Generating new certificates.`);
			if (oldCertPath) {
				const certBak = commonUtils.changeExtension(oldCertPath, '.bak');
				await fs.move(oldCertPath, certBak);
			}

			if (oldPrivatePath) {
				const keyBak = commonUtils.changeExtension(oldPrivatePath, '.bak');
				await fs.move(oldPrivatePath, keyBak);
			}

			await keys.generateKeys();
		} else {
			console.log('Using existing certificates.');
			keys.updateConfigCert(oldCertPath, oldPrivatePath, undefined);
		}
	} catch (err) {
		console.error('There was a problem generating new keys. Please check the log for details.');
		throw err;
	}
}

/**
 * For each node in hdbNodes table creates a route in harperdb-config.yaml, splits
 * channel subscription param to schema & table and adds system_info param.
 * @returns {Promise<void>}
 */
async function updateNodes() {
	console.log('Updating HarperDB nodes.');
	hdbLog.info('Updating HarperDB nodes.');

	let routesArray = [];
	try {
		const getAllNodesQry = new SearchObj(
			terms.SYSTEM_SCHEMA_NAME,
			terms.SYSTEM_TABLE_NAMES.NODE_TABLE_NAME,
			'name',
			'*',
			'name',
			['*']
		);

		const allNodes = Array.from(await pSearchByValue(getAllNodesQry));
		let updatedNodes = [];
		for (let x = 0, allLength = allNodes.length; x < allLength; x++) {
			const nodeRecord = allNodes[x];

			if (!natsTerms.NATS_TERM_CONSTRAINTS_RX.test(nodeRecord.name)) {
				const invalidNodeName = `Node name '${node_record.name}' is invalid, must not contain ., * or >. Please change name and try again.`;
				console.error(invalidNodeName);
				throw invalidNodeName;
			}

			const route = {
				host: nodeRecord.host,
				port: nodeRecord.port,
			};
			routesArray.push(route);

			let updatedSubs = [];
			for (let i = 0, allSubsLength = nodeRecord.subscriptions.length; i < allSubsLength; i++) {
				const sub = nodeRecord.subscriptions[i];
				const schemaTable = sub.channel.split(':');
				updatedSubs.push({
					schema: schemaTable[0],
					table: schemaTable[1],
					publish: sub.publish,
					subscribe: sub.subscribe,
				});
			}

			updatedNodes.push({
				name: nodeRecord.name,
				subscriptions: updatedSubs,
				system_info: {
					hdb_version: terms.PRE_4_0_0_VERSION,
					node_version: undefined,
					platform: undefined,
				},
			});
		}

		if (commonUtils.isEmptyOrZeroLength(updatedNodes)) return;

		const updateQry = new UpdateObj(terms.SYSTEM_SCHEMA_NAME, terms.SYSTEM_TABLE_NAMES.NODE_TABLE_NAME, updatedNodes);
		await insert.update(updateQry);
	} catch (err) {
		console.error('There was a problem updating the hdb_nodes table. Please check the log for details.');
		throw err;
	}

	try {
		routes.setRoutes({
			server: 'hub',
			routes: routesArray,
		});
	} catch (err) {
		console.error('There was a problem setting the clustering routes. Please check the log for details.');
		throw err;
	}
}

async function updateSettingsFile400() {
	const settings_path = env.get(terms.HDB_SETTINGS_NAMES.SETTINGS_PATH_KEY);
	// If the pre 4.0.0 settings file doesn't exist skip settings file update
	if (!settings_path.includes(path.join('config', 'settings.js'))) {
		hdbLog.info('pre 4.0.0 settings.js file not found, skipping settings file update');
		return;
	}

	const settingsUpdateMsg = 'Updating settings file for version 4.0.0';
	console.log(settingsUpdateMsg);
	hdbLog.info(settingsUpdateMsg);

	const settingsDir = path.dirname(settings_path);
	const hdbRoot = env.get(terms.HDB_SETTINGS_NAMES.HDB_ROOT_KEY);
	const settingsBackupPath = path.join(hdbRoot, 'backup', '4_0_0_upgrade_settings.bak');
	const newSettingsPath = path.join(hdbRoot, terms.HDB_CONFIG_FILE);

	try {
		// Create backup of old settings file.
		hdbLog.info(`Backing up old settings file to: ${settingsBackupPath}`);
		console.log(`Backing up old settings file to: ${settingsBackupPath}`);
		fs.copySync(settings_path, settingsBackupPath);
	} catch (err) {
		console.error(
			'There was a problem writing the backup for the old settings file. Please check the log for details.'
		);
		throw err;
	}

	// Create the new config file with old settings info.
	try {
		hdbLog.info(`Creating new/upgraded settings file at '${new_settings_path}'`);
		console.log(`Creating new/upgraded settings file at '${new_settings_path}'`);
		hdbLog.info('Updating env variables with new settings values');
		const flatConfigObj = configUtils.initOldConfig(settings_path);

		// These are stored here in case they are needed by the generateNewKeys function,
		oldCertPath = flatConfigObj[terms.CONFIG_PARAMS.TLS_CERTIFICATE.toLowerCase()];
		oldPrivatePath = flatConfigObj[terms.CONFIG_PARAMS.TLS_PRIVATEKEY.toLowerCase()];

		configUtils.createConfigFile(flatConfigObj);
	} catch (err) {
		console.log('There was a problem creating the new HarperDB config file. Please check the log for details.');
		throw err;
	}

	// Rewrite the boot properties file with user and new settings path before initSync is called
	const bootPropPath = commonUtils.getPropsFilePath();
	fs.accessSync(bootPropPath, fs.constants.F_OK | fs.constants.R_OK);

	const hdbPropsFile = PropertiesReader(bootPropPath);
	const install_user = hdbPropsFile.get(terms.HDB_SETTINGS_NAMES.INSTALL_USER);
	const bootPropsUpdate = `settings_path = ${newSettingsPath}
	install_user = ${install_user}`;

	try {
		fs.writeFileSync(bootPropPath, bootPropsUpdate);
	} catch (err) {
		console.log('There was a problem updating the HarperDB boot properties file. Please check the log for details.');
		throw err;
	}

	// load new props into env
	try {
		env.initSync(true);
	} catch (err) {
		console.error('Unable to initialize new properties. Please check the log for details.');
		throw err;
	}

	const upgradeSuccessMsg = 'New settings file for 4.0.0 upgrade successfully created.';

	try {
		fs.removeSync(settingsDir);
		console.log(upgradeSuccessMsg);
		hdbLog.info(upgradeSuccessMsg);
	} catch (err) {
		console.error(
			'There was a problem deleting the old settings file and directory. Please check the log for details.'
		);
		throw err;
	}
}

directive400.async_functions.push(updateSettingsFile400);
directive400.async_functions.push(generateNewKeys);
directive400.async_functions.push(reindexUpgrade);
directive400.async_functions.push(updateNodes);

directives.push(directive400);

module.exports = directives;
