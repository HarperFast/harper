'use strict';

/**
 * This class represents a user in Nats accounts HDB users array.
 */
class HdbUserObject {
	constructor(user, password) {
		this.user = user;
		this.password = password;
	}
}

module.exports = HdbUserObject;
