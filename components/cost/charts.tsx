import type { ReactNode } from "react";

import { cn } from "@/components/ui";

/**
 * Inline SVG charts. No chart library, no client JS.
 *
 * Every chart here plots ONE measure, so there is no categorical palette to get
 * wrong: magnitude is carried by length, the single hue is the app accent, and
 * identity is carried by real text labels rather than by colour. Colours come
 * from the theme tokens in `app/globals.css`, so light and dark are both
 * declared rather than flipped. Hover detail rides on native SVG `<title>`,
 * which needs no runtime.
 */

const ACCENT = "var(--color-accent)";
const TRACK = "var(--color-surface-muted)";
const LINE = "var(--color-line)";
const INK = "var(--color-ink)";
const INK_MUTED = "var(--color-ink-muted)";
const INK_FAINT = "var(--color-ink-faint)";

export type BarDatum = {
  key: string;
  label: string;
  value: number;
  /** Right-hand figure. Defaults to `value`. */
  display?: string;
  /** Native tooltip text. */
  hint?: string;
  emphasis?: boolean;
};

const ROW_HEIGHT = 34;
const BAR_HEIGHT = 8;

/**
 * Horizontal bars, one row per category, sorted by the caller.
 *
 * Sized in CSS pixels with no `viewBox` so text keeps its real size at any
 * container width and the 4px rounded data-ends stay circular.
 */
