export interface LocalOperationDispatch {
	chooseOperation: (body: any, bypassAuth?: boolean, forwarded?: boolean) => Function;
	processLocalTransaction: (req: any, operationFunction: Function) => Promise<any>;
}

export const operationDispatchState: { local?: LocalOperationDispatch } = {};
