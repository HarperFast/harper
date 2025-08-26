'use strict';

const terms = require('../hdbTerms.ts');

class SystemInformationOperation {
	/**
	 * @param {Array<String>} attributes
	 */
	constructor(attributes) {
		this.operator = terms.OPERATIONS_ENUM.SYSTEM_INFORMATION;
		this.attributes = attributes;
	}
}

module.exports = SystemInformationOperation;
