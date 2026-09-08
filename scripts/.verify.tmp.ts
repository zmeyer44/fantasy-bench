import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";

const c = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
const secret = process.env.SEED_SECRET!;

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function uuids(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") { if (ID.test(v)) out.push(v); }
  else if (Array.isArray(v)) v.forEach((x) => uuids(x, out));
  else if (v && typeof v === "object") Object.entries(v).forEach(([k, x]) => { if (ID.test(k)) out.push(k); uuids(x, out); });
  return out;
}

async function main() {
  const rows = await c.query(api.seed.readTableSample, { secret, table: "snapshot_chunks", limit: 40 });
  console.log("snapshot_chunks leftover uuids:", rows.flatMap((r: any) => uuids(r.data)).length);
  const meta = rows.find((r: any) => r.kind === "meta") as any;
  console.log("meta.leagueId:", meta.data.leagueId);
  console.log("meta.teams[0].id:", meta.data.teams[0].id, "ownerUserId:", meta.data.teams[0].ownerUserId);
  console.log("meta.teams[0].rosterPlayerIds[0]:", meta.data.teams[0].rosterPlayerIds[0]);
  console.log("meta.teams[0].lineup[0]:", JSON.stringify(meta.data.teams[0].lineup[0]));
  console.log("meta.standings[0].teamId:", meta.data.standings[0].teamId);
  console.log("meta.matchups[0]:", meta.data.matchups[0].homeTeamId, meta.data.matchups[0].awayTeamId);
  console.log("meta.freeAgentIds[0]:", meta.data.freeAgentIds[0]);
  const playersChunk = rows.find((r: any) => r.kind === "players") as any;
  const k = Object.keys(playersChunk.data)[0];
  console.log("players chunk key:", k, "-> .id:", playersChunk.data[k].id, "ownerTeamId:", playersChunk.data[k].ownerTeamId);

  const acts = await c.query(api.seed.readTableSample, { secret, table: "run_actions", limit: 100 });
  console.log("run_actions leftover uuids:", acts.flatMap((r: any) => [...uuids(r.payload), ...uuids(r.result)]).length);
  const waiver = acts.find((a: any) => a.actionType === "submit_waiver_claims") as any;
  console.log("waiver payload:", JSON.stringify(waiver.payload).slice(0, 200));
  console.log("waiver result :", JSON.stringify(waiver.result).slice(0, 200));
  const trade = acts.find((a: any) => a.actionType === "propose_trade") as any;
  console.log("propose_trade result:", JSON.stringify(trade.result));

  const ev = await c.query(api.seed.readTableSample, { secret, table: "trade_events", limit: 20 });
  console.log("trade_events leftover uuids:", ev.flatMap((r: any) => uuids(r.payload)).length);
  console.log("trade_events[0].payload:", JSON.stringify(ev[0].payload));

  const tx = await c.query(api.seed.readTableSample, { secret, table: "transactions", limit: 200 });
  console.log("transactions leftover uuids:", tx.flatMap((r: any) => uuids(r.details)).length);
  console.log("waiver tx details:", JSON.stringify(tx.find((r: any) => r.type === "add" && r.details?.claimId)?.details));

  const lu = await c.query(api.seed.readTableSample, { secret, table: "lineups", limit: 30 });
  console.log("lineups leftover uuids:", lu.flatMap((r: any) => uuids(r.slots)).length);

  const th = await c.query(api.seed.readTableSample, { secret, table: "threads", limit: 10 });
  console.log("threads flaggedCount:", th.map((r: any) => `${r.messageCount}/${r.flaggedCount}`).join(" "));

  // chronological ordering
  for (const table of ["trades", "trade_events", "messages", "forum_posts", "runs", "run_steps"]) {
    const r = await c.query(api.seed.readTableSample, { secret, table: table as never, limit: 300 });
    const ok = r.every((row: any, i: number) => i === 0 || row._creationTime >= r[i - 1]._creationTime);
    console.log(`${table}: _creationTime ascending in insert order = ${ok} (n=${r.length})`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
