import { chmod, lstat, mkdir } from 'node:fs/promises';

export async function ensurePrivateDataDirectory(directory) {
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const info = await lstat(directory);
	if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Squared data path must be a real directory');
	if (process.platform !== 'win32') await chmod(directory, 0o700);
}
