import { type ValidatedLicense, validateLicense } from '../validation/usageLicensing.ts';
import { ClientError } from '../utility/errors/hdbError.js';
import * as harperLogger from '../utility/logging/harper_logger.js';
import { onAnalyticsAggregate } from './analytics/write.ts';
import { UpdatableRecord } from './ResourceInterface.ts';
import { transaction } from './transaction.ts';
import * as env from '../utility/environment/environmentManager.js';
import * as terms from '../utility/hdbTerms.ts';
import { databases } from './databases.ts';
import path from 'node:path';
import * as configUtils from '../config/configUtils.js';
import * as fs from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { watch } from 'chokidar';

class ExistingLicenseError extends Error {}

interface InstallLicenseRequest {
	operation: 'install_usage_license';
	license: string;
}

export async function installUsageLicenseOp(req: InstallLicenseRequest): Promise<string> {
	const license = req.license;
	try {
		await installUsageLicense(license);
	} catch (cause) {
		const error = new ClientError('Failed to install usage license; ' + cause.message);
		error.cause = cause;
		throw error;
	}
	return 'Successfully installed usage license';
}

export async function installUsageLicense(license: string): Promise<void> {
	const validatedLicense = validateLicense(license);
	const { id } = validatedLicense;
	const existingLicense = await databases.system.hdb_license.get(id);
	if (existingLicense) {
		throw new ExistingLicenseError(`A usage license with ${id} already exists`);
	}
	harperLogger.info?.('Installing usage license:', validatedLicense);
	return databases.system.hdb_license.put(id, validatedLicense);
}

let licenseConsoleErrorPrinted = false;
let licenseWarningIntervalId: NodeJS.Timeout;
const LICENSE_NAG_PERIOD = 600000; // ten minutes

interface UsageLicense extends ValidatedLicense {
	usedReads?: number;
	usedReadBytes?: number;
	usedWrites?: number;
	usedWriteBytes?: number;
	usedRealTimeMessages?: number;
	usedRealTimeBytes?: number;
	usedCpuTime?: number;
	usedStorage?: number;
}

interface UsageLicenseRecord extends UsageLicense {
	addTo: (field: string, value: number) => void;
}

export function isActiveLicense(license: UsageLicense): boolean {
	return (
		((license.usedReads ?? 0) < license.reads &&
			(license.usedReadBytes ?? 0) < license.readBytes &&
			(license.usedWrites ?? 0) < license.writes &&
			(license.usedWriteBytes ?? 0) < license.writeBytes &&
			(license.usedRealTimeMessages ?? 0) < license.realTimeMessages &&
			(license.usedRealTimeBytes ?? 0) < license.realTimeBytes &&
			(license.usedCpuTime ?? 0) < license.cpuTime &&
			(license.usedStorage ?? 0) < license.storage) ||
		// check for unlimited license
		(license.reads === -1 &&
			license.readBytes === -1 &&
			license.writes === -1 &&
			license.writeBytes === -1 &&
			license.realTimeMessages === -1 &&
			license.realTimeBytes === -1 &&
			license.cpuTime === -1 &&
			license.storage === -1)
	);
}

