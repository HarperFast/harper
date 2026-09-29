/**
 * Type-contract test for the table class `makeTable()` returns — asserts the SHIPPED declarations
 * (imported from the built package): a table can be subclassed with overridden methods and
 * accessors, its statics and instances are typed, and none of its private state is part of the type.
 *
 * Run (after `npm run build`):  npm run test:types
 * A green run IS the proof; `@ts-expect-error` lines prove the negative cases.
 */

/* eslint-disable @typescript-eslint/no-unused-vars */

import type { Table } from '../../dist/index.js';
import type { TableResourceClass, TableResourceInstance } from '../../dist/resources/Table.js';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
type IsAny<T> = 0 extends 1 & T ? true : false;

// NOTE: type-check-only (never executed); `Dog` stands in for any `tables.X`.
declare const Dog: Table;

export class CachedDog extends Dog {
	get(target?: any) {
		return super.get(target);
	}
	put(target: any, record: any) {
		return super.put(target, record);
	}
	get isCollection() {
		return super.isCollection;
	}
	static sourcedFrom(source: any, options: any) {
		return super.sourcedFrom(source, options);
	}
}

type _tableIsTheClass = Expect<Table extends TableResourceClass ? true : false>;
type _prototypeIsTyped = Expect<Equal<Table['prototype'], TableResourceInstance>>;
type _instanceIsTyped = Expect<Equal<IsAny<InstanceType<Table>>, false>>;
type _getUpdatedTime = Expect<Equal<ReturnType<TableResourceInstance['getUpdatedTime']>, number>>;
type _recordCount = Expect<Equal<Awaited<ReturnType<Table['getRecordCount']>>['recordCount'], number>>;
type _staticMetadata = Expect<Equal<Table['get']['reliesOnPrototype'], boolean>>;
type _sourcedFromReturnsTheClass = Expect<Equal<ReturnType<Table['sourcedFrom']>, TableResourceClass>>;

interface DogRecord {
	name: string;
}
const dog = new Dog<DogRecord>(1, null);
type _genericInstance = Expect<Equal<typeof dog, TableResourceInstance<DogRecord>>>;
const loaded = Dog.getResource<DogRecord>(1 as any, {} as any);
type _getResource = Expect<
	Equal<typeof loaded, Promise<TableResourceInstance<DogRecord>> | TableResourceInstance<DogRecord>>
>;

// @ts-expect-error a DogRecord's name is a string
dog.put(1 as any, { name: 1 });
// @ts-expect-error getUpdatedTime returns a number
const updated: string = dog.getUpdatedTime();

// @ts-expect-error private state is not part of the instance type
dog['__#private@#record'];
// @ts-expect-error private state is not part of the prototype type
Dog.prototype['__#private@#changes'];
