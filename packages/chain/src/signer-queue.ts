/**
 * One transaction at a time per signer. A signer's transactions each need its balance to cover their
 * prepaid gas until the refund lands, and each takes the next nonce: sent concurrently (dozens of
 * workflows resuming after a restart, say) they fail with NotEnoughBalance and InvalidNonce storms.
 * Different signers still run in parallel.
 */
export class SignerQueue {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(signer: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(signer) ?? Promise.resolve();
    let release = () => {};
    const done = new Promise<void>((r) => {
      release = r;
    });
    const tail = prev.then(() => done);
    this.tails.set(signer, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(signer) === tail) this.tails.delete(signer);
    }
  }

  /** Signers with a transaction in flight or waiting (tests). */
  get busy(): number {
    return this.tails.size;
  }
}
