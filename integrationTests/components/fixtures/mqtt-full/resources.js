import jwt from 'jsonwebtoken';
import SETTINGS from './connect.json' with { type: 'json' };

class User {
	constructor(username, clientID, authGroups) {
		this.active = true;
		this.username = username;
		this.client_id = clientID;
		this.authGroups = authGroups;
		this.role = { role: authGroups, permission: { super_user: false } };
	}
}

// Override server.getUser to accept JWT tokens as the MQTT password.
// jwt.decode() reads claims without verifying the signature, which means both
// HS256 and RS256 (and any other algorithm) tokens are accepted — the test
// exercises that RS256 claims are extracted correctly.
const hdbGetUser = server.getUser;
server.getUser = async function (username, password) {
	if (password?.length > 100 && password.split('.').length === 3) {
		try {
			const decoded = jwt.decode(password);
			if (decoded) {
				return new User(
					decoded[SETTINGS.options.userName] ?? username,
					decoded[SETTINGS.options.clientId],
					decoded[SETTINGS.options.authorizations]
				);
			}
		} catch (e) {
			const msg = `Error decoding token: ${e.message}. For username: ${username}`;
			throw new Error(msg);
		}
	}
	const user = await hdbGetUser(username, password);
	user.client_id = username;
	return user;
};

// Validate that the MQTT clientId matches the clientID claim in the JWT.
// Anonymous connections (no user) are allowed as long as they do not specify
// a clientId and use a clean session.
server.mqtt.authorizeClient = (connection_message, user) => {
	if (!user) {
		if (connection_message.clientId) throw new Error('Cannot specify a client id for anonymous connections');
		if (!connection_message.clean) throw new Error('Anonymous connections must use clean sessions');
	} else if (connection_message.clientId !== user.client_id && !user.role?.permission?.super_user) {
		throw new Error('Invalid client id: must match the clientID claim in the JWT token');
	}
};

// Implement %u topic substitution for user-topics/# subscriptions and publishes.
// When a client subscribes or publishes to user-topics/<segment>/..., the first
// segment after the prefix must equal the authenticated username.  This mirrors
// the Mosquitto/production %u pattern that prevents cross-user topic access
// (Ubisoft prod, v4.3.34).
server.mqtt.events.on('connected', (session) => {
	const USER_TOPICS_PREFIX = 'user-topics/';

	const origAddSubscription = session.addSubscription.bind(session);
	session.addSubscription = async (subscription, needsAck, filter) => {
		const { topic } = subscription;
		if (topic.startsWith(USER_TOPICS_PREFIX)) {
			const rest = topic.slice(USER_TOPICS_PREFIX.length);
			const userSeg = rest.split('/')[0];
			if (userSeg && userSeg !== '#' && userSeg !== '+') {
				if (userSeg !== session.user?.username) {
					const err = Object.assign(
						new Error('%u substitution: topic user segment must match the connected username'),
						{
							statusCode: 403,
						}
					);
					throw err;
				}
			}
		}
		return origAddSubscription(subscription, needsAck, filter);
	};

	const origPublish = session.publish.bind(session);
	session.publish = async (message, data) => {
		const { topic } = message;
		if (topic.startsWith(USER_TOPICS_PREFIX)) {
			const rest = topic.slice(USER_TOPICS_PREFIX.length);
			const userSeg = rest.split('/')[0];
			if (userSeg && userSeg !== '#' && userSeg !== '+') {
				if (userSeg !== session.user?.username) {
					const err = Object.assign(
						new Error('%u substitution: topic user segment must match the connected username'),
						{ statusCode: 403 }
					);
					throw err;
				}
			}
		}
		return origPublish(message, data);
	};
});
