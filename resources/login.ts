import { Resource } from './Resource.ts';
import type { Scope } from '../components/Scope.ts';

// Login class is created lazily because login.ts is loaded transitively from
// Resource.ts's own static graph; declaring `class Login extends Resource` at
// module-load would hit Resource's TDZ under that ESM cycle.
let LoginClass: any;
function getLoginClass() {
	if (LoginClass) return LoginClass;
	// @ts-ignore
	LoginClass = class Login extends Resource {
		static async get(_id, _body, _request) {
			// TODO: Return a login page
		}
		static async post(_id, body, request) {
			const { username, password, token } = body;
			return {
				data: await request.login(username, password, token),
			};
		}
	};
	return LoginClass;
}

export function handleApplication(scope: Scope) {
	scope.resources.set('login', getLoginClass());
	scope.resources.loginPath = (request) => {
		return '/login?redirect=' + encodeURIComponent(request.url);
	};
}
