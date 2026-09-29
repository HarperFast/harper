// Exact identity rather than mutual assignability, which lets `any`, dropped overloads and
// bivariant method parameters pass unnoticed.
export type ExactlyEqual<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

export type MemberDrift<Actual, Declared> =
	| Exclude<keyof Actual, keyof Declared>
	| Exclude<keyof Declared, keyof Actual>
	| {
			[Key in keyof Actual & keyof Declared]: ExactlyEqual<Pick<Actual, Key>, Pick<Declared, Key>> extends true
				? never
				: Key;
	  }[keyof Actual & keyof Declared];

export type AssertNoDrift<Drift extends never> = Drift;

export type AssertTrue<Condition extends true> = Condition;

export interface ParitySentinel {
	readonly paritySentinel: true;
}
