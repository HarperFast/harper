'use strict';
const fs = require('fs-extra');
const hdb_utils = require('../utility/common_utils');

const TEST_SETTINGS_FILE = 'settings.test';
const TEST_SETTINGS_FILE_PATH = `${__dirname}/${TEST_SETTINGS_FILE}`;
const TEST_SETTINGS_FILE_BAK = 'settings.test.bak';
const SETTINGS = (settings_values = {}) =>
	'\t;Settings for the HarperDB process\n' +
	'\t;The directory selected during install where the database files reside\n' +
	'HDB_ROOT=/Users/harperdb/unitTests/envDir\n' +
	'\t;The port the HarperDB REST interface will listen on\n' +
	'HTTP_PORT=12345\n' +
	'\t;If HTTPS is enabled, the port the HarperDB REST interface will listen on\n' +
	'HTTPS_PORT=31283\n' +
	'\t;The path to the SSL certificate used when running with HTTPS enabled\n' +
	'CERTIFICATE=/Users/harperdb/unitTests/server/clustering/envDir/utilities/keys/certificate.pem\n' +
	'\t;The path to the SSL private key used when running with HTTPS enabled\n' +
	'PRIVATE_KEY=/Users/harperdb/unitTests/envDir/utility/keys/privateKey.pem\n' +
	'\t;Set to true to enable HTTPS on the HarperDB REST endpoint\n' +
	'Requires a valid certificate and key=\n' +
	`HTTPS_ON=${!hdb_utils.isEmpty(settings_values.HTTPS_ON) ? settings_values.HTTPS_ON : 'FALSE'}\n` +
	'\t;Set to true to have harperdb start using standard HTTP\n' +
	`HTTP_ON=${!hdb_utils.isEmpty(settings_values.HTTP_ON) ? settings_values.HTTP_ON : 'TRUE'}\n` +
	'\t;Set to true to enable Cross Origin Resource Sharing, which allows requests across a domain\n' +
	'CORS_ON=TRUE\n' +
	'\t;Allows for setting allowable domains with CORS\n' +
	'Comma separated list=\n' +
	'CORS_ACCESSLIST=\n' +
	'\t;Length of time in milliseconds after which a request will timeout\n' +
	'Defaults to 120,000 ms (2 minutes)=\n' +
	'SERVER_TIMEOUT_MS=120000\n' +
	'\t;Set to control amount of logging generated\n' +
	'Accepted levels are trace, debug, warn, error, fatal=\n' +
	'LOG_LEVEL=debug\n' +
	'\t;The path where log files will be written\n' +
	'LOG_PATH=/Users/harperdb/unitTests/envDir/log\n' +
	'\t;Set to true to enable daily log file rotations - each log file name will be prepended with YYYY-MM-DD\n' +
	'LOG_DAILY_ROTATE=false\n' +
	'\t;Set the number of daily log files to maintain when LOG_DAILY_ROTATE is enabled\n' +
	'If no integer value is set, no limit will be set for=\n' +
	'\t;daily log files which may consume a large amount of storage depending on your log settings\n' +
	'LOG_MAX_DAILY_FILES=\n' +
	'\t;The environment used by NodeJS\n' +
	'Setting to production will be the most performant, settings to development will generate more logging=\n' +
	'NODE_ENV=production\n' +
	'\t;This allows self signed certificates to be used in clustering\n' +
	'This is a security risk=\n' +
	'\t;as clustering will not validate the cert, so should only be used internally\n' +
	'\t;The HDB install creates a self signed certificate, if you use that cert this must be set to true\n' +
	'ALLOW_SELF_SIGNED_SSL_CERTS=true\n' +
	'\t;Set the max number of processes HarperDB will start\n' +
	'This can also be limited by number of cores and licenses=\n' +
	'MAX_HDB_PROCESSES=12\n' +
	'\t;Set to true to enable clustering\n' +
	'Requires a valid enterprise license=\n' +
	'CLUSTERING=TRUE\n' +
	'\t;The port that will be used for HarperDB clustering\n' +
	'CLUSTERING_PORT=12345\n' +
	'\t;The name of this node in your HarperDB cluster topology\n' +
	'This must be a value unique from the rest of your cluster node names=\n' +
	'NODE_NAME=1231412de213\n' +
	'\t;The user used to connect to other instances of HarperDB, this user must have a role of cluster_user\n' +
	'CLUSTERING_USER=clustusr\n' +
	"PROCESS_DIR_TEST=I'm A Test\n" +
	'VERSION=1.1.1\n' +
	`${settings_values.SERVER_PORT ? `SERVER_PORT=${settings_values.SERVER_PORT}\n` : ''}`;

module.exports = {
	buildFile,
	deleteFile,
	getSettingsFilePath,
	getSettingsFileBakPath,
};

function getSettingsFilePath() {
	return TEST_SETTINGS_FILE_PATH;
}

function getSettingsFileBakPath() {
	return `${__dirname}/${TEST_SETTINGS_FILE_BAK}`;
}

function buildFile(settings_values = {}) {
	try {
		fs.writeFileSync(TEST_SETTINGS_FILE_PATH, SETTINGS(settings_values));
	} catch (err) {
		console.error(`Error building temporary settings.test file: ${err}`);
	}
	console.log('Settings test file successfully CREATED');
}

function deleteFile(bak_path_name = TEST_SETTINGS_FILE_BAK) {
	try {
		fs.unlinkSync(TEST_SETTINGS_FILE_PATH);
		fs.unlinkSync(`${__dirname}/${bak_path_name}`);
	} catch (err) {
		console.error(`Error deleting temporary settings.test file and/or backup: ${err}`);
	}
	console.log('Settings test file and backup successfully DELETED');
}
