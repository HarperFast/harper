'use strict';
/**
 * Test the hdb_license module.
 */

const assert = require('assert');
const rewire = require('rewire');
const fs = require('fs-extra');
const moment = require('moment');
const test_utils = require('../../test_utils');
test_utils.preTestPrep();
const license_objects = require('../../../utility/registration/licenseObjects');
const hdb_terms = require('../../../utility/hdbTerms');

const LICENSE_KEY_DELIMITER = 'mofi25';

const LICENSES = [
	{
		license_key: {
			exp_date: moment().add(1, 'year').unix(),
			version: '2.2.0',
			ram_allocation: hdb_terms.RAM_ALLOCATION_ENUM.DEFAULT,
			enterprise: true,
			fingerprint: undefined,
		},
		company: 'harperdb',
	},
	{
		license_key: {
			exp_date: moment().add(2, 'year').unix(),
			version: '2.2.0',
			ram_allocation: 2500,
			enterprise: true,
			fingerprint: undefined,
		},
		company: 'harperdb',
	},
];

const VALID_LICENSE_FLAGS = {
	valid_license: true,
	valid_date: true,
	valid_machine: true,
};

const INVALID_LICENSE_FLAGS = {
	valid_license: false,
	valid_date: true,
	valid_machine: false,
};
let get_finger_print_file;

describe(`Test generateFingerPrint`, function () {
	it('Nominal, generate new finger print with hash and write finger print file', async function () {
		// rewire hdb_license instance locally to keep internal cipher const fresh from another test
		const hdb_license = rewire('../../../utility/registration/hdb_license');

		// delete finger print file if exist

		get_finger_print_file = hdb_license.__get__('getFingerPrintFilePath');
		let finger_print_file = get_finger_print_file();
		if (fs.existsSync(finger_print_file)) {
			fs.unlinkSync(finger_print_file);
		}

		let err = null;
		let hash = await hdb_license.generateFingerPrint().catch((e) => {
			err = e;
		});
		assert.equal(err, null, 'generate finger print without error');
		assert.notEqual(hash, null, 'finger print should not be null');
		let finger_print = await fs.readFile(finger_print_file, 'utf8').catch((err) => {
			throw err;
		});
		assert.equal(hash, finger_print, 'generated hash should equal to hash in finger print file');
	});
});

