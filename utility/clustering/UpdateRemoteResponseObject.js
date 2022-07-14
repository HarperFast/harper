'use strict';

class UpdateRemoteResponseObject {
	constructor(status, message, system_info = undefined) {
		this.status = status;
		this.message = message;
		this.system_info = system_info;
	}
}

module.exports = UpdateRemoteResponseObject;
