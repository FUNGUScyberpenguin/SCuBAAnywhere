/**
 * Records which collectors ran and which did not, the same way ScubaGear's
 * CommandTracker does.
 *
 * This is what keeps a partial collection honest. A policy whose data never
 * arrived is reported as unevaluated and names the collector that failed,
 * instead of quietly evaluating against an empty object and reporting a pass.
 */
export interface CollectorFailure {
  command: string;
  message: string;
}

export class CommandTracker {
  readonly successful: string[] = [];
  readonly failures: CollectorFailure[] = [];

  /**
   * Run one collector. On success its name is recorded and the value returned;
   * on failure the name is recorded as unsuccessful and `fallback` is returned.
   */
  async run<T>(command: string, fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
      const value = await fn();
      this.successful.push(command);
      return value;
    } catch (error) {
      this.failures.push({ command, message: error instanceof Error ? error.message : String(error) });
      return fallback;
    }
  }

  /** Mark a collector as not implemented, so its policies report as unevaluated. */
  skip(command: string, reason: string): void {
    this.failures.push({ command, message: reason });
  }

  get unsuccessful(): string[] {
    return this.failures.map((f) => f.command);
  }
}
