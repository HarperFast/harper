import { Resource } from './Resource.js';
export function start({ resources }) {
	resources.set('login', Login);
	resources.loginPath = (request) => {
		return '/login?redirect=' + encodeURIComponent(request.url);
	};
}
class Login extends Resource {
	static async get(_id, _body, _request) {
		// TODO: Return a login page
	}
	static async post(_id, body, request) {
		const { username, password } = body;
		return {
			data: await request.login(username, password),
		};
	}
}
