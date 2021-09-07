'use strict';

const RoomIF = require('./RoomIF');
const log = require('../../../utility/logging/harper_logger');
const socket_utils = require('../util/socketClusterUtils');

/**
 * This is a room that handles messages on the hdb_internal:create_schema channel.  Rooms should not be instantiated directly, instead the room factory should be used.
 */

// 'this' is typically stomped by the worker when invoked, so we store 'this' to make this object accessible.
let self = undefined;
class CreateSchemaRoom extends RoomIF {
	constructor(new_topic_string) {
		super();
		this.setTopic(new_topic_string);
		self = this;
	}

	/**
	 * Publish to to channel this room represents.  The super call will assign all values in the existing_hdb_header parameter into
	 * the message before it is published.
	 * @param msg - The message that will be posted to the channel
	 * @param worker - The worker that owns this room
	 * @param existing_hdb_header - an existing hdb header which will have its keys appended to msg.
	 * @returns {Promise<void>}
	 */
	async publishToRoom(msg, worker, existing_hdb_header) {
		super.publishToRoom(msg, worker, existing_hdb_header);
	}

	/**
	 * This function is bound to the watcher for this channel.  Since it is bound, 'this' will be replaced by the binder
	 * (typically the Worker).  We accept a worker as a parameter in case this function needs to be called in another
	 * case.
	 * @param req - The inbound request on this topic/channel
	 * @param worker - The worker that owns this room.
	 * @param response - a function that can be called as part of the response.
	 * @returns {Promise<void>}
	 */
	async inboundMsgHandler(req, worker, response) {
		log.trace('CreateSchema handler');
		if (!worker) {
			worker = this;
		}
		try {
			// no-op for now, let it be pushed to the child for processing.
			log.trace('In CreateSchemaRoom');
		} catch (e) {
			log.error(e);
		}
	}
}

module.exports = CreateSchemaRoom;
