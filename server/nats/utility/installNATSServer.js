'use strict';

const fs = require('fs-extra');
const path = require('path');
const chalk = require('chalk');
const needle = require('needle');
const StreamZip = require('node-stream-zip');
const semver = require('semver');
const natsTerms = require('./natsTerms.js');
const util = require('util');
const childProcess = require('child_process');
const { platform } = require('os');
const exec = util.promisify(childProcess.exec);
const { packageJson, PACKAGE_ROOT } = require('../../../utility/packageUtils.js');

const DEPENDENCIES_PATH = path.join(PACKAGE_ROOT, 'dependencies');
const ZIP_PATH = path.join(DEPENDENCIES_PATH, natsTerms.NATS_SERVER_ZIP);

const REQUIRED_GO_VERSION = packageJson.engines['go-lang'];
const REQUIRED_NATS_SERVER_VERSION = packageJson.engines[natsTerms.NATS_SERVER_NAME];
const PLATFORM_ARCHITECTURE = `${process.platform}-${process.arch}`;
const NATS_SERVER_BINARY_PATH = path.join(DEPENDENCIES_PATH, PLATFORM_ARCHITECTURE, `${natsTerms.NATS_BINARY_NAME}`);
const NATS_SERVER_DOWNLOAD_URL = `https://github.com/nats-io/nats-server/releases/download/v${REQUIRED_NATS_SERVER_VERSION}/nats-server-v${REQUIRED_NATS_SERVER_VERSION}-`;

const PLATFORM_ARCHITECTURE_MAP = {
	'linux-x64': 'linux-amd64.zip',
	'linux-arm64': 'linux-arm64.zip',
	'darwin-x64': 'darwin-amd64.zip',
	'darwin-arm64': 'darwin-arm64.zip',
	'win32-x64': 'windows-amd64.zip',
};
const ALL_SUPPORTED_PLATFORM_ARCHITECTURES = Object.keys(PLATFORM_ARCHITECTURE_MAP).map((platformArch) =>
	platformArch.split('-')
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
	let versionStr = await runCommand(`${NATS_SERVER_BINARY_PATH} --version`, undefined);
	let version = versionStr.substring(versionStr.lastIndexOf('v') + 1, versionStr.length);
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
	let natsSourceFolder = path.join(DEPENDENCIES_PATH, `${natsTerms.NATS_SERVER_NAME}-src`);
	const count = await zip.extract(null, DEPENDENCIES_PATH);
	console.log(chalk.green(`Extracted ${count} entries.`));
	await zip.close();

	return natsSourceFolder;
}

/**
 * Moves the nats-server binary into the dependencies folder and deletes the NATS source code.
 * @param fullNatsSourcePath
 * @returns {Promise<void>}
 */
async function cleanUp(fullNatsSourcePath) {
	let tempNatsServerBinaryPath = path.join(fullNatsSourcePath, natsTerms.NATS_BINARY_NAME);
	let pkgPath = path.join(DEPENDENCIES_PATH, 'pkg');
	await fs.move(tempNatsServerBinaryPath, NATS_SERVER_BINARY_PATH, { overwrite: true });
	await fs.remove(fullNatsSourcePath);
	await fs.remove(pkgPath);
}

async function downloadNATSServer(platform, architecture) {
	let platformArchitecture =
		platform && architecture ? `${platform}-${architecture}` : `${process.platform}-${process.arch}`;
	//get the zip name from the map
	let zip = PLATFORM_ARCHITECTURE_MAP[platformArchitecture];
	if (zip === undefined) {
		throw Error(`unknown platform - architecture: ${platformArchitecture}`);
	}
	let url = `${NATS_SERVER_DOWNLOAD_URL}${zip}`;
	let dependencyPlatformArchPath = path.join(DEPENDENCIES_PATH, platformArchitecture, zip);

	//this creates the path with a dummy file so needle can override
	await fs.ensureFile(dependencyPlatformArchPath);
	console.log(chalk.green(`****Downloading install of NATS Server: ${url}****`));
	await needle('get', url, { output: dependencyPlatformArchPath, follow_max: 5 });
	console.log(chalk.green(`Successfully downloaded and saved nats-server zip.`));

	//extract the file
	console.log(chalk.green(`Extracting nats-server zip.`));
	const streamZip = new StreamZip.async({ file: dependencyPlatformArchPath });
	const entries = await streamZip.entries();
	//iterate entries

	let natsBinaryName =
		platform === 'win32' || process.platform === 'win32'
			? `${natsTerms.NATS_SERVER_NAME}.exe`
			: natsTerms.NATS_SERVER_NAME;
	let binaryPath = path.join(DEPENDENCIES_PATH, platformArchitecture, natsBinaryName);
	for (const entry of Object.values(entries)) {
		if (!entry.isDirectory && entry.name.endsWith(natsBinaryName)) {
			await streamZip.extract(entry.name, binaryPath);
			console.log(chalk.green(`Successfully extracted nats-server zip to ${binaryPath}.`));
		}
	}
	await streamZip.close();
	//delete the zip file
	await fs.remove(dependencyPlatformArchPath);

	//change permisions to nats-server binary so it has execute permissions
	await fs.chmod(binaryPath, 0o777);
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
			let versionStr = await runCommand(`${NATS_SERVER_BINARY_PATH} --version`, undefined);
			console.log(chalk.green(`****Successfully extracted ${versionStr}.****`));
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

	let natsSourceFolder = await extractNATSServer();
	console.log(chalk.green('Building NATS Server binary.'));
	if (platform() == 'win32') await runCommand(`set GOPATH=${DEPENDENCIES_PATH}&& go build`, natsSourceFolder);
	else await runCommand(`export GOPATH=${DEPENDENCIES_PATH} && go build`, natsSourceFolder);
	console.log(chalk.green('Building NATS Server binary complete.'));
	await cleanUp(natsSourceFolder);
	console.log(chalk.green(`****NATS Server v${REQUIRED_NATS_SERVER_VERSION} is installed.****`));
}

module.exports = { installer, downloadNATSServer, ALL_SUPPORTED_PLATFORM_ARCHITECTURES };
