"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifySnapshot = verifySnapshot;
exports.checkedWrite = checkedWrite;
const node_fs_1 = require("node:fs");
const node_crypto_1 = require("node:crypto");
function verifySnapshot(file, expected) {
    const st = (0, node_fs_1.lstatSync)(file);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink > 1) {
        throw Object.assign(new Error(`拒绝替换非普通文件或硬链接: ${file}`), { code: 'E_INPROC_FILE_TYPE' });
    }
    if (!(0, node_fs_1.readFileSync)(file).equals(expected)) {
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
function assertResolved(file, after) {
    if (PLACEHOLDER_LEAK.test(after)) {
        throw Object.assign(new Error(`改写结果残留未解析的 ast-grep 占位符（$$$）: ${file}`), { code: 'E_INPROC_UNRESOLVED_PLACEHOLDER' });
    }
}
function checkedWrite(file, expected, after) {
    assertResolved(file, after);
    const lock = `${file}.ops-ptc.lock`;
    const tmp = `${file}.inproc-${(0, node_crypto_1.randomUUID)()}.tmp`;
    let lockFd;
    let tmpFd;
    let ownsTemp = false;
    let failure;
    const cleanupErrors = [];
    const cleanup = (action) => {
        try {
            action();
        }
        catch (e) {
            const error = e;
            cleanupErrors.push(`${error.code ?? 'E_CLEANUP'}: ${error.message ?? String(e)}`);
        }
    };
    try {
        lockFd = (0, node_fs_1.openSync)(lock, 'wx', 0o600);
        verifySnapshot(file, expected);
        const mode = (0, node_fs_1.lstatSync)(file).mode & 0o777;
        tmpFd = (0, node_fs_1.openSync)(tmp, 'wx', mode);
        ownsTemp = true;
        (0, node_fs_1.writeFileSync)(tmpFd, after, 'utf8');
        (0, node_fs_1.closeSync)(tmpFd);
        tmpFd = undefined;
        (0, node_fs_1.chmodSync)(tmp, mode);
        verifySnapshot(file, expected);
        (0, node_fs_1.renameSync)(tmp, file);
        ownsTemp = false;
    }
    catch (e) {
        const error = e;
        failure = lockFd === undefined && error.code === 'EEXIST'
            ? Object.assign(new Error(`另一个 ops-ptc 写入占用文件: ${file}`), { code: 'E_INPROC_LOCKED' })
            : e;
        throw failure;
    }
    finally {
        if (tmpFd !== undefined)
            cleanup(() => (0, node_fs_1.closeSync)(tmpFd));
        if (ownsTemp)
            cleanup(() => (0, node_fs_1.unlinkSync)(tmp));
        if (lockFd !== undefined) {
            cleanup(() => (0, node_fs_1.closeSync)(lockFd));
            cleanup(() => (0, node_fs_1.unlinkSync)(lock));
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
