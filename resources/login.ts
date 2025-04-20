import { Resource } from './Resource.ts';
export function start({ resources }) {
	resources.set('login', Login);
	resources.loginPath = (request) => {
		return '/login?redirect=' + encodeURIComponent(request.url);
	};
}
class Login extends Resource {
	static async get(id, body, request) {
		// TODO: Return a login page
	}
	static async post(id, body, request) {
		const { username, password, redirect } = body;
		return {
			data: await request.login(username, password),
		};
	}
}
