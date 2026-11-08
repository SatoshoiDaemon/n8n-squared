import { ensureN8nPackages } from '../../src/nodes/n8n/package-installer.ts';
import { loadConfig } from '../../src/config.js';

const config = loadConfig();
const result = await ensureN8nPackages(config.n8nPackagesDir);
console.log(`Official n8n runtime packages ${result.installed ? 'installed' : 'already available'}: ${result.packages.join(', ')}`);
console.log(`Persistent package directory: ${result.packagesDirectory}`);
