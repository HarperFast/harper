import { withUpdateAttributesLock } from '../../dist/resources/Table.js';

declare const rootStore: Parameters<typeof withUpdateAttributesLock>[0];

withUpdateAttributesLock(rootStore, "table 'test.Sync'", () => 42);

// @ts-expect-error the lock callback must finish before the synchronous lock is released
withUpdateAttributesLock(rootStore, "table 'test.Async'", async () => 42);
