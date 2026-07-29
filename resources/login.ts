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
		// a static override replaces the transactional() wrapper that would otherwise resolve this,
		// so the body arrives as a pending promise over REST (see resources/DESIGN.md)
		const { username, password, token } = (await body) ?? {};
		return {
			data: await request.login(username, password, token),
		};
	}
}
