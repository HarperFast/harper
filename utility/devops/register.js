'use strict';
/**
 * this is simply meant to allow a developer to create their own license file & gets stripped out on release
 * @type {{validateLicense, generateFingerPrint, generateLicense}|*}
 */
require('../../bin/dev');

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
	const license = require('../registration/hdb_license');
	if (ARGS.help || (ARGS.ram_allocation === undefined && ARGS.reset_license === undefined)) {
		console.log(
			'available arguments reset_license.  All can be used in conjunction with each other\n' +
				'--ram_allocation is an integer specify the max memory in MB to allocate to this node ex: --ram_allocation=1024\n ' +
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

	if (ARGS.ram_allocation !== undefined) {
		let ram_allocation =
			ARGS.ram_allocation === undefined ? terms.RAM_ALLOCATION_ENUM.DEVELOPMENT : ARGS.ram_allocation;

		if (!Number.isInteger(ram_allocation)) {
			throw new Error('argument ram_allocation must be an integer');
		}

		console.log('creating fingerprint');
		let fingerprint = await license.generateFingerPrint();
		let license_object = {
			company: 'harperdb.io',
			fingerprint: fingerprint,
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
