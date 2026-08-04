require('../testUtils');
const assert = require('assert');
const { handleApplication } = require('#src/resources/login');

// A static override replaces the transactional() wrapper, so it receives `data` unresolved —
// over REST that is the streaming deserializer's pending promise. Login.post must await it;
// destructuring the promise directly yields undefined credentials with no error (a promise has
// no own enumerable properties), which silently breaks authentication.
describe('login resource', () => {
	let Login;

	before(() => {
		const scope = { resources: new Map() };
		handleApplication(scope);
		Login = scope.resources.get('login');
	});

	it('registers the login resource', () => {
		assert.ok(Login, 'login resource should be registered');
		assert.equal(typeof Login.post, 'function');
	});

	it('awaits a promise body before reading credentials', async () => {
		const seen = [];
		const request = {
			login: async (username, password, token) => {
				seen.push({ username, password, token });
				return 'session-token';
			},
		};

		const result = await Login.post(null, Promise.resolve({ username: 'alice', password: 'pw' }), request);

		assert.deepEqual(seen, [{ username: 'alice', password: 'pw', token: undefined }]);
		assert.equal(result.data, 'session-token');
	});

	it('still accepts an already-resolved body', async () => {
		const seen = [];
		const request = {
			login: async (username, password, token) => {
				seen.push({ username, password, token });
				return 'session-token';
			},
		};

		await Login.post(null, { username: 'bob', token: 'tok' }, request);

		assert.deepEqual(seen, [{ username: 'bob', password: undefined, token: 'tok' }]);
	});
});
