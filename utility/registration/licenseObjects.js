'use strict';

const terms = require('../hdbTerms.ts');

/**
 * Base License class used to define a license
 */
class BaseLicense {
	/**
	 * @param expDate {Number} - expiration date of license
	 * @param version {String} - licensed version
	 */
	constructor(
		expDate = 0,
		ramAllocation = terms.RAM_ALLOCATION_ENUM.DEFAULT,
		version = terms.LICENSE_VALUES.VERSION_DEFAULT,
		fingerprint
	) {
		this.exp_date = expDate;
		this.ram_allocation = ramAllocation;
		this.version = version;
		this.fingerprint = fingerprint;
	}
}

/**
 * Base license plus extra attributes for tracking inside HDB
 */
class ExtendedLicense extends BaseLicense {
	/**
	 * @param expDate {Number} - expiration date of license
	 * @param version {String} - licensed version
	 * @param enterprise {Boolean} - states if this is a licensed instance
	 */
	constructor(
		expDate = 0,
		ramAllocation = terms.RAM_ALLOCATION_ENUM.DEFAULT,
		version = terms.LICENSE_VALUES.VERSION_DEFAULT,
		fingerprint,
		enterprise = false
	) {
		super(expDate, ramAllocation, version, fingerprint);
		this.enterprise = enterprise;
	}
}

module.exports = {
	BaseLicense,
	ExtendedLicense,
};
