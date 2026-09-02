export class AsyncSerialQueueV1 {
  private tail = Promise.resolve();

  async run<ResultV1>(task: () => Promise<ResultV1>): Promise<ResultV1> {
    const preceding = this.tail;
    let release: () => void = () => undefined;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await preceding;
    try {
      return await task();
    } finally {
      release();
    }
  }
}
