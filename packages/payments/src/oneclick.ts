import { createHash, randomBytes } from 'node:crypto';

/**
 * NEAR Intents 1Click (https://1click.chaindefuser.com/v0), from the docs and a live dry quote on
 * 2026-11-11. Used for deposits from any chain and cash-out to any chain in real-money mode, which
 * this build does not enable; in sandbox mode the simulator walks the same flow with credits.
 */
export const USDC_NEAR = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
export const USDC_BASE = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';

export type SwapStatus =
  | 'PENDING_DEPOSIT'
  | 'KNOWN_DEPOSIT_TX'
  | 'PROCESSING'
  | 'SUCCESS'
  | 'INCOMPLETE_DEPOSIT'
  | 'REFUNDED'
  | 'FAILED';

export interface QuoteRequest {
  dry: boolean;
  swapType: 'EXACT_INPUT' | 'EXACT_OUTPUT';
  slippageTolerance: number;
  originAsset: string;
  depositType: 'ORIGIN_CHAIN' | 'INTENTS';
  destinationAsset: string;
  /** Smallest units of the origin asset (USDC: micro). */
  amount: string;
  recipient: string;
  recipientType: 'DESTINATION_CHAIN' | 'INTENTS';
  refundTo: string;
  refundType: 'ORIGIN_CHAIN' | 'INTENTS';
  deadline: string;
}

export interface Quote {
  depositAddress: string | null;
  amountIn: string;
  amountOut: string;
  deadline: string;
  /** Fee charged on this route, in basis points (observed ~2 bps on USDC→USDC). */
  feeBps: number;
}

export interface OneClick {
  readonly mode: 'mock' | 'live';
  quote(req: QuoteRequest): Promise<Quote>;
  status(depositAddress: string): Promise<SwapStatus>;
  submitDeposit(depositAddress: string, txHash: string): Promise<void>;
}

/** Fee the simulator charges: the ~2 bps observed on a live USDC Base→NEAR dry quote. */
const SIM_FEE_BPS = 2;

/**
 * Plays 1Click: quotes with deposit addresses, then PENDING_DEPOSIT → KNOWN_DEPOSIT_TX → PROCESSING →
 * SUCCESS as the simulated deposit is reported and polled. `failNextDeposit` drives the refund path.
 */
export class OneClickSimulator implements OneClick {
  readonly mode = 'mock' as const;
  private readonly swaps = new Map<
    string,
    { status: SwapStatus; polls: number; fail: boolean; quote: Quote }
  >();
  private failNext = false;

  failNextDeposit(): void {
    this.failNext = true;
  }

  async quote(req: QuoteRequest): Promise<Quote> {
    const amountIn = BigInt(req.amount);
    if (amountIn <= 0n) throw new Error('Amount is too low for bridge');
    const amountOut = amountIn - (amountIn * BigInt(SIM_FEE_BPS) + 9_999n) / 10_000n;
    const quote: Quote = {
      depositAddress: req.dry
        ? null
        : `0x${createHash('sha256').update(randomBytes(16)).digest('hex').slice(0, 40)}`,
      amountIn: amountIn.toString(),
      amountOut: amountOut.toString(),
      deadline: req.deadline,
      feeBps: SIM_FEE_BPS,
    };
    if (quote.depositAddress) {
      this.swaps.set(quote.depositAddress, {
        status: 'PENDING_DEPOSIT',
        polls: 0,
        fail: this.failNext,
        quote,
      });
      this.failNext = false;
    }
    return quote;
  }

  async submitDeposit(depositAddress: string, _txHash: string): Promise<void> {
    const swap = this.swaps.get(depositAddress);
    if (!swap) throw new Error('Unknown deposit address');
    if (swap.status === 'PENDING_DEPOSIT') swap.status = 'KNOWN_DEPOSIT_TX';
  }

  async status(depositAddress: string): Promise<SwapStatus> {
    const swap = this.swaps.get(depositAddress);
    if (!swap) throw new Error('Unknown deposit address');
    if (swap.status === 'PENDING_DEPOSIT') return swap.status;
    swap.polls += 1;
    if (swap.status === 'KNOWN_DEPOSIT_TX') swap.status = 'PROCESSING';
    else if (swap.status === 'PROCESSING' && swap.polls >= 2)
      swap.status = swap.fail ? 'REFUNDED' : 'SUCCESS';
    return swap.status;
  }

  quoteFor(depositAddress: string): Quote | null {
    return this.swaps.get(depositAddress)?.quote ?? null;
  }
}

/** The live 1Click API. UNVERIFIED beyond the dry quote; mainnet only, so not enabled here. */
export class OneClickClient implements OneClick {
  readonly mode = 'live' as const;
  constructor(
    private readonly jwt: string | undefined,
    private readonly baseUrl = 'https://1click.chaindefuser.com/v0',
  ) {}

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      ...(this.jwt ? { Authorization: `Bearer ${this.jwt}` } : {}),
    };
  }

  async quote(req: QuoteRequest): Promise<Quote> {
    const res = await fetch(`${this.baseUrl}/quote`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(req),
    });
    if (!res.ok) throw new Error(`1Click quote failed: ${res.status}`);
    const body = (await res.json()) as {
      quote: { depositAddress?: string; amountIn: string; amountOut: string; deadline: string };
    };
    const fee = BigInt(body.quote.amountIn) - BigInt(body.quote.amountOut);
    return {
      depositAddress: body.quote.depositAddress ?? null,
      amountIn: body.quote.amountIn,
      amountOut: body.quote.amountOut,
      deadline: body.quote.deadline,
      feeBps: Number((fee * 10_000n) / BigInt(body.quote.amountIn || '1')),
    };
  }

  async status(depositAddress: string): Promise<SwapStatus> {
    const res = await fetch(
      `${this.baseUrl}/status?depositAddress=${encodeURIComponent(depositAddress)}`,
      { headers: this.headers() },
    );
    if (!res.ok) throw new Error(`1Click status failed: ${res.status}`);
    return ((await res.json()) as { status: SwapStatus }).status;
  }

  async submitDeposit(depositAddress: string, txHash: string): Promise<void> {
    await fetch(`${this.baseUrl}/deposit/submit`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ depositAddress, txHash }),
    });
  }
}
