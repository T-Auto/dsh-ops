/** Resolve the AST engine from the installed dsh-ops dependency tree. */
import { createRequire } from 'node:module';

export type NapiModule = typeof import('@ast-grep/napi');
const requireFromHere = createRequire(__filename);
let loaded: NapiModule | undefined;
export function load(): NapiModule {
    return loaded ??= requireFromHere('@ast-grep/napi') as NapiModule;
}

export const napi = new Proxy({} as NapiModule, {
    get(_target, key) {
        const mod = load();
        const value = (mod as unknown as Record<string | symbol, unknown>)[key];
        return typeof value === 'function' ? value.bind(mod) : value;
    },
    has(_target, key) {
        return key in load();
    },
});
