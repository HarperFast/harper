export class OrderSummary extends Resource {
	static description = 'Rolled-up order totals.';
	static primaryKey = 'orderId';
	static properties = {
		orderId: { type: 'string', primaryKey: true, description: 'Order id.' },
		status: { type: 'string', enum: ['open', 'closed'], description: 'Fulfillment state.', nullable: false },
		note: { type: ['string', 'null'], description: 'Nullable note.' },
		profile: {
			type: 'object',
			properties: {
				name: { type: 'string', description: 'Visible name.' },
				creditScore: { type: 'integer', hidden: true, description: 'INTERNAL-ONLY-MARKER' },
			},
			required: ['name', 'creditScore'],
		},
		allHidden: { type: 'object', properties: { secret: { type: 'string', hidden: true } }, required: ['secret'] },
		tags: { type: 'array', items: { type: 'string', enum: ['x', 'y'], description: 'Tag.' } },
		anything: { type: 'array' },
		choice: { type: ['string', 'integer', 'null'], enum: ['a', 1] },
	};

	get() {
		return { orderId: 'o1' };
	}

	post() {
		return { orderId: 'o1' };
	}
}
