import { join } from 'node:path';
import type { Component } from './Component.js';
import type { ComponentV1 } from './ComponentV1.js';

function pathStartsWithBase(base: string, path: string) {
	const re = new RegExp(`^${base}(/|$)`);
	return re.test(path);
}

export function deriveURLPath(component: Component | ComponentV1, path: string, type: 'file' | 'directory'): string {
	if (path.startsWith('./')) {
		path = path.slice(2); // remove leading './'
	}

	for (let base of component.patternBases) {
		if (base.startsWith('./')) {
			base = base.slice(2); // remove leading './'
		}

		if (base === '') continue;

		// files
		// path, base -> result
		// index.html, index.html -> index.html
		// web/index.html, web -> index.html
		// web/index.html, web/index.html -> index.html
		// web/static/index.html, web/static/index.html -> index.html
		// web/static/index.html, web -> static/index.html
		if (type === 'file') {
			if (path === base) {
				const split = path.split('/');
				path = split[split.length - 1]; // get the last part of the path
				break;
			} else if (pathStartsWithBase(base, path)) {
				path = path.slice(base.length + 1); // +1 to remove the leading slash
				break;
			}
		}

		// directories
		// path, base -> result
		// web, web -> /
		// web/static, web/static -> /
		// web/static, web -> static
		if (type === 'directory') {
			if (path === base) {
				path = '';
				break; // no change needed
			} else if (pathStartsWithBase(base, path)) {
				path = path.slice(base.length + 1); // +1 to remove the leading slash
				break;
			}
		}
	}

	return join(component.baseURLPath, path);
}
