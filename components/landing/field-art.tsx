/**
 * Aerial field plate for the "How it works" section: blue-tinted turf, yard
 * lines, hash marks, and a scatter of positions with one lime X. Decorative.
 */
export function FieldArt() {
  const yards = [0, 1, 2, 3, 4, 5, 6, 7, 8];
  return (
    <svg
      viewBox="0 0 640 480"
      className="size-full"
      aria-hidden="true"
      preserveAspectRatio="xMidYMid slice"
    >
      <defs>
        <pattern id="field-hash" width="80" height="12" patternUnits="userSpaceOnUse">
          <path d="M0 6h6" stroke="oklch(1 0 0 / 30%)" strokeWidth="2" />
        </pattern>
        <linearGradient id="field-fade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#0d1a5c" />
          <stop offset="1" stopColor="#0a0f2e" />
        </linearGradient>
      </defs>
      <rect width="640" height="480" fill="url(#field-fade)" />
      <rect width="640" height="480" fill="var(--blue)" opacity="0.28" />
      {yards.map((i) => (
        <path key={i} d={`M${i * 80} 0v480`} stroke="oklch(1 0 0 / 28%)" strokeWidth={i % 2 ? 1 : 2} />
      ))}
      <rect x="0" y="150" width="640" height="12" fill="url(#field-hash)" />
      <rect x="0" y="320" width="640" height="12" fill="url(#field-hash)" />
      <g
        fill="none"
        stroke="var(--blue-strong)"
        strokeWidth="2"
        className="display"
        fontSize="64"
        fontStyle="italic"
      >
        <text x="112" y="270" fill="none" stroke="var(--blue-strong)" textAnchor="middle" transform="skewX(-12)">
          30
        </text>
        <text x="360" y="270" fill="none" stroke="var(--blue-strong)" textAnchor="middle" transform="skewX(-12)">
          40
        </text>
        <text x="600" y="270" fill="none" stroke="var(--blue-strong)" textAnchor="middle" transform="skewX(-12)">
          50
        </text>
      </g>
      <path d="M0 240h640" stroke="oklch(1 0 0 / 18%)" strokeDasharray="2 10" />
      <g fill="oklch(1 0 0 / 70%)">
        {[
          [88, 76],
          [140, 120],
          [212, 92],
          [246, 168],
          [318, 128],
          [356, 96],
          [438, 154],
          [520, 110],
          [96, 356],
          [178, 402],
          [292, 372],
          [402, 342],
          [466, 412],
          [560, 380],
        ].map(([x, y]) => (
          <circle key={`${x}-${y}`} cx={x} cy={y} r="4" />
        ))}
      </g>
      <path d="M338 214l20 20m0-20l-20 20" stroke="var(--brand)" strokeWidth="5" strokeLinecap="square" />
      <path d="M338 224c40-30 90-30 130 0" stroke="oklch(1 0 0 / 40%)" strokeDasharray="4 6" fill="none" />
    </svg>
  );
}
