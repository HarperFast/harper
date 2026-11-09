// A custom resource that keeps the table's authorization: deliveries must still be narrowed.
export class TicketView68 extends tables.Ticket68 {
	static loadAsInstance = false;
	subscribe(request) {
		return super.subscribe(request);
	}
}
