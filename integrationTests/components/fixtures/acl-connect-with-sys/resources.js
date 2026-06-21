import jwt from 'jsonwebtoken';
import SETTINGS from './connect.json' with { type: 'json' };

const mqtt_log = logger;

class User {
	constructor(username, clientID, authGroups) {
		this.active = true;
		this.username = username;
		this.client_id = clientID;
		this.authGroups = authGroups;
		this.role = { role: authGroups, permission: { super_user: false } };
	}
}

const hdbGetUser = server.getUser;
server.getUser = async function (username, password) {
	if (password?.length > 100 && password.split('.').length === 3) {
		try {
			const decoded = jwt.decode(password);
			return new User(
				decoded[SETTINGS.options.userName] ?? username,
				decoded[SETTINGS.options.clientId],
				decoded[SETTINGS.options.authorizations]
			);
		} catch (e) {
			const msg = `Error verifying token: ${e.message}. For username: ${username}, token: ${password}`;
			mqtt_log.error(msg);
			throw new Error(msg);
		}
	}
	const user = await hdbGetUser.call(server, username, password);
	if (user) user.client_id = username;
	return user;
};

server.mqtt.authorizeClient = (connection_message, user) => {
	if (!user) {
		if (connection_message.clientId) throw new Error('Can not specify a client id');
		if (!connection_message.clean) throw new Error('Anonymous connections must be clean');
	} else if (connection_message.clientId !== user.client_id && !user.role?.permission?.super_user) {
		throw new Error('Invalid client id, client id from connection must match the client id in the token payload.');
	}
};
