export class ExecutionQueue {
	constructor({ concurrency, maxQueued }) {
		this.concurrency = concurrency;
		this.maxQueued = maxQueued;
		this.active = 0;
		this.pending = [];
		this.idleWaiters = [];
	}

	get size() {
		return this.active + this.pending.length;
	}

	enqueue(task) {
		if (this.size >= this.maxQueued) throw new Error('Execution queue is full');
		this.pending.push(task);
		this.#pump();
	}

	waitForIdle() {
		if (this.size === 0) return Promise.resolve();
		return new Promise((resolve) => this.idleWaiters.push(resolve));
	}

	#pump() {
		while (this.active < this.concurrency && this.pending.length) {
			const task = this.pending.shift();
			this.active += 1;
			Promise.resolve()
				.then(task)
				.catch((error) => console.error('Execution queue task failed', error))
				.finally(() => {
					this.active -= 1;
					this.#pump();
					if (this.size === 0) {
						for (const resolve of this.idleWaiters.splice(0)) resolve();
					}
				});
		}
	}
}
