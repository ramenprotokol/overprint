#!/usr/bin/env node
// Build dist/ from a clean clone:
//   1. compile the Rust core to wasm32-unknown-unknown (release)
//   2. generate the JS bindings with wasm-bindgen (--target web)
//   3. shrink with wasm-opt if it is installed (optional)
//   4. copy the static site from web/
//   5. write THIRD-PARTY-NOTICES.txt for the code that ships (scripts/notices.mjs)
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeNotices } from './notices.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const pkg = join(dist, 'pkg');

function has(cmd) {
  return spawnSync(cmd, ['--version'], { stdio: 'ignore' }).status === 0;
}
function run(cmd, args) {
  console.log(`$ ${cmd} ${args.map((a) => a.replace(root + '/', '')).join(' ')}`);
  execFileSync(cmd, args, { cwd: root, stdio: 'inherit' });
}
function fail(msg) {
  console.error(`\nbuild failed: ${msg}`);
  process.exit(1);
}

if (!has('cargo')) fail('cargo not found. Install Rust (rustup) and add it to PATH.');
if (!has('wasm-bindgen')) fail('wasm-bindgen not found. Run: cargo install --locked wasm-bindgen-cli --version 0.2.129');

const cargoToml = readFileSync(join(root, 'Cargo.toml'), 'utf8');
const want = /wasm-bindgen = "=([\d.]+)"/.exec(cargoToml)?.[1];
const cli = spawnSync('wasm-bindgen', ['--version'], { encoding: 'utf8' }).stdout.trim().split(' ').pop();
if (want && cli !== want) fail(`wasm-bindgen CLI is ${cli} but Cargo.toml pins ${want}. They must match.`);

rmSync(dist, { recursive: true, force: true });
mkdirSync(pkg, { recursive: true });

run('cargo', ['build', '--locked', '--release', '--target', 'wasm32-unknown-unknown']);
const wasmIn = join(root, 'target', 'wasm32-unknown-unknown', 'release', 'overprint.wasm');
run('wasm-bindgen', [wasmIn, '--target', 'web', '--out-dir', pkg, '--no-typescript']);

const wasmOut = join(pkg, 'overprint_bg.wasm');
if (has('wasm-opt')) {
  run('wasm-opt', ['-O3', '--all-features', wasmOut, '-o', wasmOut]);
} else {
  console.log('wasm-opt not found: skipping the optional size pass.');
}

cpSync(join(root, 'web'), dist, { recursive: true });
if (!existsSync(join(dist, 'index.html'))) fail('web/index.html missing');

try {
  writeNotices(root, dist);
} catch (err) {
  fail(err.message);
}
console.log('wrote dist/THIRD-PARTY-NOTICES.txt');

console.log(`\ndist/ ready. overprint_bg.wasm is ${(statSync(wasmOut).size / 1024).toFixed(1)} KiB.`);
