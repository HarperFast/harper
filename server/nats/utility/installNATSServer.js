'use strict';

const fs = require('fs-extra');
const path = require('path');
const chalk = require('chalk');
const needle = require('needle');
const StreamZip = require('node-stream-zip');
const semver = require('semver');
const nats_terms = require('./natsTerms');
const util = require('util');
const child_process = require('child_process');
const { platform } = require('os');
const exec = util.promisify(child_process.exec);
const { packageJson, PACKAGE_ROOT } = require('../../../utility/packageUtils');

const DEPENDENCIES_PATH = path.join(PACKAGE_ROOT, 'dependencies');
const ZIP_PATH = path.join(DEPENDENCIES_PATH, nats_terms.NATS_SERVER_ZIP);

const REQUIRED_GO_VERSION = packageJson.engines['go-lang'];
const REQUIRED_NATS_SERVER_VERSION = packageJson.engines[nats_terms.NATS_SERVER_NAME];
const PLATFORM_ARCHITECTURE = `${process.platform}-${process.arch}`;
const NATS_SERVER_BINARY_PATH = path.join(DEPENDENCIES_PATH, PLATFORM_ARCHITECTURE, `${nats_terms.NATS_BINARY_NAME}`);
const NATS_SERVER_DOWNLOAD_URL = `https://github.com/nats-io/nats-server/releases/download/v${REQUIRED_NATS_SERVER_VERSION}/nats-server-v${REQUIRED_NATS_SERVER_VERSION}-`;

const PLATFORM_ARCHITECTURE_MAP = {
	'linux-x64': 'linux-amd64.zip',
	'linux-arm64': 'linux-arm64.zip',
	'darwin-x64': 'darwin-amd64.zip',
	'darwin-arm64': 'darwin-arm64.zip',
	'win32-x64': 'windows-amd64.zip',
};
const ALL_SUPPORTED_PLATFORM_ARCHITECTURES = Object.keys(PLATFORM_ARCHITECTURE_MAP).map((platform_arch) =>
	platform_arch.split('-')
);

/**
 * Runs a bash script in a new shell
 * @param {String} command - the command to execute
 * @param {String=} cwd - path to the current working directory
 * @returns {Promise<*>}
 */
async function runCommand(command, cwd = undefined) {
	const { stdout, stderr } = await exec(command, { cwd });

	if (stderr) {
		throw new Error(stderr.replace('\n', ''));
	}

	return stdout.replace('\n', '');
}

/**
 * checks if the NATS Server binary is present, if so is it the correct version
 * @returns {Promise<boolean>}
 */
async function checkNATSServerInstalled() {
	try {
		//check if binary exists
		await fs.access(NATS_SERVER_BINARY_PATH);
	} catch (e) {
		return false;
	}

	//if nats-server exists check the version
	let version_str = await runCommand(`${NATS_SERVER_BINARY_PATH} --version`, undefined);
	let version = version_str.substring(version_str.lastIndexOf('v') + 1, version_str.length);
	return semver.eq(version, REQUIRED_NATS_SERVER_VERSION);
}

/**
 * Checks the go version, this pulls double duty to see if go is installed / in the PATH
 * @returns {Promise<void>}
 */
async function checkGoVersion() {
	console.log(chalk.green(`Verifying go v${REQUIRED_GO_VERSION} is on system.`));
	let version;
	try {
		let output = await runCommand('go version', undefined);
		version = output.match(/[\d.]+/)[0];
	} catch (e) {
		throw Error('go does not appear to be installed or is not in the PATH, cannot install clustering dependencies.');
	}
	if (!semver.gte(version, REQUIRED_GO_VERSION)) {
		throw Error(`go version ${REQUIRED_GO_VERSION} or higher must be installed.`);
	}
	console.log(chalk.green(`go v${REQUIRED_GO_VERSION} is on the system.`));
}

/**
 * Extracts the nats-server.zip into the dependencies folder and returns the path to source folder.
 * @returns {Promise<string>}
 */
async function extractNATSServer() {
	console.log(chalk.green(`Extracting NATS Server source code.`));
	const zip = new StreamZip.async({ file: ZIP_PATH });
	//The first entry is the folder name the zip extracted into
	let nats_source_folder = path.join(DEPENDENCIES_PATH, `${nats_terms.NATS_SERVER_NAME}-src`);
	const count = await zip.extract(null, DEPENDENCIES_PATH);
	console.log(chalk.green(`Extracted ${count} entries.`));
	await zip.close();

	return nats_source_folder;
}

/**
 * Moves the nats-server binary into the dependencies folder and deletes the NATS source code.
 * @param full_nats_source_path
 * @returns {Promise<void>}
 */
