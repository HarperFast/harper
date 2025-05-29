import { join } from 'node:path';
import type { Component } from './Component';
import type { ComponentV2 } from './ComponentV2';

export function deriveURLPath(component: Component | ComponentV2, path: string): string {
	for (const base of component.patternBases) {
		if (path !== base && path.startsWith(base)) {
			path = path.slice(base.length);
			break;
		}
	}

	return join(component.baseURLPath, path);
}
