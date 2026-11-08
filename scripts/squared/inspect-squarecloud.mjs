import {
	SquareCloudClient,
	appIsRunning,
	inspectSquareCloud,
	requireTargetAppId,
	runtimeEnvironmentReport,
	writeActionSummary,
} from './squarecloud-client.mjs';

try {
	const appId = requireTargetAppId();
	const client = new SquareCloudClient(process.env.SQUARECLOUD_API_KEY);
	const inspection = await inspectSquareCloud({ client, appId });
	const runtime = runtimeEnvironmentReport(inspection.envs);
	const latestMetric = latestSample(inspection.metrics);
	const startup = startupLog(inspection.logs);
	const rows = [
		['Application', appId],
		['Domain', inspection.appUrl],
		['Current state', `${String(inspection.appStatus.status || 'unknown')} (running: ${appIsRunning(inspection.appStatus)})`],
		['Configured memory', inspection.application.ram ? `${inspection.application.ram} MB` : 'not reported'],
		['Runtime database variable', runtime.databaseVariable || 'missing'],
		['Encryption key', runtime.encryptionKeyPresent ? 'present and valid length' : 'missing or too short'],
		['Operator token', runtime.accessTokenPresent ? 'present and valid length' : 'missing or too short'],
		['HTTP binding overrides', runtime.portCompatible && runtime.hostCompatible ? 'compatible with port 80 / 0.0.0.0' : 'incompatible; inspect the named variables before deployment'],
		['Current CPU/RAM', formatResource(inspection.appStatus.cpu, inspection.appStatus.ram)],
		['Startup log', startup ? `Squared ${startup.version} on Node ${startup.nodeVersion}` : 'no Squared startup record found'],
		['Latest historical metric', latestMetric ? `${latestMetric.date}: CPU ${latestMetric.cpu}%, RAM ${latestMetric.ram} MB` : 'not available'],
		['Runtime configuration changes', 'none; inspection is read-only'],
	];
	writeActionSummary('Square Cloud pre-deploy inspection', rows);
} catch (error) {
	console.error(`Square Cloud inspection failed: ${safeError(error)}`);
	process.exitCode = 1;
}

function formatResource(cpu, ram) {
	if (cpu == null && ram == null) return 'not reported';
	return `CPU ${cpu ?? 'not reported'}, RAM ${ram ?? 'not reported'}`;
}

function latestSample(samples) {
	return [...samples].sort((a, b) => Date.parse(b.date) - Date.parse(a.date))[0];
}

function startupLog(logs) {
	const match = logs.match(/Squared ([\d.]+) \(Node ([\d.]+)\) listening on/);
	return match ? { version: match[1], nodeVersion: match[2] } : null;
}

function safeError(error) {
	if (error?.code && error?.status !== undefined) return `${error.code} (HTTP ${error.status})`;
	return error instanceof Error ? error.message : 'unknown error';
}
