import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { ensurePrivateDataDirectory } from '../persistence/data-directory.js';

export async function loadOrCreateEncryptionKey(dataDir, configuredKey) {
	await ensurePrivateDataDirectory(dataDir);
	const keyPath = join(dataDir, 'encryption-key');
	const existing = await readSecret(keyPath);
	if (existing !== null) {
		if (configuredKey && !sameSecret(existing, configuredKey)) {
			throw new Error('SQUARED_ENCRYPTION_KEY does not match the persisted key; existing credentials were left unchanged');
		}
		return existing;
	}

	const key = configuredKey || randomBytes(32).toString('base64url');
	if (key.length < 32) throw new Error('Persisted encryption key is invalid');
	try {
		await writeSecret(keyPath, key);
		return key;
	} catch (error) {
		if (error.code !== 'EEXIST') throw error;
		const raced = await readSecret(keyPath);
		if (raced === null || (configuredKey && !sameSecret(raced, configuredKey))) {
			throw new Error('A different persisted encryption key was created during startup; existing credentials were left unchanged');
		}
		return raced;
	}
}

export async function loadOrCreateBootstrapCode(dataDir) {
	await ensurePrivateDataDirectory(dataDir);
	const codePath = join(dataDir, 'bootstrap-code');
	const existing = await readSecret(codePath);
	if (existing !== null) return existing;
	const code = randomBytes(32).toString('base64url');
	try {
		await writeSecret(codePath, code);
		return code;
	} catch (error) {
		if (error.code !== 'EEXIST') throw error;
		const raced = await readSecret(codePath);
		if (raced === null) throw new Error('Bootstrap code could not be read after concurrent initialization');
		return raced;
	}
}

export async function removeBootstrapCode(dataDir) {
	try {
		await unlink(join(dataDir, 'bootstrap-code'));
	} catch (error) {
		if (error.code !== 'ENOENT') throw error;
	}
}

async function readSecret(path) {
	try {
		const value = await readFile(path, 'utf8');
		if (value.length < 32) throw new Error('Persisted secret is invalid');
		return value;
	} catch (error) {
		if (error.code === 'ENOENT') return null;
		throw error;
	}
}

async function writeSecret(path, value) {
	const handle = await open(path, 'wx', 0o600);
	try {
		await handle.writeFile(value, 'utf8');
		await handle.sync();
	} finally {
		await handle.close();
	}
	if (process.platform !== 'win32') await chmod(path, 0o600);
}

function sameSecret(left, right) {
	const leftHash = createHash('sha256').update(left, 'utf8').digest();
	const rightHash = createHash('sha256').update(right, 'utf8').digest();
	return timingSafeEqual(leftHash, rightHash);
}
