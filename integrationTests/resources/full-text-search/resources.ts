declare const Resource: any;
declare const tables: any;
declare const createBlob: any;

export class Product extends tables.Product {
	search(query) {
		query.rowFilter = (record, context) =>
			context.user?.role?.permission?.super_user || record.owner === context.user?.username;
		return super.search(query);
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
