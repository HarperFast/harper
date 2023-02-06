'use strict';

const path = require('path');
const fs = require('fs-extra');
const UpgradeDirective = require('../UpgradeDirective');
const hdb_log = require('../../utility/logging/harper_logger');
const config_utils = require('../../config/configUtils');
const env = require('../../utility/environment/environmentManager');
const terms = require('../../utility/hdbTerms');
const common_utils = require('../../utility/common_utils');
const PropertiesReader = require('properties-reader');
const SearchObj = require('../../data_layer/SearchObject');
const UpdateObj = require('../../data_layer/UpdateObject');
const search = require('../../data_layer/search');
const util = require('util');
const p_search_by_value = util.promisify(search.searchByValue);
const insert = require('../../data_layer/insert');
const routes = require('../../utility/clustering/routes');
const nats_terms = require('../../server/nats/utility/natsTerms');
const reindex_upgrade = require('./upgrade_scripts/4_0_0_reindex_script');
const generate_keys = require('../../security/keys');
const upgrade_prompts = require('../upgradePrompt');

let directive4_0_0 = new UpgradeDirective('4.0.0');
let directives = [];

async function generateNewKeys() {
	console.log(`Generating new keys.`);
	try {
		const generate_certs = await upgrade_prompts.upgradeCertsPrompt();
		if (generate_certs) await generate_keys();
	} catch (err) {
		console.error('There was a problem generating new keys. Please check the log for details.');
		throw err;
	}
}

/**
 * For each node in hdb_nodes table creates a route in harperdb-config.yaml, splits
 * channel subscription param to schema & table and adds system_info param.
 * @returns {Promise<void>}
 */
async function updateNodes() {
	console.log('Updating HarperDB nodes.');
	hdb_log.info('Updating HarperDB nodes.');

	let routes_array = [];
	try {
		const get_all_nodes_qry = new SearchObj(
			terms.SYSTEM_SCHEMA_NAME,
			terms.SYSTEM_TABLE_NAMES.NODE_TABLE_NAME,
			'name',
			'*',
			'name',
			['*']
		);

		const all_nodes = await p_search_by_value(get_all_nodes_qry);
		let updated_nodes = [];
		for (let x = 0, all_length = all_nodes.length; x < all_length; x++) {
			const node_record = all_nodes[x];

			if (!nats_terms.NATS_TERM_CONSTRAINTS_RX.test(node_record.name)) {
				const invalid_node_name = `Node name '${node_record.name}' is invalid, must not contain ., * or >. Please change name and try again.`;
				console.error(invalid_node_name);
				throw invalid_node_name;
			}

			const route = {
				host: node_record.host,
				port: node_record.port,
			};
			routes_array.push(route);

			let updated_subs = [];
			for (let i = 0, all_subs_length = node_record.subscriptions.length; i < all_subs_length; i++) {
				const sub = node_record.subscriptions[i];
				const schema_table = sub.channel.split(':');
				updated_subs.push({
					schema: schema_table[0],
					table: schema_table[1],
					publish: sub.publish,
					subscribe: sub.subscribe,
				});
			}

			updated_nodes.push({
				name: node_record.name,
				subscriptions: updated_subs,
				system_info: {
					hdb_version: terms.PRE_4_0_0_VERSION,
					node_version: undefined,
					platform: undefined,
				},
			});
		}

		if (common_utils.isEmptyOrZeroLength(updated_nodes)) return;

		const update_qry = new UpdateObj(terms.SYSTEM_SCHEMA_NAME, terms.SYSTEM_TABLE_NAMES.NODE_TABLE_NAME, updated_nodes);
		await insert.update(update_qry);
	} catch (err) {
		console.error('There was a problem updating the hdb_nodes table. Please check the log for details.');
		throw err;
	}

	try {
		routes.setRoutes({
			server: 'hub',
			routes: routes_array,
		});
	} catch (err) {
		console.error('There was a problem setting the clustering routes. Please check the log for details.');
		throw err;
	}
}

async function updateSettingsFile_4_0_0() {
	const settings_path = env.get(terms.HDB_SETTINGS_NAMES.SETTINGS_PATH_KEY);
	// If the pre 4.0.0 settings file doesn't exist skip settings file update
	if (!settings_path.includes(path.join('config', 'settings.js'))) {
		hdb_log.info('pre 4.0.0 settings.js file not found, skipping settings file update');
		return;
	}

	const settings_update_msg = 'Updating settings file for version 4.0.0';
	console.log(settings_update_msg);
	hdb_log.info(settings_update_msg);

	const settings_dir = path.dirname(settings_path);
	const hdb_root = env.get(terms.HDB_SETTINGS_NAMES.HDB_ROOT_KEY);
	const settings_backup_path = path.join(hdb_root, 'backup', '4_0_0_upgrade_settings.bak');
	const new_settings_path = path.join(hdb_root, terms.HDB_CONFIG_FILE);

	try {
		// Create backup of old settings file.
		hdb_log.info(`Backing up old settings file to: ${settings_backup_path}`);
		console.log(`Backing up old settings file to: ${settings_backup_path}`);
		fs.copySync(settings_path, settings_backup_path);
	} catch (err) {
		console.error(
			'There was a problem writing the backup for the old settings file. Please check the log for details.'
		);
		throw err;
	}

	// Create the new config file with old settings info.
	try {
		hdb_log.info(`Creating new/upgraded settings file at '${new_settings_path}'`);
		console.log(`Creating new/upgraded settings file at '${new_settings_path}'`);
		hdb_log.info('Updating env variables with new settings values');
		const flat_config_obj = config_utils.initOldConfig(settings_path);
		config_utils.createConfigFile(flat_config_obj);
	} catch (err) {
		console.log('There was a problem creating the new HarperDB config file. Please check the log for details.');
		throw err;
	}

	// Rewrite the boot properties file with user and new settings path before initSync is called
	const boot_prop_path = common_utils.getPropsFilePath();
	fs.accessSync(boot_prop_path, fs.constants.F_OK | fs.constants.R_OK);

	const hdb_props_file = PropertiesReader(boot_prop_path);
	const install_user = hdb_props_file.get(terms.HDB_SETTINGS_NAMES.INSTALL_USER);
	const boot_props_update = `settings_path = ${new_settings_path}
	install_user = ${install_user}`;

	try {
		fs.writeFileSync(boot_prop_path, boot_props_update);
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

	const upgrade_success_msg = 'New settings file for 4.0.0 upgrade successfully created.';

	try {
		fs.removeSync(settings_dir);
		console.log(upgrade_success_msg);
		hdb_log.info(upgrade_success_msg);
	} catch (err) {
		console.error(
			'There was a problem deleting the old settings file and directory. Please check the log for details.'
		);
		throw err;
	}
}

directive4_0_0.async_functions.push(generateNewKeys);
directive4_0_0.async_functions.push(updateSettingsFile_4_0_0);
directive4_0_0.async_functions.push(reindex_upgrade);
directive4_0_0.async_functions.push(updateNodes);

directives.push(directive4_0_0);

module.exports = directives;
