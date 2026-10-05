export interface LocalOperationDispatch {
	chooseOperation: (body: any, bypassAuth?: boolean) => Function;
	processLocalTransaction: (req: any, operationFunction: Function) => Promise<any>;
}

export const operationDispatchState: { local?: LocalOperationDispatch } = {};
