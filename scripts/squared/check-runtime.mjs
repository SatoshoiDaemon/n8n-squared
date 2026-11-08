import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const directories = [join(root, 'src'), join(root, 'scripts/squared')];
const files = directories.flatMap(collect).filter((file) => /\.(?:js|mjs)$/.test(file)).sort();

if (files.length === 0) throw new Error('No JavaScript runtime files were found under src/');

for (const file of files) {
	const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
	if (result.error) throw result.error;
	if (result.status !== 0) {
		process.stderr.write(result.stderr || result.stdout);
		process.exit(result.status || 1);
	}
}

console.log(`Syntax check passed for ${files.length} JavaScript files under src/ and scripts/squared/`);

function collect(directory) {
	return readdirSync(directory).flatMap((name) => {
		const entry = join(directory, name);
		return statSync(entry).isDirectory() ? collect(entry) : [entry];
	});
}
