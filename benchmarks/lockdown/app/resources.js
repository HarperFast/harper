import { Resource } from 'harper';
import { pack, Unpackr } from 'msgpackr';

const unpackr = new Unpackr({ useRecords: false });
const productRecord = pack({
	id: 'prod-1042',
	name: 'Trail running shoe',
	price: 129.95,
	tags: ['outdoor', 'running'],
	inStock: true,
});
const prefilled = Array.from({ length: 17 }, (_, index) => 97 + index);

const OPERATIONS = {
	holeyFillApply() {
		const codes = new Array(17);
		for (let index = 0; index < 17; index++) codes[index] = 97 + index;
		return String.fromCharCode.apply(null, codes);
	},
	msgpackrUnpack() {
		return unpackr.unpack(productRecord);
	},
	packedApply() {
		return String.fromCharCode.apply(null, prefilled);
	},
	mapSpread() {
		return [...prefilled.map((code) => code + 1)];
	},
};

let sink;
function nanosecondsPerOperation(operation, iterations) {
	const start = process.hrtime.bigint();
	for (let index = 0; index < iterations; index++) sink = operation();
	return Number(process.hrtime.bigint() - start) / iterations;
}

export class LockdownBench extends Resource {
	static loadAsInstance = false;
	get(target) {
		const iterations = Number(target.get('iterations') ?? 200_000);
		const rounds = Number(target.get('rounds') ?? 5);
		const result = {
			sealed: Object.isSealed(Array.prototype),
			frozen: Object.isFrozen(Array.prototype),
			nanoseconds: {},
		};
		for (const [name, operation] of Object.entries(OPERATIONS)) {
			nanosecondsPerOperation(operation, iterations);
			let best = Infinity;
			for (let round = 0; round < rounds; round++)
				best = Math.min(best, nanosecondsPerOperation(operation, iterations));
			result.nanoseconds[name] = best;
		}
		result.producedOutput = sink !== undefined;
		return result;
	}
}
