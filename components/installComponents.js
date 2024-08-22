'use strict';

const fs = require('fs-extra');
const path = require('path');
const hdb_log = require('../utility/logging/harper_logger');
const hdb_utils = require('../utility/common_utils');
const hdb_terms = require('../utility/hdbTerms');
const eng_mgr = require('../utility/environment/environmentManager');
const config_utils = require('../config/configUtils');

module.exports = installComponents;

/**
 * Will use NPM to install, update or delete any components defined in harperdb-config.yaml
 * The components and their modules are installed in the hdb folder.
 * A package.json file is created from the components config.
 * @returns {Promise<void>}
 */
async function installComponents() {
	const components = getComponentsConfig();
	const root_path = eng_mgr.get(hdb_terms.CONFIG_PARAMS.ROOTPATH);
	const pkg_json_path = path.join(root_path, 'package.json');
	const pkg_json = {
		dependencies: {
			harperdb: 'file:' + hdb_terms.PACKAGE_ROOT,
		},
	};

	const node_mods_path = path.join(root_path, 'node_modules');
	fs.ensureDirSync(node_mods_path);
	let install_pkg_json;
	let pkg_json_exists = true;
	let update_occurred = false;
	try {
		install_pkg_json = fs.readJsonSync(pkg_json_path);
	} catch (err) {
		if (hdb_utils.isEmptyOrZeroLength(components)) return;
		if (err.code !== hdb_terms.NODE_ERROR_CODES.ENOENT) throw err;
		pkg_json_exists = false;
	}

	if (!hdb_utils.isEmptyOrZeroLength(components)) {
		// Build package.json from all component entries in harperdb-config
		for (const { name, package: pkg } of components) {
			const pkg_prefix = getPkgPrefix(pkg);
			pkg_json.dependencies[name] = pkg_prefix + pkg;
		}

		// If there is no package.json file go ahead and write package.json and npm install it
		if (!pkg_json_exists) {
			hdb_log.notify('Installing components');
			await installPackages(pkg_json_path, pkg_json, null);
			return;
		}

		// Loop through apps in config and see if they are defined in package.json, if they are check that the pkg in app matches what's in package file.
		for (const { name, package: pkg } of components) {
			const installed_pkg = install_pkg_json.dependencies[name];
			const pkg_prefix = getPkgPrefix(pkg);
			if (installed_pkg === undefined || installed_pkg !== pkg_prefix + pkg) {
				update_occurred = true;
				break;
			}
		}
	}

	// Loop through the existing installed deps and check to see if they exist in the new package.json, if they don't then need to be uninstalled.
	for (const comp in install_pkg_json.dependencies) {
		if (pkg_json.dependencies[comp] === undefined) {
			hdb_log.notify('Removing component', comp);
			update_occurred = true;
		}
	}

	if (update_occurred) {
		hdb_log.notify('Updating components.');
		// Write package.json, call npm install
		await installPackages(pkg_json_path, pkg_json, install_pkg_json);
	}
}

/**
 * Gets any component config from harperdb-config.yaml
 * Scans the config file for any elements that contain a 'package' param.
 * @returns {*[]}
 */
function getComponentsConfig() {
	const all_config = config_utils.getConfiguration();
	let comps = [];
	for (const element in all_config) {
		if (all_config[element]?.package) {
			comps.push(Object.assign(all_config[element], { name: element }));
		}
	}

	return comps;
}

function getPkgPrefix(pkg) {
	if (pkg.includes(':')) return '';
	if (pkg.startsWith('@') || (!pkg.startsWith('@') && !pkg.includes('/'))) return 'npm:';
	if (path.extname(pkg) || fs.existsSync(pkg)) return 'file:';
	return 'github:';
}

/**
 * Write package.json, call npm install
 * @param pkg_json_path
 * @param pkg_json
 * @param install_pkg_json
 * @returns {Promise<void>}
 */
async function installPackages(pkg_json_path, pkg_json, install_pkg_json) {
	hdb_log.trace('npm installing components package.json', pkg_json);
	fs.writeFileSync(pkg_json_path, JSON.stringify(pkg_json, null, '  '));
	try {
		const npm_utils = require('../utility/npmUtilities');
		await npm_utils.installAllRootModules(eng_mgr.get(hdb_terms.CONFIG_PARAMS.IGNORE_SCRIPTS) === true);
	} catch (error) {
		// revert back to previous package.json if we don't succeed
		if (install_pkg_json) fs.writeFileSync(pkg_json_path, JSON.stringify(install_pkg_json, null, '  '));
		else fs.unlinkSync(pkg_json_path);
		throw error;
	}
}
