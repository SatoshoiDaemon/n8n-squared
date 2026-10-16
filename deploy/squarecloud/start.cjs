#!/usr/bin/env node

const path = require('node:path');

// Square Cloud routes HTTP traffic to port 80. Other PaaS platforms may set PORT.
// Respect explicit n8n settings so this launcher can be used outside Square Cloud.
process.env.N8N_LISTEN_ADDRESS ||= '0.0.0.0';
process.env.N8N_PORT ||= process.env.PORT || '80';
const entry = path.join(__dirname, 'packages', 'cli', 'bin', 'n8n');
process.argv = [process.execPath, entry, 'start'];

require(entry);