export async function recordUsage(analytics: any) {
	harperLogger.trace?.('Recording usage into license from analytics');
	let updatableActiveLicense: UpdatableRecord<UsageLicenseRecord>;
	const now = new Date().toISOString();
	const licenseQuery = {
		sort: { attribute: '__createdtime__' },
		conditions: [{ attribute: 'expiration', comparator: 'greater_than', value: now }],
	};
	const region = env.get(terms.CONFIG_PARAMS.LICENSE_REGION);
	if (region !== undefined) {
		licenseQuery.conditions.push({ attribute: 'region', comparator: 'equals', value: region });
	} else {
		harperLogger.warn?.('No region specified for usage license, selecting any valid license');
	}
	const results = databases.system.hdb_license?.search(licenseQuery);
	let activeLicenseId: string;
	for await (const license of results) {
		if (isActiveLicense(license)) {
			activeLicenseId = license.id;
			break;
		}
	}
	if (activeLicenseId) {
		harperLogger.trace?.('Found license to record usage into:', activeLicenseId);
		const context = {};
		transaction(context, () => {
			updatableActiveLicense = databases.system.hdb_license.update(activeLicenseId, context);
			for (const analyticsRecord of analytics) {
				harperLogger.trace?.('Processing analytics record:', analyticsRecord);
				switch (analyticsRecord.metric) {
					case 'db-read':
						harperLogger.trace?.('Recording read usage into license');
						updatableActiveLicense.addTo('usedReads', analyticsRecord.count);
						updatableActiveLicense.addTo('usedReadBytes', analyticsRecord.mean * analyticsRecord.count);
						break;
					case 'db-write':
						harperLogger.trace?.('Recording write usage into license');
						updatableActiveLicense.addTo('usedWrites', analyticsRecord.count);
						updatableActiveLicense.addTo('usedWriteBytes', analyticsRecord.mean * analyticsRecord.count);
						break;
					case 'db-message':
						harperLogger.trace?.('Recording message usage into license');
						updatableActiveLicense.addTo('usedRealTimeMessages', analyticsRecord.count);
						updatableActiveLicense.addTo('usedRealTimeBytes', analyticsRecord.mean * analyticsRecord.count);
						break;
					case 'cpu-usage':
						if (analyticsRecord.path === 'user') {
							harperLogger.trace?.('Recording CPU usage into license');
							updatableActiveLicense.addTo('usedCpuTime', analyticsRecord.mean * analyticsRecord.count);
						}
						break;
					default:
						harperLogger.trace?.('Skipping metric:', analyticsRecord.metric);
				}
			}
		});
	} else if (!process.env.DEV_MODE) {
		// TODO: Adjust the message based on if there are used licenses or not
		const msg =
			'This server does not have valid usage licenses, this should only be used for educational and development purposes.';
		if (!licenseConsoleErrorPrinted) {
			console.error(msg);
			licenseConsoleErrorPrinted = true;
		}
		if (licenseWarningIntervalId === undefined) {
			licenseWarningIntervalId = setInterval(() => {
				harperLogger.notify(msg);
			}, LICENSE_NAG_PERIOD).unref();
		}
	}
}

onAnalyticsAggregate(recordUsage);

interface GetUsageLicenseParams {
	region?: string;
}

interface GetUsageLicensesReq extends GetUsageLicenseParams {
	operation: 'get_usage_licenses';
}

export function getUsageLicensesOp(req: GetUsageLicensesReq): AsyncIterable<UsageLicenseRecord> {
	const params: GetUsageLicenseParams = {};
	if (req.region) {
		params.region = req.region;
	}
	return getUsageLicenses(params);
}

export function getUsageLicenses(params?: GetUsageLicenseParams): AsyncIterable<UsageLicenseRecord> {
	const conditions = [];
	const attrs = typeof params === 'object' ? Object.keys(params) : [];
	if (attrs.length > 0) {
		attrs.forEach((attribute) => {
			conditions.push({ attribute, comparator: 'equals', value: params[attribute] });
		});
	}
	return databases.system.hdb_license.search({
		sort: { attribute: '__createdtime__' },
		conditions,
	});
}

async function loadLicenseFile(path: string) {
	harperLogger.trace?.('Loading usage license from file:', path);
	const encodedLicense = await fs.readFile(path, {encoding: 'utf-8'});
	try {
		await installUsageLicense(encodedLicense);
	} catch (err) {
		harperLogger.error?.('Failed to install usage license from file:', path, err);
	}
}

export async function loadAndWatchLicensesDir() {
	const licensesPath = path.dirname(configUtils.getConfigFilePath()) + '/licenses';
	// chokidar w/ ignoreInitial: false emits add events on watch creation for existing files
	const watchOptions = {
		persistent: false,
		ignoreInitial: false,
		depth: 0,
		ignored: (file: string, stats: Stats) => stats?.isFile() && !file.endsWith('.txt')};
	watch(licensesPath, watchOptions).on('add', loadLicenseFile);
}
