// #1735 — MCP custom mcpResources (#1609) vs row-level allowRead.
//
// Order: per-row allowRead denies rows whose customerId doesn't match the
// requesting user's username (super_user always passes).
//
// OrderDocs: a component-author-style Resource publishing a custom MCP content
// resource `orders:///{+orderId}` (the #1609 `static mcpResources` pattern),
// wrapping real, row-level-guarded table data.
//
// SECURE fetch pattern (the fix for #1735): fetch through the *exported*
// (routing) `Order` Resource with a `checkPermission`-bearing RequestTarget, so
// its per-record `allowRead` runs against the calling MCP session user — the
// same gate REST enforces. Calling `tables.Order.get()` instead would dispatch
// on the *base* table class, whose `allowRead` is a table-level grant only, and
// would leak another user's row. The MCP layer runs the read inside a
// transaction that carries the calling user (components/mcp/resources.ts), so a
// single-arg `Order.get(target)` authorizes against that user.

import { RequestTarget } from 'harper';

function isSuper(user) {
	return !!user?.role?.permission?.super_user;
}

export class Order extends tables.Order {
	allowRead(user) {
		if (isSuper(user)) return true;
		return user?.username != null && this.customerId === user.username;
	}
}

export class OrderDocs extends Resource {
	async readOrder(params, context) {
		const target = new RequestTarget();
		target.id = params.orderId;
		// Ask the Resource to enforce its row-level allow* against this user.
		target.checkPermission = context?.user?.role?.permission ?? true;
		const order = await Order.get(target);
		if (!order) throw new Error(`no such order: ${params.orderId}`);
		return {
			text: JSON.stringify({
				id: order.id,
				customerId: order.customerId,
				item: order.item,
				total: order.total,
			}),
			mimeType: 'application/json',
		};
	}
}

OrderDocs.mcpResources = [
	{
		uriTemplate: 'orders:///{+orderId}',
		name: 'order by id',
		description: 'Fetch an order by id (wraps table data, the realistic #1609 use case)',
		mimeType: 'application/json',
		method: 'readOrder',
	},
];
