import { EventEmitter } from 'events';

export class IterableEventQueue extends EventEmitter {
	resolveNext: Function;
	queue: any[];
	hasDataListeners: boolean;
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
		} else if (this.hasDataListeners) {
			this.emit('data', message);
		} else {
			if (!this.queue) this.queue = [];
			this.queue.push(message);
		}
	}
	getNextMessage() {
		return this.queue?.shift();
	}
	on(event_name, listener) {
		if (event_name === 'data' && !this.hasDataListeners) {
			this.hasDataListeners = true;
			while (this.queue?.length > 0) listener(this.queue.shift());
		}
		return super.on(event_name, listener);
	}
}

class EventQueueIterator {
	queue: IterableEventQueue;
	push(message) {
		this.queue.send(message);
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
	return(value) {
		this.queue.emit('close');
		return {
			value,
			done: true,
		};
	}
	throw(error) {
		this.queue.emit('close', error);
		return {
			done: true,
		};
	}
}
