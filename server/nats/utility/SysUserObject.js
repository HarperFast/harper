'use strict';

const natsTerms = require('./natsTerms.js');

/**
 * This class represents a user in Nats accounts SYS users array.
 */
class SysUserObject {
	constructor(user, password) {
		this.user = user + natsTerms.SERVER_SUFFIX.ADMIN;
		this.password = password;
	}
}

module.exports = SysUserObject;
