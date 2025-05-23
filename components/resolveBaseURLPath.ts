export class InvalidBaseURLPathError extends Error {
	constructor(urlPath: string) {
		super(`urlPath must not contain '..'. Received: '${urlPath}'`);
	}
}

/**
 * Resolve the base URL path based on the component name and `urlPath` configuration option.
 *
 * For example, resolving the component config `urlPath` value for component `test-component`:
 * - `undefined`, `''`, `'/'` -> `'/'`
 * - `'static'`, `'/static/'`, `'/static'`, `'static/'` -> `'/static/'`
 * - `'v1/static'`, `'/v1/static/'`, `'/v1/static'`, `'v1/static/'` -> `'/v1/static/'`
 * - `'./static'`, `'./static/'` -> `'/test-component/static/'`
 * - `'.'`, `'./'` -> `'/test-component/'`
 * - `'..'`, `'../'`, `'../static'`, `'./..'` -> Error
 */
export function resolveBaseURLPath(name: string, urlPath?: string): string {
	if (urlPath?.includes('..')) {
		throw new InvalidBaseURLPathError(urlPath);
	}

	let baseURLPath = urlPath || '/';

	if (baseURLPath === '.' || baseURLPath.startsWith('./')) {
		baseURLPath = `/${name}${baseURLPath.slice(1)}`;
	}

	if (!baseURLPath.startsWith('/')) {
		baseURLPath = `/${baseURLPath}`;
	}

	if (!baseURLPath.endsWith('/')) {
		baseURLPath = `${baseURLPath}/`;
	}

	return baseURLPath;
}
