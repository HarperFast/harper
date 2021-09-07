'use strict';

const RoomIF = require('./RoomIF');
const types = require('../types');
const log = require('../../../utility/logging/harper_logger');

/**
 * This is a room that handles messages on the hdb_internal:hdb_users channel.  Rooms should not be instantiated directly, instead the room factory should be used.
 */

// 'this' is typically stomped by the worker when invoked, so we store 'this' to make this object accessible.
let self = undefined;
class UsersRoom extends RoomIF {
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
	publishToRoom(msg, worker, existing_hdb_header) {
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
	inboundMsgHandler(req, worker, response) {
		if (!worker) {
			worker = this;
		}
		if (!req || !req.users) {
			log.info('Invalid users in request.');
			return;
		}
		try {
			log.trace('WatchUsers handler');
			if (req.users && typeof req.users === 'object' && !Array.isArray(req.users)) {
				worker.hdb_users = req.users;
			} else {
				worker.hdb_users = {};
			}
		} catch (e) {
			log.error(e);
		}
	}
}

module.exports = UsersRoom;
