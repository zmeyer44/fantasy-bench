/** Pair by slot occurrence so repeated RB/WR slots and missing opponents stay aligned. */
export function pairMatchupSlots<T extends { slot: string }>(
  away: T[],
  home: T[],
) {
  const order = [
    "QB",
    "RB",
    "WR",
    "TE",
    "FLEX",
    "SUPERFLEX",
    "K",
    "DEF",
    "BENCH",
    "IR",
  ];
  const keySlots = (slots: T[]) => {
    const counts = new Map<string, number>();
    return slots.map((slot) => {
      const label = slot.slot.replace(/\d+$/, "");
      const index = counts.get(label) ?? 0;
      counts.set(label, index + 1);
      return { key: `${label}:${index}`, slot };
    });
  };
  const a = keySlots(away),
    h = keySlots(home);
  const am = new Map(a.map((row) => [row.key, row.slot])),
    hm = new Map(h.map((row) => [row.key, row.slot]));
  const rank = (key: string) => {
    const index = order.indexOf(key.split(":")[0]);
    return index < 0 ? order.length : index;
  };
  return [...new Set([...a, ...h].map((row) => row.key))]
    .sort((x, y) => rank(x) - rank(y))
    .map((key) => ({
      key,
      label: key.split(":")[0],
      away: am.get(key),
      home: hm.get(key),
    }));
}
