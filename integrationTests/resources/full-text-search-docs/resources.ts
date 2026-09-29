declare const Resource: any;
declare const databases: any;
declare const createBlob: any;

const Product = databases.catalog.Product;

export class SearchProducts extends Resource {
	static async post(_target, data, context) {
		if (!context?.user) {
			const error = new Error('Authentication required');
			error.statusCode = 401;
			throw error;
		}
		const body = (await data) ?? {};
		const text = typeof body.q === 'string' ? body.q.trim() : '';
		if (!text) {
			const error = new Error('q is required');
			error.statusCode = 400;
			throw error;
		}
		const conditions = [
			{
				attribute: 'catalogSearch',
				comparator: 'matches',
				value: text,
				fields: ['name', 'description', 'tags'],
			},
		];
		const category = body.category;
		if (category) conditions.push({ attribute: 'category', comparator: 'equals', value: category });
		return databases.catalog.Product.search(
			{
				conditions,
				select: ['id', 'name', 'price', '$score', '$highlights'],
				limit: 20,
				checkPermission: true,
			},
			context
		);
	}
}

export class DocumentedProductQueries extends Resource {
	static async post(_target, data) {
		const { example } = (await data) ?? {};
		switch (example) {
			case 'basic': {
				const products = await Product.search({
					conditions: [
						{
							attribute: 'catalogSearch',
							comparator: 'matches',
							value: 'waterproof trail shoes',
						},
					],
					limit: 20,
				});
				return products;
			}
			case 'negated': {
				const products = await Product.search({
					operator: 'and',
					conditions: [
						{ attribute: 'catalogSearch', comparator: 'matches', value: 'waterproof' },
						{ attribute: 'catalogSearch', comparator: 'not_matches', value: 'leather' },
					],
				});
				return products;
			}
			case 'restricted': {
				const products = await Product.search({
					conditions: [
						{
							attribute: 'catalogSearch',
							comparator: 'matches_phrase',
							value: 'trail running',
							fields: ['name', 'description'],
						},
					],
				});
				return products;
			}
			case 'score': {
				const products = await Product.search({
					conditions: [{ attribute: 'catalogSearch', comparator: 'matches', value: 'trail shoes' }],
					select: ['id', 'name', '$score'],
					limit: 20,
				});
				return products;
			}
			case 'weight': {
				const products = await Product.search({
					conditions: [{ attribute: 'catalogSearch', comparator: 'matches', value: 'aurora' }],
					select: ['id', '$score'],
				});
				return products;
			}
			case 'highlights': {
				const products = await Product.search({
					conditions: [{ attribute: 'catalogSearch', comparator: 'matches_phrase', value: 'trail running' }],
					select: ['id', 'name', '$score', '$highlights'],
				});
				return products;
			}
			case 'structured-and': {
				const products = await Product.search({
					operator: 'and',
					conditions: [
						{ attribute: 'catalogSearch', comparator: 'matches', value: 'trail shoe' },
						{ attribute: 'price', comparator: 'less_than', value: 150 },
					],
					limit: 20,
				});
				return products;
			}
			case 'full-text-or': {
				const products = await Product.search({
					operator: 'or',
					conditions: [
						{ attribute: 'catalogSearch', comparator: 'matches_phrase', value: 'trail running' },
						{ attribute: 'catalogSearch', comparator: 'matches', value: 'hiking boot' },
					],
				});
				return products;
			}
			case 'freshness': {
				const products = [];
				for await (const product of Product.search({
					conditions: [
						{
							attribute: 'catalogSearch',
							comparator: 'matches',
							value: 'new product',
							maxIndexLagMilliseconds: 0,
							waitForIndexMilliseconds: 10000,
						},
					],
				})) {
					products.push(product);
				}
				return products;
			}
			case 'tutorial-freshness': {
				const products = [];
				for await (const product of databases.catalog.Product.search({
					conditions: [
						{
							attribute: 'catalogSearch',
							comparator: 'matches',
							value: 'new seasonal product',
							maxIndexLagMilliseconds: 0,
							waitForIndexMilliseconds: 10000,
						},
					],
				})) {
					products.push(product);
				}
				return products;
			}
			default: {
				const error = new Error('Unknown example');
				error.statusCode = 400;
				throw error;
			}
		}
	}
}

export class WriteDocument extends Resource {
	static async post(_target, data, context) {
		const body = await data;
		await databases.data.Document.put(
			{
				id: body.id,
				content: createBlob(body.text, { type: 'text/plain' }),
			},
			context
		);
		return { id: body.id };
	}
}

export class WriteDocumentWithMediaType extends Resource {
	static async post(_target, data, context) {
		const body = await data;
		await databases.data.Document.put(
			{
				id: body.id,
				content: createBlob(body.text, { type: body.mediaType }),
			},
			context
		);
		return { id: body.id };
	}
}
