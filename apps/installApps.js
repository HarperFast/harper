'use strict';

const fs = require('fs-extra');
const path = require('path');
const hdb_log = require('../utility/logging/harper_logger');
const hdb_utils = require('../utility/common_utils');
const hdb_terms = require('../utility/hdbTerms');
const eng_mgr = require('../utility/environment/environmentManager');
const npm_utils = require('../utility/npmUtilities');

module.exports = installApps;

/**
 * Will use NPM to install, update or delete any apps defined in harperdb-config.yaml
 * The apps and their modules are installed in the hdb folder.
 * A package.json file is created from the apps config. That file is used by npm install,
 * after that the package.json file is moved to installed-packages.json, this is done so
 * that we can track versions and only create/call package.json when necessary
 * @returns {Promise<void>}
 */
async function installApps() {
	const apps = eng_mgr.get(hdb_terms.CONFIG_PARAMS.APPS);
	const cf_root = eng_mgr.get(hdb_terms.CONFIG_PARAMS.CUSTOMFUNCTIONS_ROOT);
	const root_path = eng_mgr.get(hdb_terms.CONFIG_PARAMS.ROOTPATH);
	const install_pkg_json_path = path.join(root_path, 'installed-packages.json');
	const pkg_json_path = path.join(root_path, 'package.json');
	const pkg_json = {
		dependencies: {},
	};

	let install_pkg_json;
	let install_pkg_json_exists = true;
	let update_occurred = false;
	try {
		install_pkg_json = await fs.readJson(install_pkg_json_path);
	} catch (err) {
		if (hdb_utils.isEmptyOrZeroLength(apps)) return;
		if (err.code !== hdb_terms.NODE_ERROR_CODES.ENOENT) throw err;
		install_pkg_json_exists = false;
	}

	if (!hdb_utils.isEmptyOrZeroLength(apps)) {
		// Build package.json from all apps entries in harperdb-config
		for (const { name, package: pkg } of apps) {
			pkg_json.dependencies[name] = pkg;
		}

		// If there is no install-package.json file go ahead and write package.json and npm install it
		if (!install_pkg_json_exists) {
			hdb_log.notify('Installing apps.');
			await installPackages(pkg_json_path, pkg_json, install_pkg_json_path, apps, root_path);
			return;
		}

		// Loop through apps in config and see if they are defined in installed-package, if they are check that the pkg in app matches what's in installed-package file.
		for (const { name, package: pkg } of apps) {
			const installed_pkg = install_pkg_json.dependencies[name];
			if (installed_pkg === undefined || installed_pkg !== pkg) {
				update_occurred = true;
				break;
			}
		}
	}

	// Loop through the existing installed deps and check to see if they exist in the new package.json, if they don't then need to be uninstalled.
	for (const pkg in install_pkg_json.dependencies) {
		if (pkg_json.dependencies[pkg] === undefined) {
			hdb_log.notify('Removing app', pkg);
			await npm_utils.uninstallRootModule(install_pkg_json.dependencies[pkg]);
			await fs.unlink(path.join(cf_root, pkg));
			update_occurred = true;
		}
	}

	if (update_occurred) {
		hdb_log.notify('Updating apps.');
		// Write package.json, call npm install and then move package.json -> installed-packages.json then symlink apps to the CF folder
		await installPackages(pkg_json_path, pkg_json, install_pkg_json_path, apps, root_path);
	}
}

/**
 * Write package.json, call npm install and then move package.json -> installed-packages.json then symlink apps to the CF folder
 * @param pkg_json_path
 * @param pkg_json
 * @param install_pkg_json_path
 * @param apps
 * @param root_path
 * @returns {Promise<void>}
 */
async function installPackages(pkg_json_path, pkg_json, install_pkg_json_path, apps, root_path) {
	hdb_log.trace('npm installing apps package.json', pkg_json);
	const cf_root = eng_mgr.get(hdb_terms.CONFIG_PARAMS.CUSTOMFUNCTIONS_ROOT);
	await fs.writeFile(pkg_json_path, JSON.stringify(pkg_json, null, '  '));
	await npm_utils.installAllRootModules(eng_mgr.get(hdb_terms.CONFIG_PARAMS.IGNORE_SCRIPTS) === true);
	await npm_utils.linkHarperdb();
	await fs.move(pkg_json_path, install_pkg_json_path, { overwrite: true });

	if (!hdb_utils.isEmptyOrZeroLength(apps)) {
		// Create symlink from app in node mods folder to the CF folder
		for (const { name } of apps) {
			await fs.ensureSymlink(path.join(root_path, 'node_modules', name), path.join(cf_root, name), { overwrite: true });
		}
	}
}
