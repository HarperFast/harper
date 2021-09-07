'use strict';

class IPCEventObject {
	constructor(type, message) {
		this.type = type;
		this.message = message;
	}
}

module.exports = IPCEventObject;