export function BarChart({
  data,
  className,
  emptyLabel = "No spend recorded yet.",
}: {
  data: BarDatum[];
  className?: string;
  emptyLabel?: string;
}) {
  if (data.length === 0) {
    return <p className="px-4 py-6 text-sm text-ink-muted">{emptyLabel}</p>;
  }

  const max = Math.max(...data.map((d) => d.value), 0);
  const height = data.length * ROW_HEIGHT;

  return (
    <svg
      width="100%"
      height={height}
      className={cn("block", className)}
      role="img"
      aria-label="Bar chart"
    >
      {data.map((d, i) => {
        const top = i * ROW_HEIGHT;
        const pct = max > 0 ? Math.max(d.value > 0 ? 0.8 : 0, (d.value / max) * 100) : 0;
        return (
          <g key={d.key}>
            <title>{d.hint ?? `${d.label}: ${d.display ?? d.value}`}</title>
            <text
              x={0}
              y={top + 11}
              fontSize={12}
              fill={d.emphasis ? INK : INK_MUTED}
              fontWeight={d.emphasis ? 600 : 400}
            >
              {d.label}
            </text>
            <text
              x="100%"
              y={top + 11}
              fontSize={11}
              textAnchor="end"
              fill={INK}
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {d.display ?? String(d.value)}
            </text>
            <rect
              x={0}
              y={top + 18}
              width="100%"
              height={BAR_HEIGHT}
              rx={BAR_HEIGHT / 2}
              fill={TRACK}
            />
            {pct > 0 ? (
              <rect
                x={0}
                y={top + 18}
                width={`${pct}%`}
                height={BAR_HEIGHT}
                rx={BAR_HEIGHT / 2}
                fill={ACCENT}
                opacity={d.emphasis === false ? 0.55 : 1}
              />
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

export type LinePoint = { x: number; y: number; label?: string; hint?: string };

const VB_W = 640;
const VB_H = 200;
const PAD = { top: 16, right: 12, bottom: 26, left: 44 };

/**
 * Single-series line over an ordered x (league weeks). Uniform scaling, so the
 * 8px markers stay round; grid and axes are recessive by design.
 */
export function LineChart({
  points,
  formatY,
  className,
  emptyLabel = "Not enough weeks yet to draw a trend.",
}: {
  points: LinePoint[];
  formatY: (value: number) => string;
  className?: string;
  emptyLabel?: string;
}) {
  if (points.length === 0) {
    return <p className="px-4 py-6 text-sm text-ink-muted">{emptyLabel}</p>;
  }

  const maxY = Math.max(...points.map((p) => p.y), 0);
  const minX = Math.min(...points.map((p) => p.x));
  const maxX = Math.max(...points.map((p) => p.x));
  const plotW = VB_W - PAD.left - PAD.right;
  const plotH = VB_H - PAD.top - PAD.bottom;

  const scaleX = (x: number) =>
    maxX === minX ? PAD.left + plotW / 2 : PAD.left + ((x - minX) / (maxX - minX)) * plotW;
  const scaleY = (y: number) => PAD.top + plotH - (maxY > 0 ? (y / maxY) * plotH : 0);

  const path = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${scaleX(p.x).toFixed(1)},${scaleY(p.y).toFixed(1)}`)
    .join(" ");

  const ticks = [0, 0.5, 1].map((t) => ({ value: maxY * t, y: scaleY(maxY * t) }));

  return (
    <svg
      viewBox={`0 0 ${VB_W} ${VB_H}`}
      className={cn("block w-full", className)}
      role="img"
      aria-label="Line chart"
    >
      {ticks.map((tick) => (
        <g key={tick.value}>
          <line
            x1={PAD.left}
            x2={VB_W - PAD.right}
            y1={tick.y}
            y2={tick.y}
            stroke={LINE}
            strokeWidth={1}
          />
          <text x={PAD.left - 6} y={tick.y + 3} fontSize={10} textAnchor="end" fill={INK_FAINT}>
            {formatY(tick.value)}
          </text>
        </g>
      ))}

      <path d={path} fill="none" stroke={ACCENT} strokeWidth={2} strokeLinejoin="round" />

      {points.map((p) => (
        <g key={p.x}>
          <title>{p.hint ?? `${p.label ?? p.x}: ${formatY(p.y)}`}</title>
          {/* Generous invisible hit target, small visible marker. */}
          <circle cx={scaleX(p.x)} cy={scaleY(p.y)} r={10} fill="transparent" />
          <circle
            cx={scaleX(p.x)}
            cy={scaleY(p.y)}
            r={4}
            fill={ACCENT}
            stroke="var(--color-surface)"
            strokeWidth={2}
          />
          <text
            x={scaleX(p.x)}
            y={VB_H - 8}
            fontSize={10}
            textAnchor="middle"
            fill={INK_FAINT}
          >
            {p.label ?? p.x}
          </text>
        </g>
      ))}
    </svg>
  );
}

/** A headline number with its label. Not a chart — a chart of one value is noise. */
export function StatTile({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "default" | "warning" | "danger";
}) {
  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-3">
      <div className="eyebrow">{label}</div>
      <div
        className={cn(
          "mt-1 font-mono text-xl tabular-nums",
          tone === "default" && "text-ink",
          tone === "warning" && "text-warning",
          tone === "danger" && "text-danger",
        )}
      >
        {value}
      </div>
      {hint ? <div className="mt-0.5 text-xs text-ink-muted">{hint}</div> : null}
    </div>
  );
}

/** A capped meter: used vs cap, with the over-cap state called out in words. */
export function CapMeter({
  label,
  used,
  cap,
  format,
}: {
  label: string;
  used: number;
  cap: number | null;
  format: (value: number) => string;
}) {
  const pct = cap && cap > 0 ? Math.min(1, used / cap) : null;
  const over = cap !== null && used >= cap;

  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs uppercase tracking-wide text-ink-faint">{label}</span>
        <span className="font-mono text-xs tabular-nums text-ink">
          {format(used)}
          {cap !== null ? ` / ${format(cap)}` : ""}
        </span>
      </div>
      {pct === null ? (
        <p className="text-xs text-ink-faint">No cap set by the commissioner.</p>
      ) : (
        <>
          <svg width="100%" height={8} role="img" aria-label={`${label} usage`}>
            <title>{`${format(used)} of ${format(cap!)}`}</title>
            <rect x={0} y={0} width="100%" height={8} rx={4} fill={TRACK} />
            <rect
              x={0}
              y={0}
              width={`${Math.max(1, pct * 100)}%`}
              height={8}
              rx={4}
              fill={over ? "var(--color-danger)" : pct > 0.8 ? "var(--color-warning)" : ACCENT}
            />
          </svg>
          {over ? <p className="text-xs text-danger">Over cap.</p> : null}
        </>
      )}
    </div>
  );
}
