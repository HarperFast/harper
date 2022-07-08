'use strict';

const fs = require('fs-extra');
const path = require('path');
const chalk = require('chalk');
const StreamZip = require('node-stream-zip');
const semver = require('semver');
const nats_terms = require('./natsTerms');
const util = require('util');
const child_process = require('child_process');
const exec = util.promisify(child_process.exec);

const DEPENDENCIES_PATH = path.resolve(__dirname, '../../../dependencies');
const ZIP_PATH = path.join(DEPENDENCIES_PATH, nats_terms.NATS_SERVER_ZIP);

let pkg_json_path = path.resolve(__dirname, '../../../package.json');
let pkg_json = require(pkg_json_path);

const REQUIRED_GO_VERSION = pkg_json.engines['go-lang'];
const REQUIRED_NATS_SERVER_VERSION = pkg_json.engines[nats_terms.NATS_SERVER_NAME];
const NATS_SERVER_BINARY = path.join(DEPENDENCIES_PATH, `${nats_terms.NATS_SERVER_NAME}`);
const NATS_SERVER_PATH = path.join(DEPENDENCIES_PATH, nats_terms.NATS_SERVER_NAME);

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
		await fs.access(NATS_SERVER_PATH);
	} catch (e) {
		return false;
	}

	//if nats-server exists check the version
	let version_str = await runCommand(`${NATS_SERVER_PATH} --version`, undefined);
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
		version = await runCommand('go version | { read _ _ v _; echo ${v#go}; }', undefined);
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
	let nats_server_binary_path = path.join(full_nats_source_path, nats_terms.NATS_SERVER_NAME);
	let pkg_path = path.join(DEPENDENCIES_PATH, 'pkg');
	await fs.move(nats_server_binary_path, NATS_SERVER_BINARY, { overwrite: true });
	await fs.remove(full_nats_source_path);
	await fs.remove(pkg_path);
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

	try {
		await checkGoVersion();
	} catch (e) {
		console.error(chalk.red(e.message));
		process.exit(1);
	}

	let nats_source_folder = await extractNATSServer();
	console.log(chalk.green('Building NATS Server binary.'));
	await runCommand(`export GOPATH=${DEPENDENCIES_PATH} && go build`, nats_source_folder);
	console.log(chalk.green('Building NATS Server binary complete.'));
	await cleanUp(nats_source_folder);
	console.log(chalk.green(`****NATS Server v${REQUIRED_NATS_SERVER_VERSION} is installed.****`));
}

module.exports = installer;
