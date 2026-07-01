import jwt from 'jsonwebtoken';
import SETTINGS from './connect.json' with { type: 'json' };

// RS256 public key for integration-test JWT verification.
// The matching private key lives only in the test file — never in production.
const RS256_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqY92YxTkPrx3Gl2Ynxpc
mQvlWV7UiPvtVYZfagJ1EuqH1ZzWz0rDwyis8bZ+OriQ9KpmCGAx09fw+KiTlYeG
zdI5QExz0f6bGTZJtMoGoQMUxuS2ykpsenvonEvcGyZxiwEJY7lKuJL74B04Ejk4
5Y5yNF34D1lfuMj8pZohlpcGMDhFycHoCXJBNQmm1ReL7qqSXiKnygqap6rMDwDl
FHYPYPjDoxqBKlBJBHHbQ9+Ek3FSzAhv61Igwh5gjtzTmSFsvW0oHOW0LORRDM8F
rg3qdU1bbY/o8UU2P0Y1nNuSJbmS2D7Ui0f0Vi3FieZqNpgVJmpJK4lAHXWjyOpE
gQIDAQAB
-----END PUBLIC KEY-----`;

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
			const decoded = jwt.verify(password, RS256_PUBLIC_KEY, { algorithms: ['RS256'] });
			return new User(
				decoded[SETTINGS.options.userName] ?? username,
				decoded[SETTINGS.options.clientId],
				decoded[SETTINGS.options.authorizations]
			);
		} catch (e) {
			const msg = `Error verifying RS256 token: ${e.message}. For username: ${username}`;
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
		if (connection_message.clientId) throw new Error('Anonymous connections must not specify a client id');
		if (!connection_message.clean) throw new Error('Anonymous connections must be clean');
	} else if (connection_message.clientId !== user.client_id && !user.role?.permission?.super_user) {
		throw new Error('Invalid client id, client id from connection must match the client id in the token payload.');
	}
};
