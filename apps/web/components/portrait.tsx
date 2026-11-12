import type { AgentLook, AgentMood } from '@hustle/core/browser';
import type { ReactNode } from 'react';

/** Body fill, a lighter belly/highlight, and a darker shade for each agent colour. */
export const PALETTE: Record<AgentLook['color'], { fill: string; light: string; shade: string }> = {
  tomato: { fill: '#ff6b57', light: '#ffa597', shade: '#d9442f' },
  marigold: { fill: '#ffb627', light: '#ffd77f', shade: '#d98e00' },
  mint: { fill: '#3dd6a3', light: '#93ecce', shade: '#1fa77a' },
  sky: { fill: '#4cb0ff', light: '#9dd3ff', shade: '#2483d6' },
  grape: { fill: '#9b6bff', light: '#c7adff', shade: '#7444e0' },
  bubblegum: { fill: '#ff7ec1', light: '#ffb8dd', shade: '#e0559f' },
};

const INK = '#1a1d3a';
const SW = 3.5;

interface Frame {
  /** The body silhouette. */
  shape: (fill: string) => ReactNode;
  /** Decorations drawn behind (antennae) or on top (halo, ears). */
  back?: (c: (typeof PALETTE)[AgentLook['color']]) => ReactNode;
  front?: (c: (typeof PALETTE)[AgentLook['color']]) => ReactNode;
  face: { x: number; y: number };
  /** Boxy draws its face on a dark screen, so the face is light. */
  screen?: boolean;
  /** Where thought dots, Zzz and sweat sit. */
  top: number;
}

const FRAMES: Record<AgentLook['body'], Frame> = {
  bolt: {
    shape: (fill) => (
      <rect
        x="22"
        y="38"
        width="76"
        height="62"
        rx="20"
        fill={fill}
        stroke={INK}
        strokeWidth={SW}
      />
    ),
    back: (c) => (
      <path
        d="M64 6 L50 26 L59 26 L53 40 L70 20 L61 20 Z"
        fill={c.light}
        stroke={INK}
        strokeWidth={3}
        strokeLinejoin="round"
      />
    ),
    face: { x: 60, y: 68 },
    top: 30,
  },
  orb: {
    shape: (fill) => <circle cx="60" cy="66" r="36" fill={fill} stroke={INK} strokeWidth={SW} />,
    front: (c) => (
      <ellipse
        cx="60"
        cy="20"
        rx="20"
        ry="5.5"
        fill="none"
        stroke={c.shade}
        strokeWidth={4}
        opacity={0.9}
      />
    ),
    face: { x: 60, y: 66 },
    top: 26,
  },
  boxy: {
    shape: (fill) => (
      <g>
        <rect
          x="14"
          y="36"
          width="92"
          height="64"
          rx="12"
          fill={fill}
          stroke={INK}
          strokeWidth={SW}
        />
        <rect
          x="24"
          y="45"
          width="72"
          height="44"
          rx="8"
          fill="#23284f"
          stroke={INK}
          strokeWidth={2.5}
        />
      </g>
    ),
    back: () => (
      <g stroke={INK} strokeWidth={3} strokeLinecap="round">
        <line x1="44" y1="36" x2="34" y2="18" />
        <line x1="76" y1="36" x2="86" y2="18" />
      </g>
    ),
    front: (c) => (
      <g stroke={INK} strokeWidth={2.5}>
        <rect x="6" y="56" width="9" height="22" rx="4" fill={c.shade} />
        <rect x="105" y="56" width="9" height="22" rx="4" fill={c.shade} />
      </g>
    ),
    face: { x: 60, y: 67 },
    screen: true,
    top: 24,
  },
  tall: {
    shape: (fill) => (
      <rect
        x="32"
        y="16"
        width="56"
        height="86"
        rx="28"
        fill={fill}
        stroke={INK}
        strokeWidth={SW}
      />
    ),
    front: (c) => (
      <path
        d="M44 84 Q60 94 76 84"
        fill="none"
        stroke={c.shade}
        strokeWidth={4}
        strokeLinecap="round"
      />
    ),
    face: { x: 60, y: 50 },
    top: 12,
  },
  squat: {
    shape: (fill) => (
      <path
        d="M14 98 Q14 50 60 50 Q106 50 106 98 Z"
        fill={fill}
        stroke={INK}
        strokeWidth={SW}
        strokeLinejoin="round"
      />
    ),
    front: (c) => (
      <g stroke={INK} strokeWidth={2.5}>
        <ellipse cx="38" cy="100" rx="10" ry="5" fill={c.shade} />
        <ellipse cx="82" cy="100" rx="10" ry="5" fill={c.shade} />
      </g>
    ),
    face: { x: 60, y: 78 },
    top: 42,
  },
  antenna: {
    shape: (fill) => (
      <rect
        x="22"
        y="40"
        width="76"
        height="60"
        rx="28"
        fill={fill}
        stroke={INK}
        strokeWidth={SW}
      />
    ),
    back: (c) => (
      <g stroke={INK} strokeWidth={3} strokeLinecap="round">
        <line x1="44" y1="42" x2="34" y2="16" />
        <line x1="76" y1="42" x2="86" y2="16" />
        <circle cx="34" cy="14" r="6" fill={c.light} />
        <circle cx="86" cy="14" r="6" fill={c.light} />
      </g>
    ),
    face: { x: 60, y: 70 },
    top: 20,
  },
};

