// A custom resource that keeps the table's authorization: deliveries must still be narrowed.
export class TicketView68 extends tables.Ticket68 {
	static loadAsInstance = false;
	subscribe(request) {
		return super.subscribe(request);
	}
}
// A custom resource whose author replaced allowRead: no attribute narrowing is produced (documented contract).
export class OpenView68 extends tables.Ticket68 {
	allowRead() {
		return true;
	}
}