async function cleanUp(full_nats_source_path) {
	let temp_nats_server_binary_path = path.join(full_nats_source_path, nats_terms.NATS_BINARY_NAME);
	let pkg_path = path.join(DEPENDENCIES_PATH, 'pkg');
	await fs.move(temp_nats_server_binary_path, NATS_SERVER_BINARY_PATH, { overwrite: true });
	await fs.remove(full_nats_source_path);
	await fs.remove(pkg_path);
}

async function downloadNATSServer(platform, architecture) {
	let platform_architecture =
		platform && architecture ? `${platform}-${architecture}` : `${process.platform}-${process.arch}`;
	//get the zip name from the map
	let zip = PLATFORM_ARCHITECTURE_MAP[platform_architecture];
	if (zip === undefined) {
		throw Error(`unknown platform - architecture: ${platform_architecture}`);
	}
	let url = `${NATS_SERVER_DOWNLOAD_URL}${zip}`;
	let dependency_platform_arch_path = path.join(DEPENDENCIES_PATH, platform_architecture, zip);

	//this creates the path with a dummy file so needle can override
	await fs.ensureFile(dependency_platform_arch_path);
	console.log(chalk.green(`****Downloading install of NATS Server: ${url}****`));
	await needle('get', url, { output: dependency_platform_arch_path, follow_max: 5 });
	console.log(chalk.green(`Successfully downloaded and saved nats-server zip.`));

	//extract the file
	console.log(chalk.green(`Extracting nats-server zip.`));
	const stream_zip = new StreamZip.async({ file: dependency_platform_arch_path });
	const entries = await stream_zip.entries();
	//iterate entries

	let nats_binary_name =
		platform === 'win32' || process.platform === 'win32'
			? `${nats_terms.NATS_SERVER_NAME}.exe`
			: nats_terms.NATS_SERVER_NAME;
	let binary_path = path.join(DEPENDENCIES_PATH, platform_architecture, nats_binary_name);
	for (const entry of Object.values(entries)) {
		if (!entry.isDirectory && entry.name.endsWith(nats_binary_name)) {
			await stream_zip.extract(entry.name, binary_path);
			console.log(chalk.green(`Successfully extracted nats-server zip to ${binary_path}.`));
		}
	}
	await stream_zip.close();
	//delete the zip file
	await fs.remove(dependency_platform_arch_path);

	//change permisions to nats-server binary so it has execute permissions
	await fs.chmod(binary_path, 0o777);
}

/**
 * Orchestrates the install of the NATS server
 * @returns {Promise<void>}
 */
async function installer() {
	console.log(chalk.green('****Starting install of NATS Server.****'));
	let installed = await checkNATSServerInstalled();
	if (installed) {
		console.log(chalk.green(`****NATS Server v${REQUIRED_NATS_SERVER_VERSION} installed.****`));
		return;
	}

	//attempt appropriate download of NATS release
	try {
		await downloadNATSServer();
		//test nats-server version
		try {
			let version_str = await runCommand(`${NATS_SERVER_BINARY_PATH} --version`, undefined);
			console.log(chalk.green(`****Successfully extracted ${version_str}.****`));
		} catch (error) {
			if (error.toString().includes('file busy')) {
				// even if NATS successfully installs, sometimes the version check can spuriously fail with "Text file busy"
				// error, but NATS will still be installed and working correctly, so we shouldn't fail the whole installation.
				console.warn('Error checking NATS versions', error);
			} else throw error; // ok this is a real error, we need to try to build from source, so rethrow
		}
		return;
	} catch (e) {
		console.error(chalk.red(`Error: ${e.message}. Failed to download NATS server.  Building from source`));
	}
	//fall back to building from source

	try {
		await checkGoVersion();
	} catch (e) {
		console.error(chalk.red(e.message));
		process.exit(1);
	}

	let nats_source_folder = await extractNATSServer();
	console.log(chalk.green('Building NATS Server binary.'));
	if (platform() == 'win32') await runCommand(`set GOPATH=${DEPENDENCIES_PATH}&& go build`, nats_source_folder);
	else await runCommand(`export GOPATH=${DEPENDENCIES_PATH} && go build`, nats_source_folder);
	console.log(chalk.green('Building NATS Server binary complete.'));
	await cleanUp(nats_source_folder);
	console.log(chalk.green(`****NATS Server v${REQUIRED_NATS_SERVER_VERSION} is installed.****`));
}

module.exports = { installer, downloadNATSServer, ALL_SUPPORTED_PLATFORM_ARCHITECTURES };
