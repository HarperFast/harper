'use strict';

const fs = require('fs-extra');
const path = require('path');
const hdbLog = require('../utility/logging/harper_logger.js');
const hdbUtils = require('../utility/common_utils.js');
const { PACKAGE_ROOT } = require('../utility/packageUtils.js');
const hdbTerms = require('../utility/hdbTerms.ts');
const engMgr = require('../utility/environment/environmentManager.js');
const configUtils = require('../config/configUtils.js');

module.exports = installComponents;

/**
 * Will use NPM to install, update or delete any components defined in harperdb-config.yaml
 * The components and their modules are installed in the hdb folder.
 * A package.json file is created from the components config.
 * @returns {Promise<void>}
 */
async function installComponents() {
	const components = getComponentsConfig();
	const rootPath = engMgr.get(hdbTerms.CONFIG_PARAMS.ROOTPATH);
	const pkgJsonPath = path.join(rootPath, 'package.json');
	const pkgJson = {
		dependencies: {
			harperdb: 'file:' + PACKAGE_ROOT,
		},
	};

	const nodeModsPath = path.join(rootPath, 'node_modules');
	fs.ensureDirSync(nodeModsPath);
	let installPkgJson;
	let pkgJsonExists = true;
	let updateOccurred = false;
	try {
		installPkgJson = fs.readJsonSync(pkgJsonPath);
	} catch (err) {
		if (hdbUtils.isEmptyOrZeroLength(components)) return;
		if (err.code !== hdbTerms.NODE_ERROR_CODES.ENOENT) throw err;
		pkgJsonExists = false;
	}

	if (!hdbUtils.isEmptyOrZeroLength(components)) {
		// Build package.json from all component entries in harperdb-config
		for (const { name, package: pkg } of components) {
			const pkgPrefix = getPkgPrefix(pkg);
			pkgJson.dependencies[name] = pkgPrefix + pkg;
		}

		// If there is no package.json file go ahead and write package.json and npm install it
		if (!pkgJsonExists) {
			hdbLog.notify('Installing components');
			await installPackages(pkgJsonPath, pkgJson, null);
			await moveModuleToComponents(rootPath, components);
			return;
		}

		// Loop through apps in config and see if they are defined in package.json, if they are check that the pkg in app matches what's in package file.
		for (const { name, package: pkg } of components) {
			const installedPkg = installPkgJson.dependencies[name];
			const pkgPrefix = getPkgPrefix(pkg);
			if (installedPkg === undefined || installedPkg !== pkgPrefix + pkg) {
				updateOccurred = true;
				break;
			}
			if (pkg.startsWith('file:')) {
				try {
					if (fs.statSync(new URL(pkg + '/package.json')).mtimeMs > fs.statSync(pkgJsonPath).mtimeMs) {
						updateOccurred = true;
						break;
					}
				} catch (err) {
					hdbLog.info(`Error checking ${pkg}/package.json modification time`, err);
					break;
				}
			}
		}
	}

	// Loop through the existing installed deps and check to see if they exist in the new package.json, if they don't then need to be uninstalled.
	for (const comp in installPkgJson.dependencies) {
		if (pkgJson.dependencies[comp] === undefined) {
			hdbLog.notify('Removing component', comp);
			updateOccurred = true;
		}
	}

	if (updateOccurred) {
		hdbLog.notify('Updating components.');
		// Write package.json, call npm install
		await installPackages(pkgJsonPath, pkgJson, installPkgJson);

		await moveModuleToComponents(rootPath, components);
	}
}

function moveModuleToComponents(rootPath, components) {
	return Promise.all(
		components.map(({ name }) => {
			const modPath = path.join(rootPath, 'node_modules', name);
			const compPath = path.join(rootPath, 'components', name);
			if (fs.existsSync(modPath) && fs.lstatSync(modPath).isDirectory()) {
				return fs.move(modPath, compPath, { overwrite: true }).then(() => {
					fs.symlink(compPath, modPath);
				});
			}
		})
	);
}

/**
 * Gets any component config from harperdb-config.yaml
 * Scans the config file for any elements that contain a 'package' param.
 * @returns {*[]}
 */
function getComponentsConfig() {
	const allConfig = configUtils.getConfiguration();
	let comps = [];
	for (const element in allConfig) {
		if (allConfig[element]?.package) {
			comps.push(Object.assign(allConfig[element], { name: element }));
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
 * @param pkgJsonPath
 * @param pkgJson
 * @param installPkgJson
 * @returns {Promise<void>}
 */
async function installPackages(pkgJsonPath, pkgJson, installPkgJson) {
	hdbLog.trace('npm installing components package.json', pkgJson);
	fs.writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, '  '));
	try {
		const npmUtils = require('../utility/npmUtilities.js');
		await npmUtils.installAllRootModules(engMgr.get(hdbTerms.CONFIG_PARAMS.IGNORE_SCRIPTS) === true);
	} catch (error) {
		// revert back to previous package.json if we don't succeed
		if (installPkgJson) fs.writeFileSync(pkgJsonPath, JSON.stringify(installPkgJson, null, '  '));
		else fs.unlinkSync(pkgJsonPath);
		throw error;
	}
}
