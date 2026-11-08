export class WorkflowScheduler {
	constructor({ store, workflowService, pollMs }) {
		this.store = store;
		this.workflowService = workflowService;
		this.pollMs = pollMs;
		this.timer = undefined;
		this.stopped = false;
		this.polling = false;
		this.currentPoll = Promise.resolve();
	}

	start() {
		this.stopped = false;
		this.#schedulePoll();
		this.timer = setInterval(() => this.#schedulePoll(), this.pollMs);
		this.timer.unref?.();
	}

	stop() {
		this.stopped = true;
		clearInterval(this.timer);
		return this.currentPoll;
	}

	#schedulePoll() {
		if (this.stopped || this.polling) return;
		this.currentPoll = this.#poll();
	}

	async #poll() {
		if (this.stopped || this.polling) return;
		this.polling = true;
		try {
			const now = Date.now();
			const workflows = await this.store.listScheduleWorkflows();
			if (this.stopped) return;
			for (const workflow of workflows) {
				if (this.stopped) break;
				if (workflow.nodes[0]?.type !== 'trigger.schedule') continue;
				const intervalMs = workflow.nodes[0].parameters.intervalSeconds * 1_000;
				const last = workflow.lastScheduledAt ? new Date(workflow.lastScheduledAt).getTime() : 0;
				if (now - last < intervalMs) continue;
				await this.workflowService.execute(workflow.id, 'schedule', { scheduledAt: new Date(now).toISOString() });
			}
		} catch (error) {
			console.error('Schedule poll failed', error);
		} finally {
			this.polling = false;
		}
	}
}
