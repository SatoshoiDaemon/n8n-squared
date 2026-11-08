import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const output = resolve(root, process.env.SQUARED_DIST_DIR || 'dist/squarecloud');
const archive = resolve(output, 'squared-squarecloud.zip');
const manifest = resolve(output, 'manifest.json');
if (!existsSync(archive) || !existsSync(manifest)) {
	throw new Error('Package first with npm run package:squarecloud');
}

// An app ID upgrades the existing application. Without it, upload creates one.
const appId = process.env.SQUARED_SQUARECLOUD_APP_ID;
if (
	!appId &&
	!readFileSync(resolve(output, 'app/squarecloud.app'), 'utf8').includes('\nSUBDOMAIN=')
) {
	throw new Error('Set SQUARED_SUBDOMAIN when packaging a new web application');
}
const args = appId
	? ['app', 'commit', appId, '--restart', '--file', archive]
	: ['upload', '--file', archive];
const expected = JSON.parse(readFileSync(manifest, 'utf8'));
const actualHash = createHash('sha256').update(readFileSync(archive)).digest('hex');
if (actualHash !== expected.sha256) throw new Error('Archive SHA-256 does not match manifest');
console.log(`Deploying ${expected.archive} (${expected.sha256})`);
const result = spawnSync('squarecloud', args, { cwd: output, stdio: 'inherit', env: process.env });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`squarecloud exited with status ${result.status}`);