describe(`Test generateLicense`, function () {
	it('Nominal, generate license with valid license key and finger print file', function () {
		// rewire hdb_license instance locally to keep internal cipher const fresh from another test
		const license_generator = rewire('../../../utility/devops/licenseGenerator');
		// prepare license key obj which expire tomorrow with dummy fingerprint (no fingerprint validation in generate license process)
		let licenseKeyObject = {
			exp_date: moment().add(1, 'day').utc().format('YYYY-MM-DD'),
			company: 'hdb',
			fingerprint: 'whatever',
			storage_type: 'lmdb',
			api_call: 90000,
			ram_allocation: hdb_terms.RAM_ALLOCATION_ENUM.DEFAULT,
			version: '2.0.0',
		};

		let err = null;
		let license = undefined;
		try {
			license = license_generator.generateLicense(licenseKeyObject);
		} catch (e) {
			err = e;
		}
		assert.equal(err, null, 'generate license without error');
		assert.notEqual(license, null, 'license should not be null');
		assert.ok(license.length > 0, 'license should have value');
		assert.ok(
			license.indexOf(license_generator.__get__('LICENSE_KEY_DELIMITER')) > -1,
			'license should contain license key delimiter'
		);
	});
	it('Pass expired license key, expect failed to generate license with proper error message', function () {
		// rewire hdb_license instance locally to keep internal cipher const fresh from another test
		const license_generator = rewire('../../../utility/devops/licenseGenerator');
		// prepare license key obj which *expire today* with dummy fingerprint (no fingerprint validation in generate license process)
		let licenseKeyObject = {
			exp_date: moment().subtract(1, 'day').format('YYYY-MM-DD'),
			company: 'hdb',
			fingerprint: 'whatever',
			storage_type: 'lmdb',
			api_call: 90000,
			ram_allocation: hdb_terms.RAM_ALLOCATION_ENUM.DEFAULT,
			version: '2.0.0',
		};

		let err = null;
		let license = undefined;
		try {
			license = license_generator.generateLicense(licenseKeyObject);
		} catch (e) {
			err = e;
		}

		assert.notEqual(err, null, 'generate license should get error');
		assert.equal(
			err,
			'Error: Exp date must be no earlier than ' + moment().utc().format('YYYY-MM-DD'),
			'error message should mention that license key is expired'
		);
		assert.equal(license, null, 'license value should be null');
	});
	it('Pass null company, expect failed to generate license with proper error message', function () {
		// rewire hdb_license instance locally to keep internal cipher const fresh from another test
		const license_generator = rewire('../../../utility/devops/licenseGenerator');
		// prepare license key obj which expire tomorrow with *blank company* and dummy fingerprint (no fingerprint validation in generate license process)
		let licenseKeyObject = {
			exp_date: moment().add(1, 'day').utc().format('YYYY-MM-DD'),
			company: null,
			fingerprint: 'whatever',
			storage_type: 'lmdb',
			api_call: 90000,
			ram_allocation: hdb_terms.RAM_ALLOCATION_ENUM.DEFAULT,
			version: '2.0.0',
		};

		let err = null;
		let license = undefined;
		try {
			license = license_generator.generateLicense(licenseKeyObject);
		} catch (e) {
			err = e;
		}

		assert.notEqual(err, null, 'generate license should get error');
		assert.equal(err, "Error: Company can't be blank", "error message should mention that company can't be blank");
		assert.equal(license, null, 'license value should be null');
	});
	it('Pass null expire date, expect failed to generate license with proper error message', function () {
		// rewire hdb_license instance locally to keep internal cipher const fresh from another test
		const license_generator = rewire('../../../utility/devops/licenseGenerator');
		// prepare license key obj which *expire date is blank* with dummy fingerprint (no fingerprint validation in generate license process)
		let licenseKeyObject = {
			exp_date: null,
			company: 'hdb',
			fingerprint: 'whatever',
			storage_type: 'lmdb',
			api_call: 90000,
			ram_allocation: hdb_terms.RAM_ALLOCATION_ENUM.DEFAULT,
			version: '2.0.0',
		};

		let err = null;
		let license = undefined;
		try {
			license = license_generator.generateLicense(licenseKeyObject);
		} catch (e) {
			err = e;
		}

		assert.notEqual(err, null, 'generate license should get error');
		assert.equal(err, "Error: Exp date can't be blank", "error message should mention that expire date can't be blank");
		assert.equal(license, null, 'license value should be null');
	});

	it('Pass ram_allocation as string, expect failed to generate license with proper error message', function () {
		// rewire hdb_license instance locally to keep internal cipher const fresh from another test
		const license_generator = rewire('../../../utility/devops/licenseGenerator');
		// prepare license key obj which *expire date is blank* with dummy fingerprint (no fingerprint validation in generate license process)
		let licenseKeyObject = {
			exp_date: moment().add(1, 'day').utc().format('YYYY-MM-DD'),
			company: 'hdb',
			fingerprint: 'whatever',
			storage_type: 'lmdb',
			api_call: 90000,
			ram_allocation: 'thousand',
			version: '2.0.0',
		};

		let err = null;
		let license = undefined;
		try {
			license = license_generator.generateLicense(licenseKeyObject);
		} catch (e) {
			err = e;
		}

		assert.notEqual(err, null, 'generate license should get error');
		assert.equal(
			err,
			'Error: Ram allocation is not a number',
			'error message should mention that ram limit must be a number'
		);
		assert.equal(license, null, 'license value should be null');
	});

	it('Pass no ram_allocation, expect failed to generate license with proper error message', function () {
		// rewire hdb_license instance locally to keep internal cipher const fresh from another test
		const license_generator = rewire('../../../utility/devops/licenseGenerator');
		// prepare license key obj which *expire date is blank* with dummy fingerprint (no fingerprint validation in generate license process)
		let licenseKeyObject = {
			exp_date: moment().add(1, 'day').utc().format('YYYY-MM-DD'),
			company: 'hdb',
			fingerprint: 'whatever',
			storage_type: 'lmdb',
			api_call: 90000,
			version: '2.0.0',
		};

		let err = null;
		let license = undefined;
		try {
			license = license_generator.generateLicense(licenseKeyObject);
		} catch (e) {
			err = e;
		}

		assert.notEqual(err, null, 'generate license should get error');
		assert.equal(
			err,
			"Error: Ram allocation can't be blank",
			"error message should mention that ram_allocation can't be blank"
		);
		assert.equal(license, null, 'license value should be null');
	});
});

