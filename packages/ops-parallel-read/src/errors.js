'use strict';

/**
 * 共享错误类型：带 `code` 的业务错误。
 *
 * 为什么单独一个文件：`OpsError` 同时被路径围栏（paths.js）和主引擎（open/读/超时各闸门）抛出，
 * 而 paths.js 是主引擎的**被依赖方**。若把 `OpsError` 留在主文件里，paths.js 就得反向 require
 * 主文件，形成循环依赖 —— 拆包的第一原则是依赖单向，所以把它下沉到最底层的这个文件。
 * 主文件仍然原样导出 `OpsError`（同一个类引用），对外可见行为不变。
 */

/** 带 error.code 的业务错误，方便上层按 code 分支处理 */
class OpsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'OpsError';
    this.code = code;
  }
}

module.exports = { OpsError };
