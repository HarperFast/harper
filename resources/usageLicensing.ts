import { type ValidatedLicense, validateLicense } from '../validation/usageLicensing.ts';
import { ClientError } from '../utility/errors/hdbError.js';
import * as harperLogger from '../utility/logging/harper_logger.js';
import { onAnalyticsAggregate } from './analytics/write.ts';
import { UpdatableRecord } from './ResourceInterface.ts';
import { transaction } from './transaction.ts';
import * as env from '../utility/environment/environmentManager.js';
import * as terms from '../utility/hdbTerms.ts';
import { databases } from './databases.ts';

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

async function installUsageLicense(license: string): Promise<void> {
	const validatedLicense = validateLicense(license);
	const { id } = validatedLicense;
	const existingLicense = await databases.system.hdb_license.get(id);
	if (existingLicense) {
		throw new ExistingLicenseError(`A usage license with ${id} already exists`);
	}
	return databases.system.hdb_license.patch(id, validatedLicense);
}

let licenseConsoleErrorPrinted = false;
let licenseWarningIntervalId: NodeJS.Timeout;
const LICENSE_NAG_PERIOD = 600000; // ten minutes

interface UsageLicense extends ValidatedLicense {
	usedReads: number;
	usedReadBytes: number;
	usedWrites: number;
	usedWriteBytes: number;
	usedRealTimeMessages: number;
	usedRealTimeBytes: number;
	usedCpuTime: number;
}

interface UsageLicenseRecord extends UsageLicense {
	addTo: (field: string, value: number) => void;
}

export async function recordUsage(analytics: any) {
	harperLogger.trace?.('Recording usage into license from analytics');
	let updatableActiveLicense: UpdatableRecord<UsageLicenseRecord>;
	const now = new Date().toISOString();
	const licenseQuery = {
		sort: { attribute: '__updatedtime__' },
		conditions: [{ attribute: 'expiration', comparator: 'greater_than', value: now }],
	};
	const region = env.get(terms.CONFIG_PARAMS.LICENSE_REGION);
	if (region !== undefined) {
		licenseQuery.conditions.push({ attribute: 'region', comparator: 'equals', value: region });
	} else {
		harperLogger.warn?.('No region specified for usage license, selecting any valid license');
	}
	const results = databases.system.hdb_license.search(licenseQuery);
	let activeLicenseId: string;
	for await (const license of results) {
		harperLogger.trace?.('Checking usage license:', license);
		if (
			license.usedReads >= license.reads ||
			license.usedReadBytes >= license.readBytes ||
			license.usedWrites >= license.writes ||
			license.usedWriteBytes >= license.writeBytes ||
			license.usedRealTimeMessages >= license.realTimeMessages ||
			license.usedRealTimeBytes >= license.realTimeBytes ||
			license.usedCpuTime >= license.cpuTime
		)
			continue;
		activeLicenseId = license.id;
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

interface GetUsageLicensesReq {
	operation: 'get_usage_licenses';
}

export function getUsageLicensesOp(req: GetUsageLicensesReq): AsyncIterable<UsageLicenseRecord> {
	return getUsageLicenses();
}

function getUsageLicenses(): AsyncIterable<UsageLicenseRecord> {
	return databases.system.hdb_license.search({ sort: { attribute: '__updatedtime__' } });
}