describe(`Test validateLicense`, function () {
	it('Nominal, validate valid license with pass', async function () {
		// rewire hdb_license instance locally to keep internal cipher const fresh from another test
		const hdb_license = rewire('../../../utility/registration/hdb_license');
		const license_generator = rewire('../../../utility/devops/licenseGenerator');
		let licenseKeyObject = {
			exp_date: moment().add(1, 'day').utc().format('YYYY-MM-DD'),
			company: 'hdb',
			storage_type: 'lmdb',
			api_call: 90000,
			ram_allocation: hdb_terms.RAM_ALLOCATION_ENUM.DEFAULT,
			version: '2.0.0',
		};

		let err = null;
		let fingerprint = await hdb_license.generateFingerPrint().catch((e) => {
			err = e;
		});
		licenseKeyObject.fingerprint = fingerprint;
		let license = license_generator.generateLicense(licenseKeyObject);
		let validation = hdb_license.validateLicense(license, 'hdb');
		assert.equal(validation.valid_date, true, 'date validation should be valid');
		assert.equal(validation.valid_license, true, 'license validation should be valid');
		assert.equal(validation.valid_machine, true, 'machine validation should be valid');
	});
	it('Nominal with lmdb storage_type, validate valid license with pass', async function () {
		// rewire hdb_license instance locally to keep internal cipher const fresh from another test
		const hdb_license = rewire('../../../utility/registration/hdb_license');
		const license_generator = rewire('../../../utility/devops/licenseGenerator');
		let licenseKeyObject = {
			exp_date: moment().add(1, 'day').utc().format('YYYY-MM-DD'),
			company: 'hdb',
			storage_type: 'lmdb',
			api_call: 90000,
			ram_allocation: hdb_terms.RAM_ALLOCATION_ENUM.DEFAULT,
			version: '2.0.0',
		};

		let err = null;
		let fingerprint = await hdb_license.generateFingerPrint().catch((e) => {
			err = e;
		});
		licenseKeyObject.fingerprint = fingerprint;
		let license = license_generator.generateLicense(licenseKeyObject);
		let validation = hdb_license.validateLicense(license, 'hdb');
		assert.equal(validation.valid_date, true, 'date validation should be valid');
		assert.equal(validation.valid_license, true, 'license validation should be valid');
		assert.equal(validation.valid_machine, true, 'machine validation should be valid');
	});
	it('Pass expired license, expect invalid date from validation', async function () {
		// rewire hdb_license instance locally to keep internal cipher const fresh from another test
		const hdb_license = rewire('../../../utility/registration/hdb_license');
		const license_generator = rewire('../../../utility/devops/licenseGenerator');
		let licenseKeyObject = {
			exp_date: moment().subtract(1, 'day').utc().format('YYYY-MM-DD'),
			company: 'hdb',
			storage_type: 'lmdb',
			api_call: 90000,
			ram_allocation: hdb_terms.RAM_ALLOCATION_ENUM.DEFAULT,
			version: '2.0.0',
		};

		let err = null;
		let fingerprint = await hdb_license.generateFingerPrint().catch((e) => {
			err = e;
		});

		let val_revert = license_generator.__set__('validation', (licence_object) => {
			return null;
		});

		licenseKeyObject.fingerprint = fingerprint;
		let license = license_generator.generateLicense(licenseKeyObject);
		let moment_tomorrow_mock = function () {
			return moment().add(1, 'day');
		};
		let moment_rw = hdb_license.__set__('moment', moment_tomorrow_mock);
		let validation = hdb_license.validateLicense(license, 'hdb');
		assert.equal(validation.valid_date, false, 'date validation should not be valid');
		assert.equal(validation.valid_license, true, 'license validation should be valid');
		assert.equal(validation.valid_machine, true, 'machine validation should be valid');

		val_revert();
		moment_rw();
	});
	it('Pass invalid company, expect invalid license from validation', async function () {
		// rewire hdb_license instance locally to keep internal cipher const fresh from another test
		const hdb_license = rewire('../../../utility/registration/hdb_license');
		const license_generator = rewire('../../../utility/devops/licenseGenerator');
		let licenseKeyObject = {
			exp_date: moment().add(1, 'day').utc().format('YYYY-MM-DD'),
			company: 'hdb',
			storage_type: 'lmdb',
			api_call: 90000,
			ram_allocation: hdb_terms.RAM_ALLOCATION_ENUM.DEFAULT,
			version: '2.0.0',
		};

		let err = null;
		let fingerprint = await hdb_license.generateFingerPrint().catch((e) => {
			err = e;
		});
		licenseKeyObject.fingerprint = fingerprint;
		let license = license_generator.generateLicense(licenseKeyObject);
		let validation = hdb_license.validateLicense(license, 'some_co');
		assert.equal(validation.valid_date, true, 'date validation should be valid');
		assert.equal(validation.valid_license, false, 'license validation should not be valid');
		assert.equal(validation.valid_machine, true, 'machine validation should be valid');
	});
	it('Pass invalid license, expect invalid license from validation', async function () {
		// rewire hdb_license instance locally to keep internal cipher const fresh from another test
		const hdb_license = rewire('../../../utility/registration/hdb_license');
		const license_generator = rewire('../../../utility/devops/licenseGenerator');
		let licenseKeyObject = {
			exp_date: moment().add(1, 'day').utc().format('YYYY-MM-DD'),
			company: 'hdb',
			storage_type: 'lmdb',
			api_call: 90000,
			ram_allocation: hdb_terms.RAM_ALLOCATION_ENUM.DEFAULT,
			version: '2.0.0',
		};

		let err = null;
		let fingerprint = await hdb_license.generateFingerPrint().catch((e) => {
			err = e;
		});
		licenseKeyObject.fingerprint = fingerprint;
		let license = license_generator.generateLicense(licenseKeyObject);
		try {
			let validation = hdb_license.validateLicense(`wrong_license${LICENSE_KEY_DELIMITER}wrong`, 'hdb');
		} catch (e) {
			err = e;
		}

		assert.equal(err.message, 'invalid license key format');
	});

	it('Finger print does not exist, expect invalid machine from validation', async function () {
		// rewire hdb_license instance locally to keep internal cipher const fresh from another test
		const hdb_license = rewire('../../../utility/registration/hdb_license');
		const license_generator = rewire('../../../utility/devops/licenseGenerator');
		let licenseKeyObject = {
			exp_date: moment().add(1, 'day').utc().format('YYYY-MM-DD'),
			company: 'hdb',
			storage_type: 'lmdb',
			api_call: 90000,
			ram_allocation: hdb_terms.RAM_ALLOCATION_ENUM.DEFAULT,
			version: '2.0.0',
		};

		let err = null;
		let fingerprint = await hdb_license.generateFingerPrint().catch((e) => {
			err = e;
		});
		licenseKeyObject.fingerprint = fingerprint;
		let license = license_generator.generateLicense(licenseKeyObject);
		let finger_print_file = get_finger_print_file();
		if (fs.existsSync(finger_print_file)) {
			// delete finger print file if exist
			fs.unlinkSync(finger_print_file);
		}
		let validation = hdb_license.validateLicense(license, 'hdb');
		assert.equal(validation.valid_date, false, 'date validation should not valid');
		assert.equal(validation.valid_license, false, 'license validation should not valid');
		assert.equal(validation.valid_machine, false, 'machine validation should not valid');
	});
});

