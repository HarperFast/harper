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
onAnalyticsAggregate((analytics) => {
	let updatableActiveLicense: UpdatableRecord;
	const now = new Date().toISOString();
	const licenseQuery = {
		sort: '__created__',
		conditions: [{ attribute: 'expiration', operator: 'greater_than', value: now }],
	};
	for (const license of databases.system.hdb_license.search(licenseQuery)) {
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
			console.error(
				'This server does not have valid usage licenses, this should only be used for educational and development purposes.`;'
			);
			licenseWarningIntervalId = setInterval(() => {
				harperLogger.notify(
					'This server does not have valid usage licenses, this should only be used for educational and development purposes.`;'
				);
			}, LICENSE_NAG_PERIOD).unref();
		}
	}
});
