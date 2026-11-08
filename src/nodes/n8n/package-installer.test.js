import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureN8nPackages, OFFICIAL_N8N_PACKAGES } from './package-installer.ts';

test('pins official n8n packages and preserves existing package dependencies', async () => {
	const temporary = await mkdtemp(join(tmpdir(), 'squared-n8n-installer-'));
	try {
		const installPrefix = join(temporary, 'n8n-runtime');
		const packagesDirectory = join(installPrefix, 'node_modules');
		await mkdir(installPrefix, { recursive: true });
		await writeFile(join(installPrefix, 'package.json'), JSON.stringify({ name: 'existing-runtime', dependencies: { 'community-node': '^1.0.0' } }));
		let installedAt = '';
		const result = await ensureN8nPackages(packagesDirectory, {
			runInstall: async (prefix) => {
				installedAt = prefix;
				for (const [name, version] of Object.entries({ ...OFFICIAL_N8N_PACKAGES, 'n8n-workflow': '2.42.4' })) {
					const packageDirectory = join(packagesDirectory, ...name.split('/'));
					await mkdir(packageDirectory, { recursive: true });
					await writeFile(join(packageDirectory, 'package.json'), JSON.stringify({ name, version }));
				}
			},
		});
		assert.equal(result.installed, true);
		assert.equal(installedAt, installPrefix);
		const manifest = JSON.parse(await readFile(join(installPrefix, 'package.json'), 'utf8'));
		assert.equal(manifest.dependencies['community-node'], '^1.0.0');
		assert.deepEqual(manifest.dependencies, { 'community-node': '^1.0.0', ...OFFICIAL_N8N_PACKAGES });
		const existing = await ensureN8nPackages(packagesDirectory, {
			runInstall: async () => assert.fail('complete pinned install should be reused'),
		});
		assert.equal(existing.installed, false);
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
});

test('extracts the deploy seed into persistent storage before falling back to npm', async () => {
	const temporary = await mkdtemp(join(tmpdir(), 'squared-n8n-seed-'));
	try {
		const installPrefix = join(temporary, 'persistent', 'n8n-runtime');
		const packagesDirectory = join(installPrefix, 'node_modules');
		const seedArchivePath = join(temporary, 'vendor', 'n8n-runtime.tar.br');
		await mkdir(join(temporary, 'vendor'), { recursive: true });
		await writeFile(seedArchivePath, 'fixture archive');
		let extractedFrom = '';
		const result = await ensureN8nPackages(packagesDirectory, {
			seedArchivePath,
			runSeedExtract: async (archive, prefix) => {
				extractedFrom = archive;
				for (const [name, version] of Object.entries({ ...OFFICIAL_N8N_PACKAGES, 'n8n-workflow': '2.42.4' })) {
					const packageDirectory = join(prefix, 'node_modules', ...name.split('/'));
					await mkdir(packageDirectory, { recursive: true });
					await writeFile(join(packageDirectory, 'package.json'), JSON.stringify({ name, version }));
				}
			},
			runInstall: async () => assert.fail('the bundled seed should avoid npm install'),
		});
		assert.equal(result.installed, true);
		assert.equal(extractedFrom, seedArchivePath);
		assert.equal(await readFile(seedArchivePath).then(() => true, () => false), false);
		assert.equal(JSON.parse(await readFile(join(packagesDirectory, 'n8n-nodes-base', 'package.json'), 'utf8')).version, '2.42.5');
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
});
