import { Resource } from './Resource';
import { Context } from './ResourceInterface';

export class ErrorResource implements Resource {
	constructor(public error) {}
	isError = true;
	allowRead(): never {
		throw this.error;
	}
	allowUpdate(): never {
		throw this.error;
	}
	allowCreate(): never {
		throw this.error;
	}
	allowDelete(): never {
		throw this.error;
	}
	getId(): never {
		throw this.error;
	}
	getContext(): Context {
		throw this.error;
	}
	get(): never {
		throw this.error;
	}
	post(): never {
		throw this.error;
	}
	put(): never {
		throw this.error;
	}
	delete(): never {
		throw this.error;
	}
	connect(): never {
		throw this.error;
	}
	getResource() {
		// all child paths resolve back to reporting this error
		return this;
	}
	publish(): never {
		throw this.error;
	}
	subscribe(): never {
		throw this.error;
	}
}