function Face({ mood, x, y, screen }: { mood: AgentMood; x: number; y: number; screen: boolean }) {
  const ink = screen ? '#9ff5d4' : INK;
  const eye = 13;
  const cheeks = !screen && (
    <g fill="#ff5f8f" opacity={0.35}>
      <ellipse cx={x - 21} cy={y + 7} rx="6" ry="3.5" />
      <ellipse cx={x + 21} cy={y + 7} rx="6" ry="3.5" />
    </g>
  );
  const line = { stroke: ink, strokeWidth: 3.2, strokeLinecap: 'round' as const, fill: 'none' };
  if (mood === 'celebrating') {
    return (
      <g>
        {cheeks}
        <path d={`M${x - eye - 5} ${y - 2} q5 -7 10 0`} {...line} />
        <path d={`M${x + eye - 5} ${y - 2} q5 -7 10 0`} {...line} />
        <path
          d={`M${x - 9} ${y + 6} q9 12 18 0 Z`}
          fill={ink}
          stroke={ink}
          strokeWidth={2}
          strokeLinejoin="round"
        />
      </g>
    );
  }
  if (mood === 'sleeping') {
    return (
      <g>
        {cheeks}
        <path d={`M${x - eye - 5} ${y - 3} q5 5 10 0`} {...line} />
        <path d={`M${x + eye - 5} ${y - 3} q5 5 10 0`} {...line} />
        <ellipse cx={x} cy={y + 9} rx="3" ry="2.4" fill={ink} />
      </g>
    );
  }
  if (mood === 'stressed') {
    return (
      <g>
        {cheeks}
        <path d={`M${x - eye - 6} ${y - 12} l10 3`} {...line} />
        <path d={`M${x + eye + 6} ${y - 12} l-10 3`} {...line} />
        <circle
          cx={x - eye}
          cy={y - 2}
          r="5"
          fill={screen ? 'none' : '#fff'}
          stroke={ink}
          strokeWidth={2.5}
        />
        <circle
          cx={x + eye}
          cy={y - 2}
          r="5"
          fill={screen ? 'none' : '#fff'}
          stroke={ink}
          strokeWidth={2.5}
        />
        <circle cx={x - eye} cy={y - 2} r="1.8" fill={ink} />
        <circle cx={x + eye} cy={y - 2} r="1.8" fill={ink} />
        <path d={`M${x - 9} ${y + 11} q3 -4 6 0 t6 0 t6 0`} {...line} strokeWidth={2.6} />
      </g>
    );
  }
  const look = mood === 'busy' ? 2.5 : 0;
  return (
    <g>
      {cheeks}
      <g className="pt-eyes">
        <circle cx={x - eye + look} cy={y - 2} r="4.8" fill={ink} />
        <circle cx={x + eye + look} cy={y - 2} r="4.8" fill={ink} />
        {!screen && (
          <>
            <circle cx={x - eye + look + 1.6} cy={y - 3.8} r="1.6" fill="#fff" />
            <circle cx={x + eye + look + 1.6} cy={y - 3.8} r="1.6" fill="#fff" />
          </>
        )}
      </g>
      {mood === 'busy' ? (
        <path d={`M${x - 5} ${y + 9} h10`} {...line} />
      ) : (
        <path d={`M${x - 7} ${y + 7} q7 7 14 0`} {...line} />
      )}
    </g>
  );
}

