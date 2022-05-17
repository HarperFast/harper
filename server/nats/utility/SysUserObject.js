'use strict';

const nats_terms = require('./natsTerms');

/**
 * This class represents a user in Nats accounts SYS users array.
 */
class SysUserObject {
	constructor(user, password) {
		this.user = user + nats_terms.SERVER_SUFFIX.ADMIN;
		this.password = password;
	}
}

module.exports = SysUserObject;
