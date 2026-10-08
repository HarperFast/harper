/**
 * Shared by the minor-version upgrade and rollback suites: which previous-minor installs to run
 * against, and the tables both suites seed on the previous minor.
 *
 * HARPER_PREVIOUS_MINOR_PATH is one install root (the directory holding `package.json` and
 * `dist/bin/harper.js`), or several joined with the platform path delimiter (`:` on Linux); each
 * root gets its own suites, named by its `package.json` version. Unset, every suite skips.
 *
 *   mkdir -p ~/dev/tmp/prev-minor && cd ~/dev/tmp/prev-minor
 *   npm install --ignore-scripts --prefix 5.2 harper@5.2.15
 *   npm install --ignore-scripts --prefix 5.3 harper@5.3.1
 *   HARPER_PREVIOUS_MINOR_PATH=$PWD/5.2/node_modules/harper:$PWD/5.3/node_modules/harper \
 *     npm run test:integration -- "integrationTests/upgrade/minor-*.test.ts"
 */
import { readFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { sendOperation, type HarperContext } from '@harperfast/integration-testing';

interface PreviousMinorInstall {
	version: string;
	binPath: string;
}

function readVersion(root: string): string {
	return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
}

export const previousMinorInstalls: PreviousMinorInstall[] = (process.env.HARPER_PREVIOUS_MINOR_PATH ?? '')
	.split(delimiter)
	.filter(Boolean)
	.map((root) => ({ version: readVersion(root), binPath: join(root, 'dist', 'bin', 'harper.js') }));

export const CURRENT_VERSION = readVersion(resolve(import.meta.dirname, '../..'));

export const NO_PREVIOUS_MINOR = 'HARPER_PREVIOUS_MINOR_PATH is not set';

// The uWS HTTP job never sets HARPER_PREVIOUS_MINOR_PATH: registry installs carry no uWebSockets.js.
export const skipCrossVersion = process.env.HARPER_RUNTIME === 'bun' || process.platform === 'win32';

export const FIRST_BOOT_ENV = { TC_AGREEMENT: 'yes', REPLICATION_HOSTNAME: 'localhost' };

type Thing = {
	id: string;
	label: string;
	count: number;
	extra?: string;
};

type Widget = {
	id: string;
	name: string;
	category: string;
	price: number;
	inStock: boolean;
	tags: string[];
};

type AuditSubject = {
	id: string;
	value: string;
};

const WIDGET_COUNT = 40;
const THING_COUNT = 15;
const OVERWRITTEN_THING_COUNT = 5;
const AUDIT_SUBJECT_COUNT = 5;

export function buildWidget(i: number): Widget {
	return {
		id: `w-${i}`,
		name: `widget-${i}`,
		category: i % 3 === 0 ? 'A' : i % 3 === 1 ? 'B' : 'C',
		price: Number((9.99 + i).toFixed(2)),
		inStock: i % 2 === 0,
		tags: [`tag${i % 5}`, `bucket${i % 4}`],
	};
}

export const buildWidgets = (): Widget[] => Array.from({ length: WIDGET_COUNT }, (_, i) => buildWidget(i));

export function seededThings(): Thing[] {
	return Array.from({ length: THING_COUNT }, (_, i) =>
		i < OVERWRITTEN_THING_COUNT
			? { id: `t-${i}`, label: `thing-${i}-v2`, count: i * 3 + 100 }
			: { id: `t-${i}`, label: `thing-${i}`, count: i * 3 }
	);
}

export function seededAuditSubjects(): AuditSubject[] {
	return Array.from({ length: AUDIT_SUBJECT_COUNT }, (_, i) => ({
		id: `a-${i}`,
		value: i === 0 ? 'updated-val-0' : `val-${i}`,
	}));
}

export const SEEDED_AUDIT_IDS = [...seededAuditSubjects().map(({ id }) => id), 'a-0'];

export async function seedWidgets(harper: HarperContext, widgets: Widget[]): Promise<void> {
	await sendOperation(harper, {
		operation: 'create_table',
		table: 'widgets',
		primary_key: 'id',
		attributes: [
			{ name: 'id', type: 'ID' },
			{ name: 'name', type: 'String', indexed: true },
			{ name: 'category', type: 'String', indexed: true },
			{ name: 'price', type: 'Float' },
			{ name: 'inStock', type: 'Boolean' },
			{ name: 'tags', type: 'Any' },
		],
	});
	for (const widget of widgets) {
		await sendOperation(harper, { operation: 'upsert', table: 'widgets', records: [widget] });
	}
}

/**
 * Plain (`things`, with overwrites), indexed (`widgets`) and audited (`audit_subject`) tables, one
 * upsert per operation so every write is its own transaction and audit entry. Audit is on by
 * default for every v5 table.
 */
export async function seedMinorFixtures(harper: HarperContext): Promise<void> {
	await sendOperation(harper, {
		operation: 'create_table',
		table: 'things',
		primary_key: 'id',
		attributes: [
			{ name: 'id', type: 'ID' },
			{ name: 'label', type: 'String' },
			{ name: 'count', type: 'Integer' },
		],
	});
	for (let i = 0; i < THING_COUNT; i++) {
		await sendOperation(harper, {
			operation: 'upsert',
			table: 'things',
			records: [{ id: `t-${i}`, label: `thing-${i}`, count: i * 3 }],
		});
	}
	for (const thing of seededThings().slice(0, OVERWRITTEN_THING_COUNT)) {
		await sendOperation(harper, { operation: 'upsert', table: 'things', records: [thing] });
	}

	await seedWidgets(harper, buildWidgets());

	await sendOperation(harper, {
		operation: 'create_table',
		table: 'audit_subject',
		primary_key: 'id',
		attributes: [
			{ name: 'id', type: 'ID' },
			{ name: 'value', type: 'String' },
		],
	});
	for (let i = 0; i < AUDIT_SUBJECT_COUNT; i++) {
		await sendOperation(harper, {
			operation: 'upsert',
			table: 'audit_subject',
			records: [{ id: `a-${i}`, value: `val-${i}` }],
		});
	}
	await sendOperation(harper, {
		operation: 'upsert',
		table: 'audit_subject',
		records: [seededAuditSubjects()[0]],
	});
}
