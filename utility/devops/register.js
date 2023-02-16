'use strict';
/**
 * this is simply meant to allow a developer to create their own license file & gets stripped out on release
 * @type {{validateLicense, generateFingerPrint, generateLicense}|*}
 */

const license = require('../registration/hdb_license');
const license_generator = require('./licenseGenerator');
const reg_handler = require('../registration/registrationHandler');

const minimist = require('minimist');
const fs = require('fs-extra');
const path = require('path');
const terms = require('../hdbTerms');

const moment = require('moment');
const env = require('../environment/environmentManager');
env.initSync();

const LICENSE_PATH = path.join(env.getHdbBasePath(), terms.LICENSE_KEY_DIR_NAME, terms.LICENSE_FILE_NAME);
const LICENSE_FILE = path.join(LICENSE_PATH, terms.LICENSE_FILE_NAME);

const ARGS = minimist(process.argv.slice(2));
let RESET_SUCCESS_MSG = 'successfully reset license';
async function register() {
	if (
		ARGS.help ||
		(ARGS.api_call === 1000000000000 &&
			ARGS.ram_allocation === 5000 &&
			ARGS.storage_type === 'lmdb' &&
			ARGS.reset_license === undefined)
	) {
		console.log(
			'available arguments --api_call, --storage_type, or reset_license.  All can be used in conjunction with each other\n' +
				'--api_call is an integer specify the number of api call / day this node can perform ex: --api_call=100000\n ' +
				'--ram_allocation is an integer specify the max memory in MB to allocate to this node ex: --ram_allocation=1024\n ' +
				"--storage_type specifies the data storage type this node will use value can be: 'lmdb' or 'fs' ex: --storage_type=fs\n" +
				'--reset_license will delete the existing license file'
		);
		return;
	}

	if (ARGS.reset_license === true) {
		console.log('resetting license');

		try {
			fs.mkdirpSync(LICENSE_PATH);
			fs.unlinkSync(LICENSE_FILE);
			console.log(RESET_SUCCESS_MSG);
		} catch (e) {
			if (e.code !== 'ENOENT') {
				throw e;
			}

			console.log(RESET_SUCCESS_MSG);
		}
	}

	if (ARGS.api_call !== undefined || ARGS.storage_type !== undefined || ARGS.ram_allocation !== undefined) {
		let api_call = ARGS.api_call === undefined ? terms.LICENSE_VALUES.API_CALL_DEFAULT : ARGS.api_call;
		//NOTE: storage type is not currently managed via the license but related code is staying in place for potential
		// later use if/when other storage mechanisms are built into hdb bridge
		let storage_type = terms.STORAGE_TYPES_ENUM.LMDB;
		let ram_allocation =
			ARGS.ram_allocation === undefined ? terms.RAM_ALLOCATION_ENUM.DEVELOPMENT : ARGS.ram_allocation;
		if (!Number.isInteger(api_call)) {
			throw new Error('argument api_call must be an integer');
		}

		if (!Number.isInteger(ram_allocation)) {
			throw new Error('argument ram_allocation must be an integer');
		}

		console.log('creating fingerprint');
		let fingerprint = await license.generateFingerPrint();
		let license_object = {
			company: 'harperdb.io',
			fingerprint: fingerprint,
			storage_type: storage_type,
			api_call: api_call,
			ram_allocation: ram_allocation,
			version: terms.LICENSE_VALUES.VERSION_DEFAULT,
			exp_date: moment().add(1, 'year').format('YYYY-MM-DD'),
		};
		console.log('generating license');
		let generated_license = license_generator.generateLicense(license_object);
		console.log('validating & writing license to hdb');
		await reg_handler.parseLicense(generated_license, 'harperdb.io');
		console.log('license saved');
	}
}

register()
	.then()
	.catch((e) => {
		console.error(e.message);
	});
