import { EventEmitter } from 'events';

export class IterableEventQueue extends EventEmitter {
	resolveNext: Function;
	queue: [];
	nextMessage: any;
	listener: Function;
	[Symbol.asyncIterator]() {
		const iterator = new EventQueueIterator();
		iterator.queue = this;
		return iterator;
	}
	push(message) {
		this.send(message);
	}
	send(message) {
		if (this.resolveNext) {
			this.resolveNext({ value: message });
			this.resolveNext = null;
		} else {
			if (this.nextMessage) {
				if (!this.queue) this.queue = [];
				this.queue.push(message);
			} else this.nextMessage = message;
		}
	}
	getNextMessage() {
		const message = this.nextMessage;
		if (message && this.queue) this.nextMessage = this.queue.shift();
		else this.nextMessage = null;
		return message;
	}
}

class EventQueueIterator {
	queue: IterableEventQueue;
	push(message) {
		this.listener(message);
	}
	next() {
		const message = this.queue.getNextMessage();
		if (message) {
			return {
				value: message,
			};
		} else {
			return new Promise((resolve) => (this.queue.resolveNext = resolve));
		}
	}
	return() {
		this.queue.emit('close');
	}
	throw() {
		this.queue.emit('close');
	}
}
