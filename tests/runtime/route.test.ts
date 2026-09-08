import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import { runs } from "@/lib/db/schema";
import { POST } from "@/app/api/runs/[runId]/execute/route";
import { resetMockModelState } from "@/lib/agent/mock-model";

import { truncateAll } from "../setup";
import { seedFixture, seedMockModelPrice } from "./fixtures";

const SECRET = process.env.INTERNAL_SECRET ?? "test-internal-secret";

function post(runId: string, token = SECRET): [Request, { params: Promise<{ runId: string }> }] {
  return [
    new Request(`http://localhost/api/runs/${runId}/execute`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    }),
    { params: Promise.resolve({ runId }) },
  ];
}

describe("POST /api/runs/[runId]/execute", () => {
  beforeEach(async () => {
    await truncateAll();
    resetMockModelState();
    await seedMockModelPrice();
  });

  it("rejects a request without the internal secret", async () => {
    const fx = await seedFixture();
    const response = await POST(...post(fx.runId, "wrong-secret"));
    expect(response.status).toBe(401);
  });

  it("404s an unknown run", async () => {
    const response = await POST(...post("00000000-0000-4000-8000-000000000000"));
    expect(response.status).toBe(404);
  });

  it("400s a malformed run id", async () => {
    const response = await POST(...post("not-a-uuid"));
    expect(response.status).toBe(400);
  });

  it("claims and executes a pending run", async () => {
    const fx = await seedFixture();
    const response = await POST(...post(fx.runId));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; outcome: string; executed: boolean };
    expect(body.status).toBe("succeeded");
    expect(body.outcome).toContain("lineup_set");
    expect(body.executed).toBe(true);
  });

  it("409s when another tick already claimed the run", async () => {
    const fx = await seedFixture();
    // Simulate a competing claim that has not finished yet: mark it running with a
    // status the route treats as "someone else has it" by racing two claims.
    await db.update(runs).set({ status: "pending" }).where(eq(runs.id, fx.runId));
    const [first, second] = await Promise.all([
      POST(...post(fx.runId)),
      POST(...post(fx.runId)),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);
  });

  it("returns the stored summary for an already-finished run", async () => {
    const fx = await seedFixture();
    await POST(...post(fx.runId));
    const again = await POST(...post(fx.runId));
    expect(again.status).toBe(200);
    const body = (await again.json()) as { alreadyFinished: boolean; executed: boolean };
    expect(body.alreadyFinished).toBe(true);
    expect(body.executed).toBe(false);
  });
});
