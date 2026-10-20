/**
 * Serialize asynchronous tasks: ordered events do not imply ordered async completion.
 * Run each task only after its predecessor fully finishes; report individual failures without poisoning the queue.
 */
export class SerialTaskQueue {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly onError: (error: unknown) => void) {}

  enqueue(task: () => void | Promise<void>): Promise<void> {
    const run = this.tail.then(task);
    this.tail = run.catch((error) => this.onError(error));
    return run;
  }
}
