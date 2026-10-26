/**
 * `applications.lockdown` as an application sees it: what a component may change on the shared intrinsics while it
 * loads, and what an attacker-controlled key can still add once the worker serves requests. The default config is
 * left unspecified, so the first suite covers whatever `static/defaultConfig.yaml` ships.
 *
 * Run: npm run test:integration -- "integrationTests/components/intrinsics-lockdown.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, strictEqual } from 'node:assert';
import { join } from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
import { authHeader, operation } from '../deploy/redeploy-restart-flag-helpers.ts';

const PROBE_SOURCE = `import { Resource } from 'harper';
import { threadId } from 'node:worker_threads';
function tryAdd(target, name) {
	try {
		target[name] = true;
		return Object.hasOwn(target, name);
	} catch (error) {
		return error.name;
	}
}
let addedAtLoad;
try {
	// non-enumerable, as a polyfill would define it, so for...in over arrays elsewhere in the worker stays clean
	Object.defineProperty(Array.prototype, 'harperLoadTimeProbe', { value: true });
	addedAtLoad = true;
} catch (error) {
	addedAtLoad = error.name;
}
let requests = 0;
export class LockdownProbe extends Resource {
	static loadAsInstance = false;
	get() {
		const name = 'harperRequestProbe' + ++requests;
		const afterLoad = {
			objectPrototype: tryAdd(Object.prototype, name),
			arrayPrototype: tryAdd(Array.prototype, name),
			functionPrototype: tryAdd(Function.prototype, name),
			reflectSet: Reflect.set(Object.prototype, name + 'Reflect', true),
		};
		const visibleOnPlainObject = {}[name] === true || {}[name + 'Reflect'] === true;
		for (const target of [Object.prototype, Array.prototype, Function.prototype]) {
			delete target[name];
			delete target[name + 'Reflect'];
		}
		const shadowing = {};
		shadowing.toString = () => 'shadowed';
		return {
			threadId,
			addedAtLoad,
			loadTimeVisible: [].harperLoadTimeProbe === true,
			afterLoad,
			visibleOnPlainObject,
			shadowedToString: String(shadowing) === 'shadowed',
			sealed: [Object.prototype, Array.prototype, Function.prototype].map((target) => Object.isSealed(target)),
			frozen: [Object.prototype, Array.prototype, Function.prototype].map((target) => Object.isFrozen(target)),
		};
	}
}
`;

type Probe = {
	threadId: number;
	addedAtLoad: true | string;
	loadTimeVisible: boolean;
	afterLoad: {
		objectPrototype: true | string;
		arrayPrototype: true | string;
		functionPrototype: true | string;
		reflectSet: boolean;
	};
	visibleOnPlainObject: boolean;
	shadowedToString: boolean;
	sealed: boolean[];
	frozen: boolean[];
};

const SEALED_AFTER_LOAD = {
	afterLoad: {
		objectPrototype: 'TypeError',
		arrayPrototype: 'TypeError',
		functionPrototype: 'TypeError',
		reflectSet: false,
	},
	visibleOnPlainObject: false,
	shadowedToString: true,
	sealed: [true, true, true],
	frozen: [false, false, false],
};

async function readProbe(ctx: ContextWithHarper, previousThreadId?: number): Promise<Probe> {
	const deadline = Date.now() + 60_000;
	let last = '';
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`${ctx.harper.httpURL}/LockdownProbe`, {
				headers: { Authorization: authHeader(ctx) },
				signal: AbortSignal.timeout(5_000),
			});
			if (response.status === 200) {
				const probe = (await response.json()) as Probe;
				if (probe.threadId !== previousThreadId) return probe;
			} else {
				last = `${response.status}: ${await response.text()}`;
			}
		} catch (error) {
			last = String(error);
		}
		await sleep(250);
	}
	throw new Error(`LockdownProbe never answered from a fresh worker; last answer ${last}`);
}

function lockdownSuite(lockdown: string | undefined, expect: (probe: Probe) => void, afterRestart?: boolean) {
	suite(`intrinsics lockdown: ${lockdown ?? 'default config'}`, (ctx: ContextWithHarper) => {
		let fixtureParent: string;

		before(async () => {
			fixtureParent = await mkdtemp(join(tmpdir(), 'intrinsics-lockdown-'));
			const appDirectory = join(fixtureParent, 'intrinsics-lockdown-app');
			await mkdir(appDirectory);
			await writeFile(join(appDirectory, 'config.yaml'), 'jsResource:\n  files: resources.js\nrest: true\n');
			await writeFile(
				join(appDirectory, 'package.json'),
				JSON.stringify({ name: 'intrinsics-lockdown-app', type: 'module' })
			);
			await writeFile(join(appDirectory, 'resources.js'), PROBE_SOURCE);
			await setupHarperWithFixture(ctx, appDirectory, {
				config: { threads: { count: 1 }, ...(lockdown && { applications: { lockdown } }) },
			});
		});

		after(async () => {
			try {
				await teardownHarper(ctx);
			} finally {
				if (fixtureParent) await rm(fixtureParent, { recursive: true, force: true });
			}
		});

		test('reports what the component could change at load and after it', async () => {
			expect(await readProbe(ctx));
		});

		if (afterRestart) {
			test('a restarted worker locks its own intrinsics the same way', async () => {
				const before = await readProbe(ctx);
				await operation(ctx, { operation: 'restart_service', service: 'http_workers' });
				expect(await readProbe(ctx, before.threadId));
			});
		}
	});
}

lockdownSuite(
	undefined,
	(probe) => {
		strictEqual(probe.addedAtLoad, true, 'a component may extend an intrinsic while it loads');
		strictEqual(probe.loadTimeVisible, true);
		deepStrictEqual(
			{
				afterLoad: probe.afterLoad,
				visibleOnPlainObject: probe.visibleOnPlainObject,
				shadowedToString: probe.shadowedToString,
				sealed: probe.sealed,
				frozen: probe.frozen,
			},
			SEALED_AFTER_LOAD
		);
	},
	true
);

lockdownSuite('seal', (probe) => {
	strictEqual(probe.addedAtLoad, 'TypeError', 'eager seal applies before the first component evaluates');
	strictEqual(probe.loadTimeVisible, false);
	deepStrictEqual(
		{
			afterLoad: probe.afterLoad,
			visibleOnPlainObject: probe.visibleOnPlainObject,
			shadowedToString: probe.shadowedToString,
			sealed: probe.sealed,
			frozen: probe.frozen,
		},
		SEALED_AFTER_LOAD
	);
});

lockdownSuite('freeze-after-load', (probe) => {
	strictEqual(probe.addedAtLoad, true);
	deepStrictEqual(probe.afterLoad, {
		objectPrototype: 'TypeError',
		arrayPrototype: 'TypeError',
		// freeze modes have never locked Function.prototype
		functionPrototype: true,
		reflectSet: false,
	});
	strictEqual(probe.visibleOnPlainObject, false);
	strictEqual(probe.shadowedToString, true);
	deepStrictEqual(probe.frozen, [true, true, false]);
});

lockdownSuite('none', (probe) => {
	strictEqual(probe.addedAtLoad, true);
	deepStrictEqual(probe.afterLoad, {
		objectPrototype: true,
		arrayPrototype: true,
		functionPrototype: true,
		reflectSet: true,
	});
	strictEqual(probe.visibleOnPlainObject, true);
	deepStrictEqual(probe.sealed, [false, false, false]);
});
