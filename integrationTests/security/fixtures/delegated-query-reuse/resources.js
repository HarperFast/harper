import { threadId } from 'node:worker_threads';

const employeeSelect = () => ['id', 'name', { name: 'department', select: ['id', 'label', 'secret'] }];
const ROOTS = {};

function reportWorker(context) {
	context.responseHeaders?.set('x-worker', String(threadId));
}

function sharedSearchRoot(key) {
	const root = { conditions: [{ attribute: 'id', value: 'e1' }], select: employeeSelect(), checkPermission: true };
	ROOTS[key] = root;
	return class extends Resource {
		static loadAsInstance = false;
		get() {
			reportWorker(this.getContext());
			return tables.ReuseEmployee.search(root, this.getContext());
		}
	};
}
export class SearchBroadFirst extends sharedSearchRoot('SearchBroadFirst') {}
export class SearchRestrictedFirst extends sharedSearchRoot('SearchRestrictedFirst') {}
export class SearchAcrossWorkers extends sharedSearchRoot('SearchAcrossWorkers') {}

function sharedGetRoot(key) {
	const root = { id: undefined, select: employeeSelect(), checkPermission: true };
	ROOTS[key] = root;
	return class extends Resource {
		static loadAsInstance = false;
		get(target) {
			root.id = target.id;
			return tables.ReuseEmployee.get(root, this.getContext());
		}
	};
}
export class GetBroadFirst extends sharedGetRoot('GetBroadFirst') {}
export class GetRestrictedFirst extends sharedGetRoot('GetRestrictedFirst') {}

export class SearchFreshRoot extends Resource {
	static loadAsInstance = false;
	get() {
		return tables.ReuseEmployee.search(
			{ conditions: [{ attribute: 'id', value: 'e1' }], select: employeeSelect(), checkPermission: true },
			this.getContext()
		);
	}
}

const MCP_SELECTORS = new Map();
export class SelectorDocs extends Resource {
	static mcpResources = [
		{
			uriTemplate: 'selectors:///{permission}/{ownership}/{order}',
			name: 'delegated selector projection',
			description: 'Read a relationship with a reusable nested selector under the MCP session user',
			mimeType: 'application/json',
			method: 'readSelector',
		},
	];
	async readSelector({ permission, ownership, order }, context) {
		const key = `${permission}/${ownership}/${order}`;
		let select = MCP_SELECTORS.get(key);
		if (!select) MCP_SELECTORS.set(key, (select = employeeSelect()));
		const record = await tables.ReuseEmployee.get({
			id: 'e1',
			select: ownership === 'cloned' ? structuredClone(select) : select,
			checkPermission: permission === 'object' ? context.user.role.permission : true,
		});
		const symbols = [select, select[2]].map((value) => Object.getOwnPropertySymbols(value).map(String));
		return { text: JSON.stringify({ record, select, symbols }), mimeType: 'application/json' };
	}
}

const INTERNAL_SELECT = employeeSelect();
export class SharedSelectorCard extends tables.ReuseEmployee {
	static loadAsInstance = false;
	get(target) {
		target.select = INTERNAL_SELECT;
		return super.get(target);
	}
}
export class TrustedRead extends Resource {
	static loadAsInstance = false;
	async get() {
		if (!this.getContext()?.user?.role?.permission?.super_user)
			throw Object.assign(new Error('super user only'), { statusCode: 403 });
		const record = await tables.ReuseEmployee.get({ id: 'e1', select: INTERNAL_SELECT });
		return JSON.parse(JSON.stringify(record));
	}
}

export class RootState extends Resource {
	static loadAsInstance = false;
	get() {
		if (!this.getContext()?.user?.role?.permission?.super_user)
			throw Object.assign(new Error('super user only'), { statusCode: 403 });
		const state = {};
		for (const [key, root] of Object.entries(ROOTS)) {
			state[key] = {
				checkPermission: root.checkPermission,
				select: JSON.parse(JSON.stringify(root.select)),
				symbols: Object.getOwnPropertySymbols(root).map(String),
			};
		}
		state.INTERNAL_SELECT = { select: JSON.parse(JSON.stringify(INTERNAL_SELECT)) };
		return state;
	}
}

let sourceReads = 0;
tables.ReuseCachedLabel.sourcedFrom({
	get(id) {
		sourceReads++;
		return { id, label: `label ${id}`, secret: `secret ${id}` };
	},
});
export class CachedLabelView extends Resource {
	allowRead() {
		return true;
	}
	get(target) {
		target.checkPermission = true;
		return tables.ReuseCachedLabel.get(target, this.getContext());
	}
}
export class CachedLabelSourceReads extends Resource {
	static loadAsInstance = false;
	get() {
		return { sourceReads };
	}
}
