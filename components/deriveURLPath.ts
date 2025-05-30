import { join } from 'node:path';
import type { Component } from './Component';
import type { ComponentV2 } from './ComponentV2';

export function deriveURLPath(component: Component | ComponentV2, path: string, type: 'file' | 'directory'): string {
	for (const base of component.patternBases) {
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
			} else if (path.startsWith(base)) {
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
			} else if (path.startsWith(base)) {
				path = path.slice(base.length + 1); // +1 to remove the leading slash
				break;
			}
		}
	}

	return join(component.baseURLPath, path);
}
