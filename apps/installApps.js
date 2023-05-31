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

	const node_mods_path = path.join(root_path, 'node_modules');
	await fs.ensureDir(node_mods_path);
	const harperdb_link_path = path.join(node_mods_path, 'harperdb');
	try {
		await fs.ensureSymlink(hdb_terms.PACKAGE_ROOT, harperdb_link_path);
	} catch (err) {
		if (err.code === hdb_terms.NODE_ERROR_CODES.EEXIST) {
			await fs.unlink(harperdb_link_path);
			await fs.ensureSymlink(hdb_terms.PACKAGE_ROOT, harperdb_link_path);
		} else throw err;
	}

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
			const { dep_name, version } = constructAppDep(name, pkg);
			pkg_json.dependencies[dep_name] = version;
		}

		// If there is no install-package.json file go ahead and write package.json and npm install it
		if (!install_pkg_json_exists) {
			hdb_log.notify('Installing apps.');
			await installPackages(pkg_json_path, pkg_json, install_pkg_json_path, apps, root_path);
			return;
		}

		// Loop through apps in config and see if they are defined in installed-package, if they are check that the pkg in app matches what's in installed-package file.
		for (const { name, package: pkg } of apps) {
			const { dep_name, version } = constructAppDep(name, pkg);
			const installed_pkg = install_pkg_json.dependencies[dep_name];
			if (installed_pkg === undefined || installed_pkg !== version) {
				update_occurred = true;
				break;
			}
		}
	}

	// Loop through the existing installed deps and check to see if they exist in the new package.json, if they don't then need to be uninstalled.
	for (const pkg in install_pkg_json.dependencies) {
		const { dep_name } = constructAppDep(undefined, pkg);
		if (pkg_json.dependencies[dep_name] === undefined) {
			hdb_log.notify('Removing app', pkg);
			const pkg_path = getPkgPath(pkg, constructAppName(pkg), root_path);
			const all_app_symlinks = await fs.readdir(cf_root, {
				withFileTypes: true,
			});

			// Loop through the contents of the CF root and unlink the symlink that matches the app we are removing/uninstalling
			// Later on when npm install is run the module will be removed
			for (const app_link of all_app_symlinks) {
				if (!app_link.isSymbolicLink()) continue;
				const target = await fs.realpath(path.join(cf_root, app_link.name));
				if (target === pkg_path) {
					await fs.unlink(path.join(cf_root, app_link.name));
					break;
				}
			}

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
 * The package version can be part of the package name, this function will separate the package value into name and version.
 * @param name
 * @param pkg
 * @returns {{dep_name, version: string}|{dep_name, version}|{dep_name: *, version: *}|{dep_name: string, version: *}}
 */
function constructAppDep(name, pkg) {
	// Decide if the package value is referencing and actual NPM module
	if (pkg.startsWith('@') || (!pkg.startsWith('@') && !pkg.includes('/'))) {
		// If package doesn't have an @ or starts with one and doesn't have another denoting version add pkg to deps.
		if (!pkg.includes('@') || (pkg.startsWith('@') && pkg.match(/@/g).length === 1)) {
			// This will download the most recent version.
			return { dep_name: pkg, version: '*' };
		}

		// If we get here, the package is referencing a specific version.
		const pkg_parts = pkg.split('@');
		if (pkg.startsWith('@')) {
			return { dep_name: `@${pkg_parts[1]}`, version: pkg_parts.slice(-1)[0] };
		} else {
			return { dep_name: pkg_parts[0], version: pkg_parts.slice(-1)[0] };
		}
	}

	if (!name) throw new Error(`'name' is required for app: ${pkg}`);

	return { dep_name: name, version: pkg };
}

/**
 * App dame is optional NPM mods, if its not included we extract a name from the package value.
 * @param pkg
 * @returns {*}
 */
function constructAppName(pkg) {
	// Matches pkg values like `lmdb`
	if (!pkg.includes('@') && !pkg.includes('/')) {
		// Name is unmodified pkg value `lmdb`
		return pkg;
		// Matches pkg values like `lodash@^4.17.18`
	} else if (pkg.includes('@') && !pkg.includes('/')) {
		// Name becomes `lodash`
		return pkg.split('@')[0];
	} else {
		// Matches pkg values like `@fastify/compress` or `@fastify/error@2.0.0`
		// Name becomes `compress` or `error`
		return pkg.split(/@|\//)[2];
	}
}

function getPkgPath(pkg, name, root_path) {
	const node_mods_path = path.join(root_path, 'node_modules');
	if (pkg.startsWith('@')) {
		const pkg_parts = pkg.split(/@|\//);
		return path.join(node_mods_path, '@' + pkg_parts[1], pkg_parts[2]);
	} else {
		return path.join(node_mods_path, name);
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
	await fs.move(pkg_json_path, install_pkg_json_path, { overwrite: true });

	if (!hdb_utils.isEmptyOrZeroLength(apps)) {
		// Create symlink from app in node mods folder to the CF folder
		for (let { name, package: pkg } of apps) {
			// If no name is provided we generate one.
			if (!name) {
				name = constructAppName(pkg);
			}

			try {
				await fs.ensureSymlink(getPkgPath(pkg, name, root_path), path.join(cf_root, name));
			} catch (err) {
				if (err.code === hdb_terms.NODE_ERROR_CODES.EEXIST) {
					throw new Error(
						`When creating a symlink for package '${pkg}' an error occurred due to a file already existing with part of its name. Please set a 'name' for this package in harperdb-config.yaml to avoid any naming collisions.`
					);
				} else throw err;
			}
		}
	}
}
