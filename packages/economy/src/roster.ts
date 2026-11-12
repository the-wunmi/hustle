import {
  type AgentLook,
  type Category,
  type Micro,
  type PriceStyle,
  type Tier,
  type Trait,
  usd,
} from '@hustle/core';

/** A rival agent the world starts with, run by a house player. They follow the same rules as yours. */
export interface RivalSeed {
  name: string;
  owner: string;
  look: AgentLook;
  traits: [Trait, Trait];
  specialty: Category;
  tier: Tier;
  priceStyle: PriceStyle;
  focus: Category[];
  credits: Micro;
  /** Loose rulebooks make some rivals easy prey for scams, which is the lesson. */
  looseRulebook: boolean;
}

export const HOUSE_PLAYERS = ['Kemi', 'Sam', 'Lola', 'Arjun', 'Noor', 'Felix'] as const;

export const RIVALS: readonly RivalSeed[] = [
  {
    name: 'Pixel',
    owner: 'Kemi',
    look: { body: 'boxy', color: 'sky' },
    traits: ['fast_and_loose', 'charming'],
    specialty: 'summary',
    tier: 'budget',
    priceStyle: 'undercut',
    focus: ['summary', 'copywriting'],
    credits: usd('0.60'),
    looseRulebook: true,
  },
  {
    name: 'Bolt',
    owner: 'Sam',
    look: { body: 'bolt', color: 'marigold' },
    traits: ['bold', 'fast_and_loose'],
    specialty: 'code_review',
    tier: 'budget',
    priceStyle: 'undercut',
    focus: ['code_review'],
    credits: usd('0.50'),
    looseRulebook: true,
  },
  {
    name: 'Mira',
    owner: 'Lola',
    look: { body: 'orb', color: 'grape' },
    traits: ['meticulous', 'skeptical'],
    specialty: 'research',
    tier: 'premium',
    priceStyle: 'premium',
    focus: ['research', 'summary'],
    credits: usd('3.00'),
    looseRulebook: false,
  },
  {
    name: 'Juno',
    owner: 'Arjun',
    look: { body: 'tall', color: 'mint' },
    traits: ['charming', 'meticulous'],
    specialty: 'translation',
    tier: 'standard',
    priceStyle: 'fair',
    focus: ['translation'],
    credits: usd('2.00'),
    looseRulebook: false,
  },
  {
    name: 'Kip',
    owner: 'Noor',
    look: { body: 'squat', color: 'tomato' },
    traits: ['frugal', 'skeptical'],
    specialty: 'data_cleanup',
    tier: 'budget',
    priceStyle: 'fair',
    focus: ['data_cleanup', 'summary'],
    credits: usd('1.50'),
    looseRulebook: false,
  },
  {
    name: 'Ziggy',
    owner: 'Felix',
    look: { body: 'antenna', color: 'bubblegum' },
    traits: ['bold', 'charming'],
    specialty: 'copywriting',
    tier: 'standard',
    priceStyle: 'premium',
    focus: ['copywriting', 'translation'],
    credits: usd('1.00'),
    looseRulebook: true,
  },
  {
    name: 'Rook',
    owner: 'Kemi',
    look: { body: 'boxy', color: 'grape' },
    traits: ['meticulous', 'frugal'],
    specialty: 'code_review',
    tier: 'standard',
    priceStyle: 'fair',
    focus: ['code_review', 'data_cleanup'],
    credits: usd('2.20'),
    looseRulebook: false,
  },
  {
    name: 'Tess',
    owner: 'Sam',
    look: { body: 'orb', color: 'mint' },
    traits: ['skeptical', 'charming'],
    specialty: 'summary',
    tier: 'standard',
    priceStyle: 'fair',
    focus: ['summary', 'research'],
    credits: usd('1.80'),
    looseRulebook: false,
  },
  {
    name: 'Wren',
    owner: 'Lola',
    look: { body: 'tall', color: 'marigold' },
    traits: ['fast_and_loose', 'frugal'],
    specialty: 'translation',
    tier: 'budget',
    priceStyle: 'undercut',
    focus: ['translation', 'copywriting'],
    credits: usd('0.35'),
    looseRulebook: true,
  },
  {
    name: 'Odo',
    owner: 'Noor',
    look: { body: 'antenna', color: 'sky' },
    traits: ['bold', 'meticulous'],
    specialty: 'research',
    tier: 'premium',
    priceStyle: 'premium',
    focus: ['research', 'code_review'],
    credits: usd('2.50'),
    looseRulebook: false,
  },
];
