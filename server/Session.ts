// this is used for durable sessions, that is sessions in MQTT that are not "clean" sessions and durable AMQP queues
import {tables} from '../resources/database';

/**
 * This is used to start or retrieve a real-time communication session, like an MQTT session, or an AMQP queue.
 * A session can be durable (maintains state) or clean (no state). A durable session is stored in a table as a
 * record that holds a list of subscriptions (topic and QoS), their timestamp of last message, and any unacked messages before the
 * timestamp. Once this is returned, it makes the subscription "live", actively routing data through it. Any catch-up
 * from topics need to be performed first.
 * The persisted is designed such that no changes need to be made to it while it is at "rest". The timestamps
 * indicate all updates that need to be retrieved prior to being live again.
 * @param session_id
 */
export async function getSession({ durableSessionId: session_id }) {
	if (session_id) {
		// TODO: Try to get the persistent session. We need to potentially query the whole cluster for this
		let session = tables.system.clients.get(session_id);
		if (!session) {
			// TODO: Create a new session
		}
	}
}

class Session {
	constructor(sessionId, record) {

	}
	addSubscription() {

	}
	setListener() {

	}
	acknowledge() {

	}
}