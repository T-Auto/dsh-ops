"use strict";
/**
 * `@ast-grep/napi` 的双锚点惰性解析。
 *
 * 这个包是可选 peer，不是 `dsh-ops` 的声明依赖（`dependencies` 是 `null`）。一旦有人在包目录里
 * 跑 `pnpm install` / 重装，`dsh-ops/node_modules` 会被清掉，五个 `ops_ptc_*` 就一起变成
 * `EXECUTOR_UNAVAILABLE` —— 而包本身还在盘上。
 *
 * 所以解析走两条锚点：先 nested `node_modules`，再随包分发的 `vendor/deps`。第二条是 15 MB
 * 的 win32-x64 副本，运行期零成本，但让「依赖被清」从功能失效降级成「什么也没发生」。
 *
 * 导出的 `napi` 是个 Proxy：调用点写 `napi_1.parse(...)` 一个字都不用改，而解析推迟到第一次
 * 真正调用，启动期不再把原生 `.node` 拉进进程。
 */
const path = require("node:path");
const { createRequire } = require("node:module");

const ANCHORS = [
    path.join(__dirname, "..", "..", "package.json"),
    path.join(__dirname, "..", "..", "vendor", "deps", "package.json"),
];

let loaded;
function load() {
    if (loaded !== undefined)
        return loaded;
    let last;
    for (const anchor of ANCHORS) {
        try {
            loaded = createRequire(anchor)("@ast-grep/napi");
            return loaded;
        }
        catch (error) {
            last = error;
        }
    }
    throw last;
}

const napi = new Proxy({}, {
    get(_target, key) {
        const mod = load();
        const value = mod[key];
        return typeof value === "function" ? value.bind(mod) : value;
    },
    has(_target, key) {
        return key in load();
    },
});

module.exports = { load, napi, ANCHORS };
