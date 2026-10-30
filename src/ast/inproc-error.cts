/**
 * 进程内引擎自己的错误类型。
 *
 * 单独成文件的原因：`enumerate.ts` 与 `inproc.ts` 都要抛它，而枚举层是被上层引用的
 * 底模块，反过来依赖 `inproc.ts` 会形成 import 环。类只有 code 一个字段，没有别的职责。
 */
export class InprocError extends Error {
    code: string;
    constructor(code: string, message: string) {
        super(message);
        this.code = code;
        this.name = 'InprocError';
    }
}
