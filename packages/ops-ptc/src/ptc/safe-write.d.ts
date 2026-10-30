/** Best-effort optimistic concurrency; does not provide a filesystem compare-and-swap. */
export declare function verifySnapshot(file: string, expected: Buffer): void;
export interface WriteReceipt {
    /** Replacement committed; any remaining cleanup failures must not imply rollback. */
    cleanupErrors: string[];
}
export declare function checkedWrite(file: string, expected: Buffer, after: string): WriteReceipt;
