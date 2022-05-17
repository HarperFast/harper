'use strict';

const fs = require('fs-extra');
const path = require('path');
const chalk = require('chalk');
const StreamZip = require('node-stream-zip');
const semver = require('semver');
const nats_utils = require('./natsUtils');
const nats_terms = require('./natsTerms');

const DEPENDENCIES_PATH = path.resolve(__dirname, '../../../dependencies');
const ZIP_PATH = path.join(DEPENDENCIES_PATH, nats_terms.NATS_SERVER_ZIP);

let pkg_json_path = path.resolve(__dirname, '../../../package.json');
let pkg_json = require(pkg_json_path);

const REQUIRED_GO_VERSION = pkg_json.engines['go-lang'];
const REQUIRED_NATS_SERVER_VERSION = pkg_json.engines[nats_terms.NATS_SERVER_NAME];
const NATS_SERVER_BINARY = path.join(DEPENDENCIES_PATH, `${nats_terms.NATS_SERVER_NAME}`);

/**
 * Checks the go version, this pulls double duty to see if go is installed / in the PATH
 * @returns {Promise<void>}
 */
async function checkGoVersion() {
	console.log(chalk.green(`Verifying go v${REQUIRED_GO_VERSION} is on system.`));
	let version;
	try {
		version = await nats_utils.runCommand('go version | { read _ _ v _; echo ${v#go}; }', undefined);
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
	let installed = await nats_utils.checkNATSServerInstalled();
	if (installed) {
		console.log(chalk.green(`****NATS Server v${REQUIRED_NATS_SERVER_VERSION} installed.****`));
		return;
	}

	try {
		await checkGoVersion();
	} catch (e) {
		console.error(chalk.red(e.message));
		return;
	}

	let nats_source_folder = await extractNATSServer();
	console.log(chalk.green('Building NATS Server binary.'));
	await nats_utils.runCommand(`export GOPATH=${DEPENDENCIES_PATH} && go build`, nats_source_folder);
	console.log(chalk.green('Building NATS Server binary complete.'));
	await cleanUp(nats_source_folder);
	console.log(chalk.green(`****NATS Server v${REQUIRED_NATS_SERVER_VERSION} is installed.****`));
}

module.exports = installer;
