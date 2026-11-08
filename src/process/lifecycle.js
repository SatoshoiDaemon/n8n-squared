export function installShutdownHandlers({ server, scheduler, store, executionEngine, timeoutMs = 10_000, processObject = process }) {
	let closing = false;
	let forceTimer;

	const shutdown = (signal) => {
		if (closing) return;
		closing = true;
		console.log(`Received ${signal}; stopping Squared`);
		const schedulerStopped = scheduler.stop();
		forceTimer = setTimeout(() => processObject.exit(1), timeoutMs);
		forceTimer.unref?.();
		server.close(async (error) => {
			clearTimeout(forceTimer);
			if (error) console.error('HTTP server close failed', error);
			try {
				await schedulerStopped;
				await executionEngine.drain();
				await store.close();
				processObject.exitCode = error ? 1 : 0;
			} catch (closeError) {
				console.error('PostgreSQL close failed', closeError);
				processObject.exitCode = 1;
			}
		});
	};

	processObject.once('SIGINT', () => shutdown('SIGINT'));
	processObject.once('SIGTERM', () => shutdown('SIGTERM'));
	return shutdown;
}
