const QUERY_PARSER = /([^?&|=<>!()]+)([&|=<>!()]*)/g;
const SYMBOL_OPERATORS = {
	'<': 'lt',
	'<=': 'le',
	'>': 'gt',
	'>=': 'ge',
};

class AccessError extends Error {
	constructor(user) {
		super();
		if (user) {
			super('Unauthorized access to resource');
			this.status = 403;
		} else {
			super('Must login');
			this.status = 401;
			// TODO: Optionally allow a Location header to redirect to
		}
	}
}

export class DefaultAccess {
	constructor(public request, public resource) {}
	get user() {
		return this.request.user;
	}
	async get() {
		// HTTP endpoint
		const search = this.request.search;
		let query;
		if (search) query = this.parseQuery(search);
		// parse the query first and pass it to allowRead so it can inform attribute-level permissions
		// and the permissions can modify the query, assigning a select for available attributes.
		this.resource.saveUpdates = false; // by default modifications aren't saved, they just yield a different result from get
		await this.resource.loadRecord?.();
		if (this.request) {
			const allowed = await this.resource.allowRead(this.request.user, query);
			if (!allowed) {
				throw new AccessError(this.user);
			}
			if (typeof allowed === 'object') query = allowed;
		}
		return this.resource.get(query);
	}
	async put(content) {
		// TODO: May want to parse search/query part of URL and pass it through
		await this.resource.loadRecord();
		const updated_data = await content;
		if (this.resource.allowUpdate(this.request.user, updated_data)) {
			this.resource.updated = true;
			return this.resource.put(updated_data);
		} else {
			throw new AccessError(this.user);
		}
	}
	async patch(content) {
		const updated_data = await content;
		if (this.resource.allowUpdate(this.request.user, updated_data, true)) {
			for (const key in updated_data) {
				this.resource.set(key, updated_data[key]);
			}
		} else {
			throw new AccessError(this.user);
		}
	}
	async post(content) {
		await this.resource.loadRecord();
		const data = await content;
		this.resource.updated = true;
		if (this.resource.allowCreate(this.request.user, data)) return this.post(data);
		else throw new AccessError(this.user);
	}
	async delete() {
		await this.resource.loadRecord();
		if (this.resource.allowDelete(this.request.user)) return this.resource.delete();
		else throw new AccessError(this.user);
	}
	async publish(content) {
		await this.resource.loadRecord();
		const data = await content;
		//console.log('publish', identifier, require('worker_threads').threadId);
		if (this.request.retain) {
			// retain flag means we persist this message (for any future subscription starts), so treat it as the record itself
			if (data === undefined) {
				if (this.resource.allowDelete(this.request.user, data)) {
					return this.delete();
				}
			} else if (this.resource.allowUpdate(this.request.user, data, true)) {
				return this.resource.update(data);
			}
		} else {
			if (this.resource.allowUpdate(this.request.user, {})) return this.resource.publish(data);
		}
		throw new AccessError(this.user);
	}
	async subscribe(options) {
		await this.resource.loadRecord?.();
		//console.log('publish', identifier, require('worker_threads').threadId);
		const allowed = await this.resource.allowRead(this.request.user, options.search);
		if (!allowed) throw new AccessError(this.user);
		return this.resource.subscribe(options);
	}

	/**
	 * This is responsible for taking a query string (from a get()) and converting it to a standard query object
	 * structure
	 * @param query_string
	 */
	parseQuery(query_string: string) {
		let match;
		let attribute, comparison;
		const conditions = [];
		let offset, limit, sort, select;
		// TODO: Use URLSearchParams with a fallback for when it can't parse everything (USP is very fast)
		while ((match = QUERY_PARSER.exec(query_string))) {
			let [, value, operator] = match;
			switch (operator[0]) {
				case ')':
					// finish call
					operator = operator.slice(1);
					break;
				case '=':
					if (attribute) {
						// a FIQL operator like =gt=
						comparison = value;
					} else {
						comparison = 'equals';
						attribute = decodeURIComponent(value);
					}
					break;
				case '!':
				// TODO: not-equal
				case '<':
				case '>':
					comparison = SYMBOL_OPERATORS[operator];
					attribute = decodeURIComponent(value);
					break;
				case undefined:
				case '&':
				case '|':
					if (attribute) {
						switch (attribute) {
							case 'offset':
								offset = +value;
								break;
							case 'limit':
								limit = +value;
								break;
							case 'select':
								select = value.split(',');
								break;
							default:
								conditions.push({
									type: comparison,
									attribute,
									value: decodeURIComponent(value),
								});
						}
					}
					attribute = undefined;
			}
		}
		return {
			offset,
			limit,
			sort,
			select,
			conditions,
		};
	}
}
