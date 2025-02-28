'use strict';
const fetch = require('node-fetch');
const StreamZip = require('node-stream-zip');
const util = require('util');
const fs = require('fs');
const path = require('path');
const child_process = require('child_process');
const streamPipeline = util.promisify(require('stream').pipeline);
const exec = util.promisify(child_process.exec);
const { packageJson, PACKAGE_ROOT } = require('../../packageUtils');
process.chdir(PACKAGE_ROOT);

const TMP_FOLDER_NAME = 'tmp';
const PKG_FOLDER_NAME = 'pkg';
const NATS_SERVER_NAME = 'nats-server';
const NATS_SERVER_SRC_NAME = NATS_SERVER_NAME + '-src';
const NATS_SERVER_ZIP_NAME = NATS_SERVER_NAME + '.zip';

const TMP_FOLDER_PATH = path.join(PACKAGE_ROOT, TMP_FOLDER_NAME);
const PKG_FOLDER_PATH = path.join(PACKAGE_ROOT, PKG_FOLDER_NAME);
const NATS_SERVER_ZIP_PATH = path.join(PACKAGE_ROOT, NATS_SERVER_ZIP_NAME);
const NATS_SOURCE_PATH = path.join(PACKAGE_ROOT, NATS_SERVER_SRC_NAME);
const BUILT_NATS_SERVER_PATH = path.join(NATS_SOURCE_PATH, NATS_SERVER_NAME);
const DEPENDENCIES_PATH = path.resolve(PACKAGE_ROOT, 'dependencies');
const DEPENDENCIES_NATS_SERVER_ZIP_PATH = path.join(DEPENDENCIES_PATH, NATS_SERVER_ZIP_NAME);

//YOU MUST make sure the nats-server version in package json matches the  new version you want.
const NATS_SERVER_VERSION = packageJson.engines[NATS_SERVER_NAME];

(async () => {
	console.log('downloading nats server source');
	let response = await fetch(`https://github.com/nats-io/nats-server/archive/refs/tags/v${NATS_SERVER_VERSION}.zip`);
	if (!response.ok) throw new Error(`unexpected response ${response.statusText}`);
	console.log('saving nats server to disk');
	await streamPipeline(response.body, fs.createWriteStream(NATS_SERVER_ZIP_PATH));

	const zip = new StreamZip.async({ file: NATS_SERVER_ZIP_PATH });
	console.log('extracting zip to tmp');
	await zip.extract(null, TMP_FOLDER_PATH);
	console.log('deleting zip file');
	await fs.promises.rm(NATS_SERVER_ZIP_PATH);

	let dirs = await fs.promises.readdir(TMP_FOLDER_PATH);
	const tmp_source_path = path.join(TMP_FOLDER_PATH, dirs[0]);
	console.log('moving source out of tmp');
	await fs.promises.rename(tmp_source_path, NATS_SOURCE_PATH);
	console.log('building nats server which also downloads dependencies');
	await exec(`export GOPATH=${PACKAGE_ROOT} && go build`, { cwd: NATS_SOURCE_PATH });

	console.log('remove the built nats-server binary');
	await fs.promises.rm(BUILT_NATS_SERVER_PATH);

	console.log('update permissions for files in pkg folder to full access');
	await exec(`sudo chmod -R 777 ./pkg`);

	console.log('create zip of nats-server & pkg folders');
	await exec(`zip -r ${NATS_SERVER_ZIP_PATH} ./${NATS_SERVER_SRC_NAME} ./${PKG_FOLDER_NAME}`, { cwd: PACKAGE_ROOT });

	console.log('move nats-server.zip to dependencies folder');
	await fs.promises.copyFile(NATS_SERVER_ZIP_PATH, DEPENDENCIES_NATS_SERVER_ZIP_PATH);

	console.log('remove nats-server source folder');
	await fs.promises.rm(NATS_SOURCE_PATH, { recursive: true });

	console.log('remove pkg folder');
	await fs.promises.rm(PKG_FOLDER_PATH, { recursive: true });

	console.log('remove tmp folder');
	await fs.promises.rm(TMP_FOLDER_PATH, { recursive: true });

	console.log('remove nats-server.zip');
	await fs.promises.rm(NATS_SERVER_ZIP_PATH);
})();
