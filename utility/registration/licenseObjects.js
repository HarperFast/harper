'use strict';

const terms = require('../hdbTerms');

/**
 * Base License class used to define a license
 */
class BaseLicense {
	/**
	 * @param exp_date {Number} - expiration date of license
	 * @param version {String} - licensed version
	 */
	constructor(
		exp_date = 0,
		ram_allocation = terms.RAM_ALLOCATION_ENUM.DEFAULT,
		version = terms.LICENSE_VALUES.VERSION_DEFAULT,
		fingerprint
	) {
		this.exp_date = exp_date;
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
	 * @param version {String} - licensed version
	 * @param enterprise {Boolean} - states if this is a licensed instance
	 */
	constructor(
		exp_date = 0,
		ram_allocation = terms.RAM_ALLOCATION_ENUM.DEFAULT,
		version = terms.LICENSE_VALUES.VERSION_DEFAULT,
		fingerprint,
		enterprise = false
	) {
		super(exp_date, ram_allocation, version, fingerprint);
		this.enterprise = enterprise;
	}
}

module.exports = {
	BaseLicense,
	ExtendedLicense,
};
