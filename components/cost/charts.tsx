import { cn } from "@/components/ui";

/**
 * Inline SVG charts. No chart library, no client JS.
 *
 * Every chart here plots ONE measure, so there is no categorical palette to get
 * wrong: magnitude is carried by length from a zero baseline, identity is carried
 * by real text labels rather than by colour, and the single series wears one of
 * the two chart tokens — lime (`--chart-1`) for spend, the money story of this
 * page, and blue (`--chart-2`) for a second, informational series. Grid and
 * axis text are recessive by design. Hover detail rides on native SVG `<title>`,
 * which needs no runtime.
 */

const SERIES = {
  brand: "var(--chart-1)",
  blue: "var(--chart-2)",
} as const;

/** Which of the two chart tokens the series wears. */
export type ChartTone = keyof typeof SERIES;

const GRID = "var(--border)";
const AXIS = "var(--line-strong)";
const INK = "var(--foreground)";
const INK_MUTED = "var(--muted-foreground)";
const SURFACE = "var(--background)";
const MONO = "var(--font-mono)";

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

const ROW_HEIGHT = 36;
const BAR_HEIGHT = 10;
const BAR_RADIUS = 4;

/**
 * Horizontal bars, one row per category, sorted by the caller.
 *
 * Sized in CSS pixels with no `viewBox` so text keeps its real size at any
 * container width and the rounded data-ends stay circular. Bars are square
 * where they meet the zero baseline and rounded where the data stops, so the
 * eye reads length from a single edge.
 */
export function BarChart({
  data,
  tone = "brand",
  className,
  emptyLabel = "No spend recorded yet.",
}: {
  data: BarDatum[];
  tone?: ChartTone;
  className?: string;
  emptyLabel?: string;
}) {
  if (data.length === 0) {
    return <p className="py-6 text-sm text-muted-foreground">{emptyLabel}</p>;
  }

  const fill = SERIES[tone];
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
      {/* Zero baseline: every bar is measured from this edge. */}
      <line x1={0.5} x2={0.5} y1={0} y2={height} stroke={AXIS} strokeWidth={1} />

      {data.map((d, i) => {
        const top = i * ROW_HEIGHT;
        const barTop = top + 18;
        const pct = max > 0 && d.value > 0 ? (d.value / max) * 100 : 0;
        return (
          <g key={d.key}>
            <title>{d.hint ?? `${d.label}: ${d.display ?? d.value}`}</title>
            <text
              x={0}
              y={top + 11}
              fontSize={12}
              fill={d.emphasis ? INK : INK_MUTED}
              fontWeight={d.emphasis ? 500 : 400}
            >
              {d.label}
            </text>
            {/* Direct label at the row end — no legend, no axis needed. */}
            <text
              x="100%"
              y={top + 11}
              fontSize={11}
              textAnchor="end"
              fill={d.emphasis ? INK : INK_MUTED}
              fontFamily={MONO}
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {d.display ?? String(d.value)}
            </text>
            {pct > 0 ? (
              <>
                <rect
                  x={0}
                  y={barTop}
                  width={`${pct}%`}
                  height={BAR_HEIGHT}
                  rx={BAR_RADIUS}
                  fill={fill}
                />
                {/* Squares off the baseline end; also the minimum visible mark. */}
                <rect x={0} y={barTop} width={BAR_RADIUS} height={BAR_HEIGHT} fill={fill} />
              </>
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
const PAD = { top: 20, right: 44, bottom: 26, left: 48 };

/**
 * Single-series line over an ordered x (league weeks). Uniform scaling, so the
 * markers stay round; the zero baseline is drawn one step stronger than the
 * gridlines and the final point is labelled directly.
 */
export function LineChart({
  points,
  formatY,
  tone = "brand",
  className,
  emptyLabel = "Not enough weeks yet to draw a trend.",
}: {
  points: LinePoint[];
  formatY: (value: number) => string;
  tone?: ChartTone;
  className?: string;
  emptyLabel?: string;
}) {
  if (points.length === 0) {
    return <p className="py-6 text-sm text-muted-foreground">{emptyLabel}</p>;
  }

  const stroke = SERIES[tone];
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

  const ticks = [1, 0.5, 0].map((t) => ({ t, value: maxY * t, y: scaleY(maxY * t) }));
  const last = points[points.length - 1];

  return (
    <svg
      viewBox={`0 0 ${VB_W} ${VB_H}`}
      className={cn("block w-full", className)}
      role="img"
      aria-label="Line chart"
    >
      {ticks.map((tick) => (
        <g key={tick.t}>
          <line
            x1={PAD.left}
            x2={VB_W - PAD.right}
            y1={tick.y}
            y2={tick.y}
            stroke={tick.t === 0 ? AXIS : GRID}
            strokeWidth={1}
          />
          <text
            x={PAD.left - 8}
            y={tick.y + 3}
            fontSize={10}
            textAnchor="end"
            fill={INK_MUTED}
            fontFamily={MONO}
            style={{ fontVariantNumeric: "tabular-nums" }}
          >
            {formatY(tick.value)}
          </text>
        </g>
      ))}

      <path
        d={path}
        fill="none"
        stroke={stroke}
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
      />

      {points.map((p) => (
        <g key={p.x}>
          <title>{p.hint ?? `${p.label ?? p.x}: ${formatY(p.y)}`}</title>
          {/* Generous invisible hit target, small visible marker. */}
          <circle cx={scaleX(p.x)} cy={scaleY(p.y)} r={10} fill="transparent" />
          <circle
            cx={scaleX(p.x)}
            cy={scaleY(p.y)}
            r={4}
            fill={stroke}
            stroke={SURFACE}
            strokeWidth={2}
          />
          <text
            x={scaleX(p.x)}
            y={VB_H - 8}
            fontSize={10}
            textAnchor="middle"
            fill={INK_MUTED}
            fontFamily={MONO}
          >
            {p.label ?? p.x}
          </text>
        </g>
      ))}

      {/* One direct label, on the point the reader is actually asking about. */}
      <text
        x={Math.min(scaleX(last.x) + 10, VB_W - 4)}
        y={scaleY(last.y) + 3}
        fontSize={11}
        fill={INK}
        fontFamily={MONO}
        style={{ fontVariantNumeric: "tabular-nums" }}
      >
        {formatY(last.y)}
      </text>
    </svg>
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
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="eyebrow">{label}</span>
        <span className="font-mono text-xs tabular-nums text-foreground">
          {format(used)}
          {cap !== null ? <span className="text-muted-foreground"> / {format(cap)}</span> : null}
        </span>
      </div>
      {pct === null ? (
        <p className="text-xs text-muted-foreground">No cap set by the commissioner.</p>
      ) : (
        <>
          <div
            role="progressbar"
            aria-label={label}
            aria-valuemin={0}
            aria-valuemax={cap ?? undefined}
            aria-valuenow={used}
            aria-valuetext={`${format(used)} of ${format(cap!)}`}
            className="h-1.5 w-full overflow-hidden rounded-sm bg-muted"
          >
            <div
              className={cn(
                "h-full rounded-sm",
                over ? "bg-destructive" : pct > 0.8 ? "bg-warning" : "bg-brand",
              )}
              style={{ width: `${Math.max(2, pct * 100)}%` }}
            />
          </div>
          {over ? <p className="text-xs text-destructive">Over cap.</p> : null}
        </>
      )}
    </div>
  );
}
