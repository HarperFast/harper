'use strict';

const terms = require('../hdbTerms');

/**
 * Base License class used to define a license
 */
class BaseLicense {
	/**
	 * @param exp_date {Number} - expiration date of license
	 * @param storage_type {String} - data store type i.e. fs, helium, etc..
	 * @param api_call {Number} - number of daily allowed API calls
	 * @param version {String} - licensed version
	 */
	constructor(
		exp_date = 0,
		storage_type = terms.STORAGE_TYPES_ENUM.LMDB,
		api_call = terms.LICENSE_VALUES.API_CALL_DEFAULT,
		ram_allocation = terms.RAM_ALLOCATION_ENUM.DEFAULT,
		version = terms.LICENSE_VALUES.VERSION_DEFAULT,
		fingerprint
	) {
		this.exp_date = exp_date;
		this.storage_type = storage_type;
		this.api_call = api_call;
		this.ram_allocation = ram_allocation;
		this.version = version;
		this.fingerprint = fingerprint;
	}
}

/**
 * Base license plus extra attributes for tracking inside HDB
 */
class ExtendedLicense extends BaseLicense {
	/**
	 * @param exp_date {Number} - expiration date of license
	 * @param storage_type {String} - data store type i.e. fs, helium, etc..
	 * @param api_call {Number} - number of daily allowed API calls
	 * @param version {String} - licensed version
	 * @param enterprise {Boolean} - states if this is a licensed instance
	 */
	constructor(
		exp_date = 0,
		storage_type = terms.STORAGE_TYPES_ENUM.LMDB,
		api_call = terms.LICENSE_VALUES.API_CALL_DEFAULT,
		ram_allocation = terms.RAM_ALLOCATION_ENUM.DEFAULT,
		version = terms.LICENSE_VALUES.VERSION_DEFAULT,
		fingerprint,
		enterprise = false
	) {
		super(exp_date, storage_type, api_call, ram_allocation, version, fingerprint);
		this.enterprise = enterprise;
	}
}

module.exports = {
	BaseLicense,
	ExtendedLicense,
};
