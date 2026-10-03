/**
 * The ContextForge mark: a "C" drawn as a small graph, traced from the brand
 * sheet. Vector, so the same drawing serves the header, the favicon and the
 * social card. Pass a distinct `id` when the mark appears more than once on a
 * page, so each copy's gradients resolve even if another copy is hidden.
 */

type Pt = [number, number, number]; // x, y, radius (viewBox 0 0 64 64)

export const MARK_NODES: Record<string, Pt> = {
  top: [34.8, 6.2, 4.2],
  topRight: [55.2, 13.2, 3.0],
  upperLeft: [16.4, 19.6, 3.3],
  farLeft: [5.6, 26.2, 2.8],
  center: [27.9, 27.2, 5.6],
  lowerLeft: [14.8, 46.4, 4.6],
  lowerRight: [39.7, 44.0, 5.0],
  rightLow: [58.4, 44.4, 2.8],
  bottom: [40.5, 57.6, 3.4],
};

const N = MARK_NODES;
const at = (k: keyof typeof N) => `${N[k][0]} ${N[k][1]}`;

/** Connections, as SVG path data. */
export const MARK_EDGES = [
  `M${at("top")} Q30.4 16.5 ${at("center")}`,
  `M${at("center")} L${at("upperLeft")}`,
  `M${at("upperLeft")} L${at("farLeft")}`,
  `M${at("center")} L${at("lowerLeft")}`,
  `M${at("center")} L${at("lowerRight")}`,
  `M${at("lowerLeft")} Q27 53 ${at("lowerRight")}`,
  `M${at("lowerRight")} L${at("bottom")}`,
  `M${at("lowerRight")} L${at("rightLow")}`,
];

/** Translucent ribbons that give the mark its "C". */
export const MARK_RIBBONS = [
  `M${at("top")} C44 4.5 51 8 ${at("topRight")} C47 12.5 41 12 36.5 11 Z`,
  `M${at("top")} C20 7 7.5 16 5.6 26.2 C4 37 8.5 45 14.8 46.4 C12 38 13 27 18.5 19 C23 12.5 28.5 9 ${at("top")} Z`,
  `M${at("lowerRight")} C47 45.5 53 45.5 ${at("rightLow")} C54 49 46 51.5 41 49.5 Z`,
];

export function Mark({
  id = "cf-mark",
  size = 32,
  mono,
  className,
  title,
}: {
  id?: string;
  size?: number;
  /** A single colour (e.g. "#fff") instead of the teal gradient. */
  mono?: string;
  className?: string;
  title?: string;
}) {
  const fill = mono ?? `url(#${id}-node)`;
  const stroke = mono ?? `url(#${id}-edge)`;
  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      className={className}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      {!mono && (
        <defs>
          <linearGradient id={`${id}-node`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#99f6e4" />
            <stop offset="0.55" stopColor="#2dd4bf" />
            <stop offset="1" stopColor="#0ea5a4" />
          </linearGradient>
          <linearGradient id={`${id}-edge`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#5eead4" />
            <stop offset="1" stopColor="#14b8a6" />
          </linearGradient>
        </defs>
      )}
      {MARK_RIBBONS.map((d, i) => (
        <path key={`r${i}`} d={d} fill={mono ?? "#2dd4bf"} opacity={0.16} />
      ))}
      {MARK_EDGES.map((d, i) => (
        <path
          key={`e${i}`}
          d={d}
          fill="none"
          stroke={stroke}
          strokeWidth={2.2}
          strokeLinecap="round"
        />
      ))}
      {Object.entries(N).map(([k, [x, y, r]]) => (
        <circle key={k} cx={x} cy={y} r={r} fill={fill} />
      ))}
    </svg>
  );
}

/** Mark plus wordmark: "Context" in the text colour, "Forge" in teal. */
export function Logo({ id = "cf-logo", size = 30 }: { id?: string; size?: number }) {
  return (
    <span className="cf-logo">
      <Mark id={id} size={size} />
      <span className="cf-wordmark">
        Context<span>Forge</span>
      </span>
    </span>
  );
}
