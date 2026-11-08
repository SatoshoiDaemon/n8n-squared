import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';

export class PersistentBinaryDataStore {
	constructor(directory) {
		this.directory = resolve(directory);
	}

	async store(buffer) {
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		if (process.platform !== 'win32') await chmod(this.directory, 0o700);
		const id = randomUUID();
		await writeFile(join(this.directory, id), buffer, { mode: 0o600, flag: 'wx' });
		return id;
	}

	async retrieve(id) {
		if (typeof id !== 'string' || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(id)) {
			throw new Error('Invalid Squared binary data identifier');
		}
		return readFile(join(this.directory, id));
	}
}
