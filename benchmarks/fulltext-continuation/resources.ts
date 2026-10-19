import { runBenchmark } from './measure.cjs';
declare const Resource: any;
declare const tables: any;

export class Bench extends Resource {
	static loadAsInstance = false;
	allowCreate(user) {
		return Boolean(user?.role?.permission?.super_user);
	}
	post(_target, body) {
		return runBenchmark(body, tables.Product, tables.Control, this.getContext());
	}
}
