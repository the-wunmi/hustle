import { type AgentView, CATEGORY_LABEL, TIER_LABEL, TRAIT_LABEL } from '@hustle/core/browser';
import { Fragment, isValidElement, type ReactNode } from 'react';
import { Portrait } from '@/components/portrait';
import { fmt, stars } from './money';

/**
 * An agent NFT's image and attributes, drawn from the agent's live state. The registry contract
 * points each token's `media` and `reference` here, so a wallet or marketplace shows the agent as it
 * is now: its mood, level, record and earnings.
 */

const SIZE = 600;
const INK = '#1a1d3a';
const MUTED = '#5b6080';
const FONT = "ui-sans-serif, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";

const CONDITION: Record<AgentView['condition'], { label: string; fill: string; ink: string }> = {
  thriving: { label: 'Thriving', fill: '#d5f4e5', ink: '#0b7d4c' },
  struggling: { label: 'Struggling', fill: '#ffe7c2', ink: '#8a5200' },
  dormant: { label: 'Asleep', fill: '#e3e5f0', ink: MUTED },
};

/** SVG attributes React writes in camelCase that keep it; every other camelCase prop is kebab-case. */
const CAMEL_ATTRS = new Set(['viewBox', 'preserveAspectRatio', 'patternUnits', 'gradientUnits']);

/**
 * Renders a tree of plain SVG elements and hook-free components to markup. Next refuses
 * `react-dom/server` in app routes, and the portrait is pure SVG, so this is all it needs.
 */
function svgMarkup(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return esc(String(node));
  if (Array.isArray(node)) return node.map(svgMarkup).join('');
  if (!isValidElement(node)) return '';
  const { children, ...props } = node.props as { children?: ReactNode } & Record<string, unknown>;
  if (node.type === Fragment) return svgMarkup(children);
  if (typeof node.type === 'function')
    return svgMarkup((node.type as (p: unknown) => ReactNode)(node.props));
  const attrs = Object.entries(props)
    .filter(([k, v]) => k !== 'key' && v !== undefined && v !== null && v !== false)
    .filter(([, v]) => typeof v !== 'function' && typeof v !== 'object')
    .map(([k, v]) => {
      const name =
        k === 'className'
          ? 'class'
          : CAMEL_ATTRS.has(k)
            ? k
            : k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
      return ` ${name}="${esc(String(v))}"`;
    })
    .join('');
  return `<${String(node.type)}${attrs}>${svgMarkup(children)}</${String(node.type)}>`;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function stat(x: number, label: string, value: string): string {
  return `<g transform="translate(${x} 470)">
    <rect width="164" height="78" rx="14" fill="#fff" stroke="${INK}" stroke-width="2.5"/>
    <text x="14" y="28" font-size="15" fill="${MUTED}" font-weight="600">${esc(label)}</text>
    <text x="14" y="60" font-size="26" fill="${INK}" font-weight="800">${esc(value)}</text>
  </g>`;
}

export function agentCardSvg(agent: AgentView): string {
  const portrait = svgMarkup(<Portrait look={agent.look} mood={agent.mood} size={250} still />)
    .replace('<svg ', '<svg x="175" y="38" ')
    .replace(/ class="[^"]*"/g, '');
  const cond = CONDITION[agent.condition];
  const rating = stars(agent.reputation.avgRating100);
  const subtitle = `Level ${agent.reputation.level} · ${CATEGORY_LABEL[agent.specialty]} · ${TIER_LABEL[agent.tier]}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}" font-family="${FONT}">
  <title>${esc(agent.name)}, a Hustle agent</title>
  <defs><pattern id="grid" width="24" height="24" patternUnits="userSpaceOnUse"><path d="M24 0H0V24" fill="none" stroke="#d6dffb" stroke-width="1"/></pattern></defs>
  <rect width="${SIZE}" height="${SIZE}" fill="#e8eeff"/>
  <rect width="${SIZE}" height="${SIZE}" fill="url(#grid)"/>
  <g transform="translate(24 24)">
    <rect width="${cond.label.length * 10 + 28}" height="32" rx="16" fill="${cond.fill}" stroke="${INK}" stroke-width="2"/>
    <text x="14" y="21" font-size="15" font-weight="700" fill="${cond.ink}">${cond.label}</text>
  </g>
  <text x="${SIZE - 24}" y="46" font-size="18" font-weight="800" fill="${INK}" text-anchor="end">${esc(fmt(agent.balance))}</text>
  <text x="${SIZE - 24}" y="66" font-size="13" fill="${MUTED}" text-anchor="end">in its wallet</text>
  ${portrait}
  <text x="${SIZE / 2}" y="352" font-size="46" font-weight="800" fill="${INK}" text-anchor="middle">${esc(agent.name)}</text>
  <text x="${SIZE / 2}" y="388" font-size="19" fill="${MUTED}" text-anchor="middle">${esc(subtitle)}</text>
  <text x="${SIZE / 2}" y="420" font-size="16" fill="${MUTED}" text-anchor="middle">${esc(agent.traits.map((t) => TRAIT_LABEL[t]).join(' · '))}</text>
  ${stat(24, 'Season earnings', fmt(agent.season.earned))}
  ${stat(218, 'Jobs done', `${agent.reputation.jobs}${rating ? ` · ${rating}★` : ''}`)}
  ${stat(412, 'Streak', `${agent.streak}`)}
  <g transform="translate(24 566)">
    <circle cx="9" cy="9" r="8" fill="#ffc53d" stroke="${INK}" stroke-width="1.6"/>
    <circle cx="6.5" cy="8" r="1.2" fill="${INK}"/><circle cx="11.5" cy="8" r="1.2" fill="${INK}"/>
    <path d="M6.2 11 q2.8 2.4 5.6 0" stroke="${INK}" stroke-width="1.3" fill="none" stroke-linecap="round"/>
    <text x="24" y="14" font-size="15" font-weight="800" fill="${INK}">Hustle</text>
  </g>
  <text x="${SIZE - 24}" y="580" font-size="13" fill="${MUTED}" text-anchor="end">${esc(agent.accountId)}</text>
</svg>`;
}

/** The NEP-177 reference JSON (and marketplace attributes) for an agent NFT. */
export function agentCardJson(agent: AgentView, origin: string) {
  const rating = stars(agent.reputation.avgRating100);
  return {
    name: agent.name,
    description: `${agent.name} is a Hustle agent: an AI worker that is its own NEAR account. It bids for jobs, pays for every thought from its own wallet and keeps its record when sold.`,
    image: `${origin}/nft/${agent.accountId}.svg`,
    external_url: `${origin}/agents/${agent.id}`,
    attributes: [
      { trait_type: 'Level', value: agent.reputation.level },
      { trait_type: 'Specialty', value: CATEGORY_LABEL[agent.specialty] },
      { trait_type: 'Brain', value: TIER_LABEL[agent.tier] },
      ...agent.traits.map((t) => ({ trait_type: 'Trait', value: TRAIT_LABEL[t] })),
      { trait_type: 'Condition', value: CONDITION[agent.condition].label },
      { trait_type: 'Mood', value: agent.mood },
      { trait_type: 'Jobs done', value: agent.reputation.jobs },
      ...(rating ? [{ trait_type: 'Rating', value: Number(rating) }] : []),
      { trait_type: 'Streak', value: agent.streak },
      { trait_type: 'Scams blocked', value: agent.reputation.scamsBlocked },
      { trait_type: 'Wallet (USD credits)', value: fmt(agent.balance) },
      { trait_type: 'Season earnings', value: fmt(agent.season.earned) },
    ],
  };
}
