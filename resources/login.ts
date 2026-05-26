import { Resource } from './Resource.ts';
import { Scope } from '../components/Scope.ts';
export function handleApplication(scope: Scope) {
	scope.resources.set('login', Login);
	scope.resources.loginPath = (request) => {
		return '/login?redirect=' + encodeURIComponent(request.url);
	};
}
// @ts-ignore
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
