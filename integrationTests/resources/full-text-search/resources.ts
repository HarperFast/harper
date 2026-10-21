import { getEnvironmentData, threadId } from 'node:worker_threads';
declare const Resource: any;
declare const tables: any;
declare const createBlob: any;
const runtimeSnapshotAtComponentLoad = Boolean(getEnvironmentData('harper.fullTextRuntimeConfiguration'));

export class Product extends tables.Product {
	search(query) {
		return super.search(this.filterQuery(query));
	}

	searchPage(query) {
		return super.searchPage(this.filterQuery(query));
	}

	filterQuery(query) {
		this.getContext().responseHeaders?.set('Fulltext-Test-Worker', String(threadId));
		query.rowFilter = (record, context) =>
			context.user?.role?.permission?.super_user || record.owner === context.user?.username;
		return query;
	}
}

export class SearchProduct extends Resource {
	static loadAsInstance = false;

	allowCreate(user) {
		return Boolean(user);
	}

	async post(_target, query) {
		const records = [];
		for await (const record of Product.search({ ...query, checkPermission: true }, this.getContext())) {
			records.push(record);
		}
		return records;
	}
}

export class IterableSearchProduct extends Resource {
	allowRead(user) {
		return Boolean(user);
	}

	async get(target) {
		const records = [];
		for await (const record of Product.search(target, this.getContext())) records.push(record);
		return records;
	}
}

export class CopiedPagingProduct extends Resource {
	allowRead(user) {
		return Boolean(user);
	}

	get(target) {
		return this.searchPage(target);
	}

	async searchPage(target) {
		const page = await Product.searchPage({ ...target, checkPermission: true }, this.getContext());
		return page.filter(() => true);
	}
}

export class IgnoredPagingProduct extends Resource {
	allowRead(user) {
		return Boolean(user);
	}

	get() {
		return [];
	}

	search() {
		return [];
	}
}

export class ManualPagingResponse extends IgnoredPagingProduct {
	get() {
		return new Response('[]', {
			headers: {
				'Content-Type': 'application/json',
				'Harper-Continuation-Complete': 'true',
				'Cache-Control': 'no-store',
			},
		});
	}
}

export class AggregatePagingProduct extends IgnoredPagingProduct {
	async search() {
		const page = await Product.query(
			{ isCollection: true, checkPermission: true },
			{
				conditions: [{ attribute: 'catalogSearch', comparator: 'matches', value: 'pagination' }],
				select: ['id'],
				limit: 1000,
				continuation: true,
			},
			this.getContext()
		);
		return { count: page.length };
	}
}

export class EnvelopedPagingProduct extends IgnoredPagingProduct {
	async get(target) {
		const page = await Product.searchPage({ ...target, checkPermission: true }, this.getContext());
		return { headers: { 'Fulltext-Test-Envelope': 'true' }, data: page };
	}
}

export class TimestampedPagingProduct extends IgnoredPagingProduct {
	async get(target) {
		const context = this.getContext();
		const query = { ...target, checkPermission: true };
		let result;
		if (target.continuation !== undefined) result = await Product.searchPage(query, context);
		else {
			result = [];
			for await (const record of Product.search(query, context)) result.push(record);
		}
		context.lastModified = 42;
		return result;
	}
}

export class FullTextState extends Resource {
	allowRead(user) {
		return Boolean(user?.role?.permission?.super_user);
	}

	get() {
		return Object.fromEntries(
			['Product', 'LifecycleProduct'].map((name) => {
				const Table = tables[name];
				return [
					name,
					{
						tableId: Table.tableId,
						runtimeSnapshotAtComponentLoad,
						generations: Table.fullTextIndexGenerations,
						storePath: Table.primaryStore.rootStore.path,
						fields: Table.fullTextIndexes.map(({ name }) => name),
						attributes: Table.attributes.map(({ name }) => name),
						properties: Table.properties,
					},
				];
			})
		);
	}
}

export class WriteSearchBlob extends Resource {
	static loadAsInstance = false;

	async post(_target, body) {
		await tables.Product.put(
			{
				id: body.id,
				content: createBlob(body.text, { type: 'text/plain' }),
			},
			this.getContext()
		);
		return { id: body.id };
	}
}

export class FailingContinuationResponse extends Resource {
	static loadAsInstance = false;

	search(target, body) {
		return this.get({ ...target, ...body });
	}

	allowRead(user) {
		return Boolean(user?.role?.permission?.super_user);
	}

	async get(target) {
		const page = await tables.Product.searchPage(
			{
				conditions: [{ attribute: 'catalogSearch', comparator: 'matches', value: 'pagination' }],
				limit: 1,
				select: ['id'],
				continuation: target.continuation ?? true,
				closeContinuation: target.closeContinuation,
			},
			this.getContext()
		);
		if (page.length > 0)
			page[0] = {
				id: page[0].id,
				toString() {
					throw new Error('Continuation response serialization failed');
				},
			};
		return page;
	}
}
