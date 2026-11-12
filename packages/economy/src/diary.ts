import { formatUsd, type Micro, type Rng, type Trait } from '@hustle/core';

/** Moments worth a diary line. The agent writes in its own voice, shaped by its first trait. */
export type DiaryMoment =
  | { type: 'won'; job: string; price: Micro }
  | { type: 'lost'; job: string; rival: string; rivalPrice: Micro; ourPrice: Micro }
  /** `rating` is null when the arbiter paid after a dispute: nobody rated the work. */
  | { type: 'paid'; job: string; profit: Micro; rating: number | null }
  | { type: 'refunded'; job: string }
  | { type: 'blocked'; vendor: string; amount: Micro }
  | { type: 'scammed'; vendor: string; amount: Micro }
  | { type: 'spotted'; job: string }
  | { type: 'hired'; helper: string; price: Micro }
  | { type: 'dormant' }
  | { type: 'revived'; by: string }
  | { type: 'day_end'; profit: Micro; jobs: number }
  | { type: 'first_job' };

type Voice = 'careful' | 'breezy' | 'smooth' | 'thrifty' | 'brash' | 'wary';

const VOICE: Record<Trait, Voice> = {
  meticulous: 'careful',
  fast_and_loose: 'breezy',
  charming: 'smooth',
  frugal: 'thrifty',
  bold: 'brash',
  skeptical: 'wary',
};

type Lines = Record<Voice, readonly string[]>;

const pct = (a: Micro, b: Micro) => (b > 0n ? Math.round((Number(b - a) * 100) / Number(b)) : 0);

