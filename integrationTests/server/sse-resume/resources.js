export class Cursor extends Resource {
	static loadAsInstance = false;
	static async *connect(_target, _incomingMessages, request) {
		yield { event: 'cursor', data: { lastEventId: request.lastEventId ?? null }, id: 'cursor-1' };
	}
}
