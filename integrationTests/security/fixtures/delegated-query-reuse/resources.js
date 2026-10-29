import { threadId } from 'node:worker_threads';

// Each delegate owns ONE module-level query object and reuses it for every request, through the documented
// pattern: `checkPermission: true` on the query, the requesting context as the second argument.
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

// Control: the same delegate building a fresh query object per request.
export class SearchFreshRoot extends Resource {
	static loadAsInstance = false;
	get() {
		return tables.ReuseEmployee.search(
			{ conditions: [{ attribute: 'id', value: 'e1' }], select: employeeSelect(), checkPermission: true },
			this.getContext()
		);
	}
}

// A nested selector shared by a user-facing table resource and trusted server code.
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

// What each shared query object looks like after the requests (super user only).
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

// A default-mode resource that forwards the REST target it was dispatched with to a caching table, asking for that
// table's authorization too: REST reads the cache disposition back off that same target to set `Age`.
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
