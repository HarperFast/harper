import { validateLicense } from '../validation/usageLicensing.ts';
import { ClientError } from '../utility/errors/hdbError.js';
import * as harperLogger from '../utility/logging/harper_logger.js';
import { onAnalyticsAggregate } from './analytics/write.ts';
import { UpdatableRecord } from './ResourceInterface.ts';

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

function installUsageLicense(license: string): Promise<void> {
	const validatedLicense = validateLicense(license);
	const { id, ...licenseRecord } = validatedLicense;
	return databases.system.hdb_license.patch(id, licenseRecord);
}

let licenseWarningIntervalId: NodeJS.Timeout;
const LICENSE_NAG_PERIOD = 600000; // ten minutes

interface UsageLicenseRecord {
	id: string;
	level: number;
	region: string;
	expiration: number;
	reads: number;
	readBytes: number;
	writes: number;
	writeBytes: number;
	realTimeMessages: number;
	realTimeBytes: number;
	cpuTime: number;
	usedReads: number;
	usedReadBytes: number;
	usedWrites: number;
	usedWriteBytes: number;
	usedRealTimeMessages: number;
	usedRealTimeBytes: number;
	usedCpuTime: number;
	addTo: (field: string, value: number) => void;
}

onAnalyticsAggregate(async (analytics: any) => {
	let updatableActiveLicense: UpdatableRecord<UsageLicenseRecord>;
	const now = new Date().toISOString();
	const licenseQuery = {
		sort: '__created__',
		conditions: [{ attribute: 'expiration', operator: 'greater_than', value: now }],
	};
	const results = databases.system.hdb_license.search(licenseQuery);
	for await (const license of results) {
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
		updatableActiveLicense = databases.system.hdb_license.update(license.id);
	}
	if (updatableActiveLicense) {
		for (const analyticsRecord of analytics) {
			switch (analyticsRecord.type) {
				case 'db-read':
					updatableActiveLicense.addTo('usedReads', analyticsRecord.count);
					updatableActiveLicense.addTo('usedReadBytes', analyticsRecord.mean * analyticsRecord.count);
					break;
				case 'db-write':
					updatableActiveLicense.addTo('usedWrites', analyticsRecord.count);
					updatableActiveLicense.addTo('usedWriteBytes', analyticsRecord.mean * analyticsRecord.count);
					break;
				case 'db-message':
					updatableActiveLicense.addTo('usedRealTimeMessage', analyticsRecord.count);
					updatableActiveLicense.addTo('usedRealTimeBytes', analyticsRecord.mean * analyticsRecord.count);
					break;
				case 'cpu-usage':
					if (analyticsRecord.path === 'user') {
						updatableActiveLicense.addTo('usedCpuTime', analyticsRecord.mean * analyticsRecord.count);
					}
					break;
			}
		}
	} else {
		if (!process.env.DEV_MODE) {
			// TODO: Adjust the message based on if there are used licenses or not
			const msg =
				'This server does not have valid usage licenses, this should only be used for educational and development purposes.';
			console.error(msg);
			licenseWarningIntervalId = setInterval(() => {
				harperLogger.notify(msg);
			}, LICENSE_NAG_PERIOD).unref();
		}
	}
});

interface GetUsageLicensesReq {
	operation: 'get_usage_licenses';
}

export function getUsageLicensesOp(req: GetUsageLicensesReq): AsyncIterable<UsageLicenseRecord> {
	return getUsageLicenses();
}

function getUsageLicenses(): AsyncIterable<UsageLicenseRecord> {
	return databases.system.hdb_license.search({ sort: { attribute: '__updatedtime__' } });
}
