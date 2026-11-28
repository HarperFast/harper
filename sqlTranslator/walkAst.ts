/**
 * Legacy SQL's walk over a statement: every value under `root`, depth first, with no depth limit. A node's children
 * are read only after the caller has seen the node, so a caller may replace them. Reaching an object a second time
 * throws `Circular reference` by default, which is what refuses a statement that shares a node, such as a subquery or a named
 * aggregate.
 */
export interface AstStep {
	node: any;
	key: string;
	/** The key under `root` that this step descends from. */
	root: string;
	/** Keys from `root` down to `node`, built when read. */
	readonly path: string[];
}

class Step implements AstStep {
	node: any;
	key: string;
	root: string;
	up: Step | undefined;

	constructor(node: any, key: string, up: Step | undefined) {
		this.node = node;
		this.key = key;
		this.root = up ? up.root : key;
		this.up = up;
	}

	get path(): string[] {
		const path: string[] = [];
		for (let step: Step | undefined = this; step; step = step.up) path.push(step.key);
		return path.reverse();
	}
}

/** `repeated: 'skip'` walks a node's children once and goes on, for a caller whose work on a node is idempotent. */
export function* walkAst(root: any, repeated: 'throw' | 'skip' = 'throw'): Generator<AstStep> {
	const expanded = new Set<object>();
	const pending: Step[] = [];
	let node = root;
	let current: Step | undefined;
	while (true) {
		if (node !== null && typeof node === 'object') {
			if (expanded.has(node)) {
				if (repeated === 'throw') throw new Error('Circular reference');
			} else {
				expanded.add(node);
				const keys = childKeys(node);
				for (let i = keys.length - 1; i >= 0; i--) pending.push(new Step(node[keys[i]], keys[i], current));
			}
		}
		current = pending.pop();
		if (current === undefined) return;
		yield current;
		node = current.node;
	}
}

function childKeys(node: object): string[] {
	const keys = Object.keys(node);
	if (Array.isArray(node)) return keys;
	if (isArrayLike(node)) {
		const length = keys.indexOf('length');
		if (length > -1) keys.splice(length, 1);
		return keys;
	}
	return keys.sort();
}

function isArrayLike(node: any): boolean {
	const length = node.length;
	return typeof length === 'number' && length > 0 && length - 1 in node;
}