function Extras({ mood, top }: { mood: AgentMood; top: number }) {
  if (mood === 'sleeping') {
    return (
      <g fontFamily="var(--font-display), sans-serif" fontWeight={800} fill="var(--ink-2)">
        <text className="pt-z" x="88" y={top + 10} fontSize="16">
          Z
        </text>
        <text className="pt-z" x="98" y={top} fontSize="11">
          z
        </text>
      </g>
    );
  }
  if (mood === 'busy') {
    return (
      <g fill="var(--ink-2)">
        <circle className="pt-dot" cx="92" cy={top + 4} r="3" />
        <circle className="pt-dot" cx="101" cy={top - 1} r="3" />
        <circle className="pt-dot" cx="110" cy={top - 6} r="3" />
      </g>
    );
  }
  if (mood === 'celebrating') {
    return (
      <g className="pt-confetti">
        <rect x="12" y={top + 10} width="6" height="6" rx="1" fill="#ffc53d" />
        <circle cx="104" cy={top + 6} r="3.5" fill="#ff6b57" />
        <rect x="98" y={top + 26} width="5" height="8" rx="1" fill="#3dd6a3" />
        <circle cx="18" cy={top + 30} r="3" fill="#4cb0ff" />
      </g>
    );
  }
  if (mood === 'stressed') {
    return (
      <path
        className="pt-drip"
        d={`M96 ${top + 14} q-5 8 0 11 q5 -3 0 -11 Z`}
        fill="#7cc8ff"
        stroke={INK}
        strokeWidth={1.8}
      />
    );
  }
  return null;
}

/**
 * An agent's portrait: a procedural sticker character for its body and colour, wearing its mood.
 * Decorative by default; pass `label` when the portrait is the only thing naming the agent.
 */
export function Portrait({
  look,
  mood = 'idle',
  size = 64,
  still = false,
  label,
  className = '',
}: {
  look: AgentLook;
  mood?: AgentMood;
  size?: number;
  /** Small list avatars stay still so a page of them doesn't wobble. */
  still?: boolean;
  label?: string;
  className?: string;
}) {
  const frame = FRAMES[look.body] ?? FRAMES.orb;
  const c = PALETTE[look.color] ?? PALETTE.sky;
  return (
    <svg
      viewBox="0 0 120 120"
      width={size}
      height={size}
      className={`pt-${mood} ${still ? 'pt-still' : ''} shrink-0 overflow-visible ${className}`}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <ellipse cx="60" cy="110" rx="30" ry="5" fill={INK} opacity={0.14} />
      <g className="pt-body">
        {frame.back?.(c)}
        {frame.shape(c.fill)}
        {!frame.screen && (
          <ellipse
            cx={frame.face.x - 18}
            cy={frame.face.y - 20}
            rx="9"
            ry="5"
            fill="#fff"
            opacity={0.35}
            transform={`rotate(-25 ${frame.face.x - 18} ${frame.face.y - 20})`}
          />
        )}
        {frame.front?.(c)}
        <Face mood={mood} x={frame.face.x} y={frame.face.y} screen={!!frame.screen} />
      </g>
      {/* Zzz, thought dots and confetti are decoration: never read aloud, even on a labelled portrait. */}
      {/* biome-ignore lint/a11y/noAriaHiddenOnFocusable: an SVG group isn't focusable; this hides decorative text */}
      <g aria-hidden="true">
        <Extras mood={mood} top={frame.top} />
      </g>
    </svg>
  );
}
