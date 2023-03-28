const QUERY_PARSER = /([^?&|=<>!(),]+)([&|=<>!(),]*)/g;
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
	get() {
		// HTTP endpoint
		const search = this.request.search;
		return search ? this.resource.search(this.parseQuery(search)) : this.resource.get();
	}
	update(updated_data) {
		if (this.user.role.permission.super_user) {
			return this.resource.update(updated_data);
		} else {
			throw new AccessError(this.user);
		}
	}
	async put(content) {
		return this.update(await content);
	}
	async patch(content) {
		const writable_record = this.update();
		for (const key in await content) {
			writable_record[key] = content[key];
		}
	}
	async post(content) {
		return this.create(await content);
	}
	create(content) {
		if (this.user.role.permission.super_user) return this.resource.create(content);
		throw new AccessError(this.user);
	}
	delete() {
		if (this.user.role.permission.super_user) return this.resource.delete();
		else throw new AccessError(this.user);
	}
	async publish(content) {
		if (!this.user.role.permission.super_user) throw new AccessError(this.user);
		const data = await content;
		//console.log('publish', identifier, require('worker_threads').threadId);
		if (this.request.retain) {
			// retain flag means we persist this message (for any future subscription starts), so treat it as the record itself
			if (data === undefined) return await this.delete();
			else return await this.update(data);
		} else return this.resource.publish(data);
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
