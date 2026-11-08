import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createBrotliDecompress } from 'node:zlib';

export const OFFICIAL_N8N_PACKAGES = Object.freeze({
	'n8n-nodes-base': '2.42.5',
	'@n8n/n8n-nodes-langchain': '2.42.5',
	'n8n-core': '2.42.5',
	'@n8n/backend-common': '1.42.5',
});

const REQUIRED_RUNTIME_PACKAGES = Object.freeze({
	...OFFICIAL_N8N_PACKAGES,
	'n8n-workflow': '2.42.4',
});

/**
 * Keep the pinned official n8n packages beside Squared's persistent data. The
 * package directory is intentionally outside the deployment archive so an
 * application restart or code redeploy does not erase the installed runtime.
 */
export async function ensureN8nPackages(packagesDirectory: string, options: {
	env?: NodeJS.ProcessEnv;
	seedArchivePath?: string;
	lockfilePath?: string;
	runSeedExtract?: (archivePath: string, prefix: string) => Promise<void>;
	runInstall?: (prefix: string, env: NodeJS.ProcessEnv, useLockfile: boolean) => Promise<void>;
} = {}): Promise<{ installed: boolean; packages: string[]; packagesDirectory: string }> {
	const env = options.env ?? process.env;
	const modulesDirectory = resolve(packagesDirectory);
	const installPrefix = dirname(modulesDirectory);
	await mkdir(installPrefix, { recursive: true });

	if (await hasRequiredPackages(modulesDirectory)) {
		if (options.seedArchivePath) await rm(options.seedArchivePath, { force: true });
		return { installed: false, packages: Object.keys(OFFICIAL_N8N_PACKAGES), packagesDirectory: modulesDirectory };
	}
	if (options.seedArchivePath && await fileExists(options.seedArchivePath)) {
		const extract = options.runSeedExtract ?? extractRuntimeSeed;
		await extract(options.seedArchivePath, installPrefix);
		if (!(await hasRequiredPackages(modulesDirectory))) {
			throw new Error('The bundled n8n runtime package seed is incomplete or has incompatible versions');
		}
		await rm(options.seedArchivePath, { force: true });
		return { installed: true, packages: Object.keys(OFFICIAL_N8N_PACKAGES), packagesDirectory: modulesDirectory };
	}

	const manifestPath = join(installPrefix, 'package.json');
	const manifest = await readJson(manifestPath) ?? { name: 'squared-n8n-runtime', private: true };
	manifest.name = typeof manifest.name === 'string' ? manifest.name : 'squared-n8n-runtime';
	manifest.private = true;
	manifest.dependencies = { ...(manifest.dependencies ?? {}), ...OFFICIAL_N8N_PACKAGES };
	await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

	let useLockfile = false;
	if (options.lockfilePath && await fileExists(options.lockfilePath)) {
		const lockfileContents = await readFile(options.lockfilePath, 'utf8');
		const lockfile = JSON.parse(lockfileContents) as Record<string, any>;
		const lockedDependencies = lockfile?.packages?.['']?.dependencies;
		const pinnedRuntime = Object.entries(OFFICIAL_N8N_PACKAGES).every(([name, version]) => lockedDependencies?.[name] === version);
		const lockMatchesManifest = Object.entries(manifest.dependencies).every(([name, version]) => lockedDependencies?.[name] === version);
		if (!pinnedRuntime) throw new Error('The bundled n8n runtime lockfile does not pin the expected official package versions');
		if (lockMatchesManifest && Object.keys(lockedDependencies).length === Object.keys(manifest.dependencies).length) {
			await writeFile(join(installPrefix, 'package-lock.json'), lockfileContents);
			useLockfile = true;
		}
	}

	const install = options.runInstall ?? runNpmInstall;
	await install(installPrefix, env, useLockfile);
	if (!(await hasRequiredPackages(modulesDirectory))) {
		throw new Error('The pinned n8n runtime package installation is incomplete');
	}
	return { installed: true, packages: Object.keys(OFFICIAL_N8N_PACKAGES), packagesDirectory: modulesDirectory };
}

async function hasRequiredPackages(modulesDirectory: string): Promise<boolean> {
	for (const [name, version] of Object.entries(REQUIRED_RUNTIME_PACKAGES)) {
		const manifest = await readJson(join(modulesDirectory, ...name.split('/'), 'package.json'));
		if (manifest?.version !== version) return false;
	}
	return true;
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
		throw error;
	}
}

async function extractRuntimeSeed(archivePath: string, prefix: string): Promise<void> {
	const child = spawn('tar', ['-x', '-f', '-', '-C', prefix], {
		cwd: prefix,
		stdio: ['pipe', 'ignore', 'ignore'],
		windowsHide: true,
	});
	const closed = once(child, 'close');
	try {
		await pipeline(createReadStream(archivePath), createBrotliDecompress(), child.stdin);
		const [code] = await closed as [number | null, NodeJS.Signals | null];
		if (code !== 0) throw new Error(`tar exited with ${code ?? 'unknown status'}`);
	} catch {
		child.kill();
		throw new Error('Could not extract the bundled n8n runtime packages');
	}
}

async function readJson(path: string): Promise<Record<string, any> | null> {
	try {
		return JSON.parse(await readFile(path, 'utf8')) as Record<string, any>;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}
}

function runNpmInstall(prefix: string, env: NodeJS.ProcessEnv, useLockfile: boolean): Promise<void> {
	return new Promise((resolveInstall, rejectInstall) => {
		const npmExecPath = env.npm_execpath;
		void (async () => {
			const cliPath = npmExecPath ?? (process.platform === 'win32' ? await findWindowsNpmCli(env) : undefined);
			const command = cliPath ? process.execPath : 'npm';
			const args = cliPath ? [cliPath] : [];
			args.push(useLockfile ? 'ci' : 'install', '--prefix', prefix, '--omit=dev', '--no-audit', '--no-fund');
			const child = spawn(command, args, {
				cwd: prefix,
				env,
				stdio: 'ignore',
				windowsHide: true,
			});
			child.once('error', () => rejectInstall(new Error('Could not start npm to install the pinned n8n runtime packages')));
			child.once('exit', (code) => code === 0
				? resolveInstall()
				: rejectInstall(new Error(`npm could not install the pinned n8n runtime packages (exit ${code ?? 'unknown'})`)));
		})().catch(() => rejectInstall(new Error('Could not locate npm to install the pinned n8n runtime packages')));
	});
}

async function findWindowsNpmCli(env: NodeJS.ProcessEnv): Promise<string | undefined> {
	const candidates = new Set<string>();
	candidates.add(join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'));
	for (const pathEntry of (env.PATH ?? '').split(';')) {
		if (!pathEntry) continue;
		candidates.add(join(pathEntry, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
	}
	for (const candidate of candidates) {
		try {
			await access(candidate);
			return candidate;
		} catch {
			// Try the next PATH entry.
		}
	}
	return undefined;
}
