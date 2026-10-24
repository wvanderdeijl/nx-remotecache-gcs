import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const importedYargs = require('yargs');
const yargs = importedYargs.default ?? importedYargs;
const source = readFileSync(new URL('../adapter.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
    compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
    },
    reportDiagnostics: true,
});
assert.equal(
    compiled.diagnostics?.length ?? 0,
    0,
    'adapter must transpile without diagnostics',
);
const fixed = compiled.outputText;
function launch(source, value) {
    let storageCount = 0,
        listenCount = 0;
    const app = {
        use() {
            return this;
        },
        head() {
            return this;
        },
        get() {
            return this;
        },
        put() {
            return this;
        },
        listen() {
            listenCount++;
            return this;
        },
    };
    const args = ['--bucket', 'synthetic-only', '--concurrency', String(value)];
    const mods = {
        express: () => app,
        '@google-cloud/storage': {
            Storage: class {
                constructor() {
                    storageCount++;
                }
            },
        },
        yargs: () =>
            yargs(args)
                .exitProcess(false)
                .showHelpOnFail(false)
                .fail((msg, err) => {
                    throw err || new Error(msg);
                }),
        'yargs/helpers': { hideBin: () => args },
        'node:stream/promises': {},
    };
    const ctx = vm.createContext({
        exports: {},
        require: (name) => {
            assert.ok(Object.hasOwn(mods, name));
            return mods[name];
        },
        process: { argv: [], env: {} },
        console: { log() {}, warn() {}, error() {} },
        AbortSignal,
        Date,
    });
    let error = null;
    try {
        vm.runInContext(source, ctx, { filename: 'adapter-cli.cjs' });
    } catch (e) {
        error = e;
    }
    return { storageCount, listenCount, error };
}
for (const value of [0, -1, 0.5, NaN, Infinity, 9007199254740992])
    test(`invalid concurrency ${value} refuses before storage/listener`, () => {
        const r = launch(fixed, value);
        assert.match(r.error?.message ?? '', /positive safe integer/);
        assert.equal(r.storageCount, 0);
        assert.equal(r.listenCount, 0);
    });
for (const value of [1, 16, 9007199254740991])
    test(`valid concurrency ${value} preserves startup`, () => {
        const r = launch(fixed, value);
        assert.equal(r.error, null);
        assert.equal(r.storageCount, 1);
        assert.equal(r.listenCount, 1);
    });
