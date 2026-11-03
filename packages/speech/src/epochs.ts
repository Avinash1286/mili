export interface OutputGeneration { epoch: number; signal: AbortSignal }

/** One instance per live session. Audio playback queues must also clear on interrupt. */
export class OutputEpoch {
  #epoch = 0;
  #controller = new AbortController();
  #closed = false;
  #active = false;

  get current(): number { return this.#epoch; }

  begin(): OutputGeneration {
    if (this.#closed) throw new Error('Output session is closed.');
    this.#advance();
    this.#active = true;
    return { epoch: this.#epoch, signal: this.#controller.signal };
  }

  interrupt(): number {
    if (!this.#closed) this.#advance();
    return this.#epoch;
  }

  accepts(epoch: number): boolean {
    return !this.#closed && this.#active && Number.isSafeInteger(epoch) && epoch === this.#epoch;
  }

  close(): void {
    if (this.#closed) return;
    this.#advance();
    this.#closed = true;
    this.#controller.abort();
  }

  #advance(): void {
    if (this.#epoch >= Number.MAX_SAFE_INTEGER) throw new Error('Output epoch exhausted.');
    // Invalidate first so synchronous abort callbacks cannot accept the old output.
    const previous = this.#controller;
    this.#active = false;
    this.#epoch += 1;
    this.#controller = new AbortController();
    previous.abort();
  }
}
