'use strict';
import * as terms from '../utility/hdbTerms.ts';

export class UpgradeObject {
	[key: string]: any;
	constructor(dataVersion, upgradeVersion) {
		this[terms.UPGRADE_JSON_FIELD_NAMES_ENUM.DATA_VERSION] = dataVersion;
		this[terms.UPGRADE_JSON_FIELD_NAMES_ENUM.UPGRADE_VERSION] = upgradeVersion;
	}
}
