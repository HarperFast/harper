import { schemaOf } from 'harper';

export class OrderSummary extends Resource {
	static description = 'Rolled-up order totals.';
	static primaryKey = 'orderId';
	static required = ['note', 'extension'];
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
			required: ['name', 'creditScore', 'nestedExtension'],
		},
		allHidden: { type: 'object', properties: { secret: { type: 'string', hidden: true } }, required: ['secret'] },
		tags: { type: 'array', items: { type: 'string', enum: ['x', 'y'], description: 'Tag.' } },
		conditionalText: { type: 'string', properties: { label: { type: 'integer' } } },
		conditionalTags: { type: 'array', properties: { label: { type: 'integer' } }, items: { type: 'string' } },
		conditionalNullableTags: {
			type: ['array', 'null'],
			properties: { label: { type: 'integer' } },
			items: { type: 'string' },
		},
		anything: { type: 'array' },
		payload: { enum: [{ a: 1, b: [true, null] }, ['x']], const: { b: [true, null], a: 1 } },
		choice: { type: ['string', 'integer', 'null'], enum: ['a', 1] },
	};

	get() {
		return { orderId: 'o1', status: 'open', note: null, extension: true };
	}

	post() {
		return { orderId: 'o1', status: 'open', note: null, extension: true };
	}
}

export class ConditionalIntake extends Resource.withSchema({
	post: {
		body: schemaOf({ properties: { label: { type: 'string' } }, items: { type: 'string' } }),
		response: schemaOf({
			type: 'object',
			properties: { result: { properties: { label: { type: 'string' } }, items: { type: 'string' } } },
		}),
	},
}) {
	post(_target, data) {
		return { result: data };
	}
}
