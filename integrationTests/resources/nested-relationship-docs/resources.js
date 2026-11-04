export class DocumentedQueries extends Resource {
	static loadAsInstance = false;
	async get() {
		const Brand = tables.Brand;
		const brand = await Brand.get({
			id: 42,
			select: [
				'id',
				{
					name: 'products',
					conditions: [{ attribute: 'price', comparator: 'greater_than_equal', value: 30 }],
					sort: { attribute: 'price' },
					offset: 0,
					limit: 1,
					select: ['id', 'price'],
				},
			],
		});
		const brands = [];
		for await (const brand of Brand.search({
			conditions: [{ attribute: ['products', 'price'], comparator: 'greater_than_equal', value: 30 }],
			select: [
				'id',
				'name',
				{ name: 'products', sort: { attribute: 'price' }, limit: 1, select: ['id', 'name', 'price'] },
			],
		})) {
			brands.push(brand);
		}
		return { single: brand, programmatic: brands };
	}
}
