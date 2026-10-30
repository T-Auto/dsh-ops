import {
    chmodSync,
    closeSync,
    lstatSync,
    openSync,
    readFileSync,
    renameSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';

/** Best-effort optimistic concurrency; does not provide a filesystem compare-and-swap. */
export function verifySnapshot(file: string, expected: Buffer): void {
    const st = lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink > 1) {
        throw Object.assign(new Error(`拒绝替换非普通文件或硬链接: ${file}`), { code: 'E_INPROC_FILE_TYPE' });
    }
    if (!readFileSync(file).equals(expected)) {
        throw Object.assign(new Error(`文件在审计期间发生变化: ${file}`), { code: 'E_INPROC_CHANGED' });
    }
}

/**
 * ast-grep 模板占位符落到标识符位，说明 rewrite 没被解析就把整段原文写回去了。
 *
 * 这个闸门是事后补的：`proc.js` 的七个函数曾被这样改成 `function safeStr($$$) { try {`
 * 并压成单行，`async` 一起丢了，模块直接加载失败。占位符只可能出现在字符串字面量里
 * （pattern 数组），一旦出现在声明名或参数位就是污染，与任何合法源码都不重叠。
 */
const PLACEHOLDER_LEAK = /function\s+\$\$\$|class\s+\$\$\$|=>\s*\$\$\$|\(\s*\$\$\$\s*[,)]|(?:const|let|var)\s+\$\$\$\s*=/;

function assertResolved(file: string, after: string): void {
    if (PLACEHOLDER_LEAK.test(after)) {
        throw Object.assign(new Error(`改写结果残留未解析的 ast-grep 占位符（$$$）: ${file}`), { code: 'E_INPROC_UNRESOLVED_PLACEHOLDER' });
    }
}

export interface WriteReceipt {
    /** Replacement committed; any remaining cleanup failures must not imply rollback. */
    cleanupErrors: string[];
}

export function checkedWrite(file: string, expected: Buffer, after: string): WriteReceipt {
    assertResolved(file, after);
    const lock = `${file}.ops-ast.lock`;
    const tmp = `${file}.inproc-${randomUUID()}.tmp`;
    let lockFd: number | undefined;
    let tmpFd: number | undefined;
    let ownsTemp = false;
    let failure: unknown;
    const cleanupErrors: string[] = [];
    const cleanup = (action: () => void) => {
        try {
            action();
        }
        catch (e) {
            const error = e as NodeJS.ErrnoException;
            cleanupErrors.push(`${error.code ?? 'E_CLEANUP'}: ${error.message ?? String(e)}`);
        }
    };
    try {
        lockFd = openSync(lock, 'wx', 0o600);
        verifySnapshot(file, expected);
        const mode = lstatSync(file).mode & 0o777;
        tmpFd = openSync(tmp, 'wx', mode);
        ownsTemp = true;
        writeFileSync(tmpFd, after, 'utf8');
        closeSync(tmpFd);
        tmpFd = undefined;
        chmodSync(tmp, mode);
        verifySnapshot(file, expected);
        renameSync(tmp, file);
        ownsTemp = false;
    }
    catch (e) {
        const error = e as NodeJS.ErrnoException;
        failure = lockFd === undefined && error.code === 'EEXIST'
            ? Object.assign(new Error(`另一个 ops-ast 写入占用文件: ${file}`), { code: 'E_INPROC_LOCKED' })
            : e;
        throw failure;
    }
    finally {
        if (tmpFd !== undefined) {
            const fd = tmpFd;
            cleanup(() => closeSync(fd));
        }
        if (ownsTemp)
            cleanup(() => unlinkSync(tmp));
        if (lockFd !== undefined) {
            const fd = lockFd;
            cleanup(() => closeSync(fd));
            cleanup(() => unlinkSync(lock));
        }
        if (failure && typeof failure === 'object' && cleanupErrors.length) {
            try {
                Object.assign(failure, { cleanupErrors });
            }
            catch { }
        }
    }
    return { cleanupErrors };
}
