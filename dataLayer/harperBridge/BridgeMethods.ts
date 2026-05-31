'use strict';

/**
 * BridgeMethods Class provides a framework for all HarperBridge method classes
 */

export class BridgeMethods {
	/** @param {...any} _args */
	createSchema(..._args: any[]): any {
		throw new Error('createSchema bridge method is not defined');
	}

	/** @param {...any} _args */
	dropSchema(..._args: any[]): any {
		throw new Error('dropSchema bridge method is not defined');
	}

	/** @param {...any} _args */
	createTable(..._args: any[]): any {
		throw new Error('createTable bridge method is not defined');
	}

	/** @param {...any} _args */
	dropTable(..._args: any[]): any {
		throw new Error('dropTable bridge method is not defined');
	}

	/** @param {...any} _args */
	createRecords(..._args: any[]): any {
		throw new Error('createRecords bridge method is not defined');
	}

	/** @param {...any} _args */
	updateRecords(..._args: any[]): any {
		throw new Error('updateRecords bridge method is not defined');
	}

	/** @param {...any} _args */
	async upsertRecords(..._args: any[]): Promise<any> {
		throw new Error('upsertRecords bridge method is not defined');
	}

	/** @param {...any} _args */
	deleteRecords(..._args: any[]): any {
		throw new Error('deleteRecords bridge method is not defined');
	}

	/** @param {...any} _args */
	createAttribute(..._args: any[]): any {
		throw new Error('createAttribute bridge method is not defined');
	}

	/** @param {...any} _args */
	dropAttribute(..._args: any[]): any {
		throw new Error('dropAttribute bridge method is not defined');
	}

	/** @param {...any} _args */
	searchByConditions(..._args: any[]): any {
		throw new Error('searchByConditions bridge method is not defined');
	}

	/** @param {...any} _args */
	searchByHash(..._args: any[]): any {
		throw new Error('searchByHash bridge method is not defined');
	}

	/** @param {...any} _args */
	searchByValue(..._args: any[]): any {
		throw new Error('searchByValue bridge method is not defined');
	}

	/** @param {...any} _args */
	getDataByHash(..._args: any[]): any {
		throw new Error('getDataByHash bridge method is not defined');
	}

	/** @param {...any} _args */
	async getDataByValue(..._args: any[]): Promise<any> {
		throw new Error('getDataByValue bridge method is not defined');
	}

	/** @param {...any} _args */
	async deleteRecordsBefore(..._args: any[]): Promise<any> {
		throw new Error('deleteRecordsBefore bridge method is not defined');
	}

	/** @param {...any} _args */
	async deleteAuditLogsBefore(..._args: any[]): Promise<any> {
		throw new Error('deleteAuditLogsBefore bridge method is not defined');
	}

	/** @param {...any} _args */
	async deleteTransactionLogsBefore(..._args: any[]): Promise<any> {
		throw new Error('deleteTransactionLogsBefore bridge method is not defined');
	}

	/** @param {...any} _args */
	async readAuditLog(..._args: any[]): Promise<any> {
		throw new Error('readAuditLog bridge method is not defined');
	}
}