describe('test licenseSearch', () => {
	it('test no license in hdb_license', () => {
		const hdb_license = rewire('../../../utility/registration/hdb_license');
		let fs_rw = hdb_license.__set__('fs', {
			readFileSync: (file, format) => {
				return [];
			},
		});

		let err = undefined;
		let license = undefined;
		try {
			license = hdb_license.licenseSearch();
		} catch (e) {
			err = e;
		}

		assert.equal(err, undefined);
		assert.deepEqual(license, new license_objects.ExtendedLicense());
		fs_rw();
	});

	it('test one license in hdb_license & license is valid', () => {
		const hdb_license = rewire('../../../utility/registration/hdb_license');
		let fs_rw = hdb_license.__set__('fs', {
			readFileSync: (file, format) => {
				return JSON.stringify(LICENSES[0]) + '\r\n';
			},
		});

		let validate_license_rw = hdb_license.__set__('validateLicense', (license_key, company) => {
			return { ...license_key, ...VALID_LICENSE_FLAGS };
		});

		let err = undefined;
		let license = undefined;
		try {
			license = hdb_license.licenseSearch();
		} catch (e) {
			let err = e;
		}

		assert.equal(err, undefined);
		assert.deepEqual(license, LICENSES[0].license_key);

		validate_license_rw();
		fs_rw();
	});

	it('test one license in hdb_license & license is invalid', () => {
		const hdb_license = rewire('../../../utility/registration/hdb_license');
		let fs_rw = hdb_license.__set__('fs', {
			readFileSync: (file, format) => {
				return JSON.stringify(LICENSES[0]) + '\r\n';
			},
		});

		let validate_license_rw = hdb_license.__set__('validateLicense', (license_key, company) => {
			return { ...license_key, ...INVALID_LICENSE_FLAGS };
		});

		let err = undefined;
		let license = undefined;
		try {
			license = hdb_license.licenseSearch();
		} catch (e) {
			let err = e;
		}

		assert.equal(err, undefined);
		assert.deepEqual(license, new license_objects.ExtendedLicense());

		fs_rw();
		validate_license_rw();
	});

	it('test multiple valid licenses in hdb_license', () => {
		const hdb_license = rewire('../../../utility/registration/hdb_license');
		let fs_rw = hdb_license.__set__('fs', {
			readFileSync: (file, format) => {
				return JSON.stringify(LICENSES[0]) + '\r\n' + JSON.stringify(LICENSES[1]) + '\r\n';
			},
		});

		let validate_license_rw = hdb_license.__set__('validateLicense', (license_key, company) => {
			return { ...license_key, ...VALID_LICENSE_FLAGS };
		});

		let err = undefined;
		let license = undefined;
		try {
			license = hdb_license.licenseSearch();
		} catch (e) {
			let err = e;
		}

		let compare_license = LICENSES[1];
		assert.equal(err, undefined);
		assert.deepEqual(license, compare_license.license_key);

		fs_rw();
		validate_license_rw();
	});

	it('test with search failing', () => {
		const hdb_license = rewire('../../../utility/registration/hdb_license');
		let fs_rw = hdb_license.__set__('fs', {
			readFileSync: (file, format) => {
				throw new Error('FAIL!');
			},
		});

		let err = undefined;
		let license = undefined;
		try {
			license = hdb_license.licenseSearch();
		} catch (e) {
			let err = e;
		}

		assert.equal(err, undefined);
		assert.deepEqual(license, new license_objects.ExtendedLicense());

		fs_rw();
	});

	it('test with validate failing', () => {
		const hdb_license = rewire('../../../utility/registration/hdb_license');
		let fs_rw = hdb_license.__set__('fs', {
			readFileSync: (file, format) => {
				return JSON.stringify(LICENSES[0]) + '\r\n' + JSON.stringify(LICENSES[1]) + '\r\n';
			},
		});

		let validate_license_rw = hdb_license.__set__('validateLicense', (license_key, company) => {
			throw new Error('FAIL!');
		});

		let err = undefined;
		let license = undefined;
		try {
			license = hdb_license.licenseSearch();
		} catch (e) {
			let err = e;
		}

		assert.equal(err, undefined);
		assert.deepEqual(license, new license_objects.ExtendedLicense());

		fs_rw();
		validate_license_rw();
	});
});