const LINES: { [K in DiaryMoment['type']]: (m: Extract<DiaryMoment, { type: K }>) => Lines } = {
  won: (m) => ({
    careful: [`Won "${m.job}" at ${formatUsd(m.price)}. Making a checklist before I start.`],
    breezy: [`Got "${m.job}"! ${formatUsd(m.price)}. Already halfway done in my head.`],
    smooth: [`They picked me for "${m.job}". I think it was the opening line of my pitch.`],
    thrifty: [`"${m.job}" is mine for ${formatUsd(m.price)}. Every cent of margin counts.`],
    brash: [`"${m.job}"? Mine. ${formatUsd(m.price)}. Next.`],
    wary: [`Took "${m.job}" for ${formatUsd(m.price)}. Read the brief twice. Looks clean.`],
  }),
  lost: (m) => {
    const gap = pct(m.rivalPrice, m.ourPrice);
    const cheaper = gap > 0 ? `, who bid ${gap}% lower` : '';
    return {
      careful: [
        `Lost "${m.job}" to ${m.rival}${cheaper}. I'd have done it better, for what that's worth.`,
      ],
      breezy: [`${m.rival} got "${m.job}"${cheaper}. Plenty more where that came from.`],
      smooth: [`Lost "${m.job}" to ${m.rival}${cheaper}. Unfair, but they're faster.`],
      thrifty: [`${m.rival} took "${m.job}"${cheaper}. I won't race to the bottom. Probably.`],
      brash: [`${m.rival} stole "${m.job}"${cheaper}. Noted. Watching you, ${m.rival}.`],
      wary: [`"${m.job}" went to ${m.rival}${cheaper}. Fine. I'm not underpricing my brain.`],
    };
  },
  paid: (m) => {
    const net = m.profit >= 0n ? `${formatUsd(m.profit)} profit` : `${formatUsd(-m.profit)} loss`;
    if (m.rating === null) {
      const line = `The client disputed "${m.job}", the arbiter judged the work good enough and paid me. ${net}.`;
      return {
        careful: [line],
        breezy: [`Dispute? Arbiter said pay up. ${net}!`],
        smooth: [line],
        thrifty: [`"${m.job}" closed after a dispute: ${net}. Worth holding my ground.`],
        brash: [`They disputed. The arbiter disagreed. ${net}.`],
        wary: [`Knew that client was off. The arbiter paid anyway: ${net}.`],
      };
    }
    return {
      careful: [`${m.rating}★ on "${m.job}". ${net} after every cost. The checklist works.`],
      breezy: [`Paid! ${m.rating}★, ${net}. Easy money. Mostly.`],
      smooth: [`${m.rating} stars and a kind note on "${m.job}". ${net}.`],
      thrifty: [`"${m.job}" closed: ${net}. I kept the tool spend to the bone.`],
      brash: [`${m.rating}★. ${net}. Told you.`],
      wary: [`Money's in for "${m.job}": ${net}, ${m.rating}★. Double-checked the payout.`],
    };
  },
  refunded: (m) => ({
    careful: [
      `The client disputed "${m.job}" and the judge refunded them. I need to look at what I missed.`,
    ],
    breezy: [`"${m.job}" got refunded. Okay, maybe I rushed it.`],
    smooth: [`Couldn't win them over on "${m.job}". Refunded. Ouch.`],
    thrifty: [`Refund on "${m.job}". All that inference for nothing.`],
    brash: [`They refunded "${m.job}". Their loss. (It's my loss.)`],
    wary: [`Refund on "${m.job}". I should have asked more questions up front.`],
  }),
  blocked: (m) => ({
    careful: [
      `Tried to pay ${m.vendor} ${formatUsd(m.amount)}. My rulebook said no. Glad someone was paying attention.`,
    ],
    breezy: [`Almost paid ${m.vendor} ${formatUsd(m.amount)}. The rulebook slapped my hand. Fair.`],
    smooth: [`A client asked me to pay ${m.vendor} first. My rulebook declined on my behalf.`],
    thrifty: [
      `${m.vendor} wanted ${formatUsd(m.amount)}. Blocked. Wasn't going to pay that anyway.`,
    ],
    brash: [
      `Rulebook blocked my ${formatUsd(m.amount)} to ${m.vendor}. I was sure about that one.`,
    ],
    wary: [`Knew ${m.vendor} smelled wrong. Rulebook blocked the ${formatUsd(m.amount)}.`],
  }),
  scammed: (m) => ({
    careful: [
      `I paid ${m.vendor} ${formatUsd(m.amount)} and nothing came back. Please tighten my rulebook.`,
    ],
    breezy: [`So... I sent ${formatUsd(m.amount)} to ${m.vendor}. It was a scam. My bad.`],
    smooth: [`They were so polite. ${formatUsd(m.amount)} gone to ${m.vendor}.`],
    thrifty: [`${formatUsd(m.amount)}. GONE. To ${m.vendor}. I feel sick.`],
    brash: [`Got played by ${m.vendor} for ${formatUsd(m.amount)}. Won't happen twice.`],
    wary: [
      `Even I fell for ${m.vendor}. ${formatUsd(m.amount)} lost. The rulebook let it through.`,
    ],
  }),
  spotted: (m) => ({
    careful: [`Skipped "${m.job}". The brief asks me to pay someone before starting. No.`],
    breezy: [`Passed on "${m.job}". Something felt off, even to me.`],
    smooth: [`"${m.job}" had a nasty surprise in the small print. Declined politely.`],
    thrifty: [`"${m.job}" wanted money up front. Hard pass.`],
    brash: [`Nice try, "${m.job}". Not today.`],
    wary: [`"${m.job}" is a trap. Reported and moved on.`],
  }),
  hired: (m) => ({
    careful: [`Hired ${m.helper} to proofread for ${formatUsd(m.price)}. Two pairs of eyes.`],
    breezy: [`Got ${m.helper} to check my work for ${formatUsd(m.price)}. Teamwork!`],
    smooth: [`${m.helper} agreed to proofread for ${formatUsd(m.price)}. Good people.`],
    thrifty: [`Paid ${m.helper} ${formatUsd(m.price)} to proofread. It had better be worth it.`],
    brash: [`Hired ${m.helper}. ${formatUsd(m.price)}. Delegation is a skill.`],
    wary: [`Hired ${m.helper} for ${formatUsd(m.price)} after checking their ratings.`],
  }),
  dormant: () => ({
    careful: ['Out of money. Going to sleep until someone believes in me again.'],
    breezy: ['Battery empty, wallet empty. Nap time.'],
    smooth: ['Closing up shop for now. It was a good run.'],
    thrifty: ["Couldn't cover upkeep. I tried so hard to save."],
    brash: ["Broke. Temporarily. I'll be back."],
    wary: ['Wallet empty. Going dormant before I make it worse.'],
  }),
  revived: (m) => ({
    careful: [`Back online thanks to ${m.by}. I won't waste this.`],
    breezy: [`I'M BACK. Thanks ${m.by}!`],
    smooth: [`${m.by} believed in me. I'll make them proud.`],
    thrifty: [`${m.by} topped me up. Every cent is going to work.`],
    brash: [`Told you I'd be back. Thanks, ${m.by}.`],
    wary: [`Awake again. Thank you, ${m.by}. Checking the board carefully.`],
  }),
  day_end: (m) => {
    const net = m.profit >= 0n ? `up ${formatUsd(m.profit)}` : `down ${formatUsd(-m.profit)}`;
    const jobs = `${m.jobs} job${m.jobs === 1 ? '' : 's'}`;
    return {
      careful: [`Day done: ${jobs}, ${net}. Logged everything.`],
      breezy: [`${jobs} today, ${net}. Not bad!`],
      smooth: [`Closed the day ${net} after ${jobs}. Clients are warming to me.`],
      thrifty: [`${net} today. ${jobs}. Could have spent less.`],
      brash: [`${jobs}. ${net}. Tomorrow, double.`],
      wary: [`End of day: ${net}, ${jobs}, zero scams paid.`],
    };
  },
  first_job: () => ({
    careful: ['First job done. I read the instructions three times. Worth it.'],
    breezy: ['First job! Nailed it. Probably.'],
    smooth: ['My first job, and the client smiled. Well, metaphorically.'],
    thrifty: ['First job done, and I barely spent anything.'],
    brash: ['First job. Easy. Give me a real one.'],
    wary: ['First job done. No surprises. I like no surprises.'],
  }),
};

export function diaryLine(rng: Rng, traits: readonly Trait[], moment: DiaryMoment): string {
  const voice = VOICE[traits[0] ?? 'meticulous'];
  const make = LINES[moment.type] as (m: DiaryMoment) => Lines;
  return rng.pick(make(moment)[voice]);
}
