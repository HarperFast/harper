import { EventEmitter } from 'events';

export class IterableEventQueue extends EventEmitter {
	[Symbol.iterator]() {
		const iterator = new EventQueueIterator();
		this.on('data', iterator.listener);
		return iterator;
	}
	[Symbol.asyncIterator]() {
		const iterator = new EventQueueIterator();
		this.on('data', iterator.listener);
		return iterator;
	}
	push(message) {
		this.emit('data', message);
	}
}

class EventQueueIterator {
	resolveNext: Function;
	queue: [];
	nextMessage: any;
	listener: Function;
	constructor() {
		this.listener = (message) => {
			if (this.resolveNext) {
				this.resolveNext({ value: message });
				this.resolveNext = null;
			} else {
				if (this.nextMessage) {
					if (!this.queue) this.queue = [];
					this.queue.push(message);
				} else this.nextMessage = message;
			}
		};
	}
	push(message) {
		this.listener(message);
	}
	next() {
		if (this.nextMesssage) {
			const message = this.nextMesssage;
			if (this.queue) this.nextMesssage = this.queue.shift();
			else this.nextMesssage = null;
			return {
				value: message,
			};
		} else {
			return new Promise((resolve) => (this.resolveNext = resolve));
		}
	}
	return() {
		subscription.end();
	}
	throw() {
		subscription.end();
	}
}
