import { Resource } from './Resource';
export function start({ resources }) {
	resources.set('login', Login);
}
class Login extends Resource {
	static async post(id, body, request) {
		const { username, password } = body;
		return {
			data: await request.login(username, password),
		};
	}
}
