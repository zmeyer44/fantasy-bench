/**
 * Trace list / detail / search (PRD 5.8). Traces are public within the league
 * and to spectators, so these are `leagueReadProcedure`.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import {
  TRACE_PAGE_SIZE,
  trace,
  traceList,
  traceModelOptions,
  teamTracesExport,
  traceExport,
} from "@/lib/services/views";
import { leagueReadProcedure, router } from "@/lib/trpc/init";

const windowTypeSchema = z.enum(["draft", "waiver", "trade", "lineup", "forum", "commissioner"]);
const runStatusSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "partial",
  "failed",
  "timed_out",
  "fallback",
  "skipped",
]);

export const traceFiltersSchema = z.object({
  teamId: z.uuid().optional(),
  windowType: windowTypeSchema.optional(),
  weekNo: z.number().int().min(1).max(18).optional(),
  status: runStatusSchema.optional(),
  modelId: z.string().min(1).max(120).optional(),
  q: z.string().max(200).optional(),
  page: z.number().int().min(1).max(500).default(1),
  pageSize: z.number().int().min(1).max(100).default(TRACE_PAGE_SIZE),
});

export const tracesRouter = router({
  list: leagueReadProcedure
    .input(traceFiltersSchema)
    .query(async ({ ctx, input }) => traceList({ ...input, leagueId: ctx.league.id })),

  /** Same shape as `list`; exists so the search box reads as its own call site. */
  search: leagueReadProcedure
    .input(traceFiltersSchema.extend({ q: z.string().min(1).max(200) }))
    .query(async ({ ctx, input }) => traceList({ ...input, leagueId: ctx.league.id })),

  get: leagueReadProcedure
    .input(z.object({ runId: z.uuid() }))
    .query(async ({ ctx, input }) => {
      const detail = await trace(input.runId);
      if (!detail) throw new TRPCError({ code: "NOT_FOUND", message: "Run not found" });
      if (detail.run.leagueId !== ctx.league.id) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Run not found in this league" });
      }
      return detail;
    }),

  modelOptions: leagueReadProcedure.query(async ({ ctx }) => traceModelOptions(ctx.league.id)),

  export: leagueReadProcedure
    .input(z.object({ runId: z.uuid() }))
    .query(async ({ ctx, input }) => {
      const payload = await traceExport(input.runId);
      if (!payload || payload.trace.run.leagueId !== ctx.league.id) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Run not found" });
      }
      return payload;
    }),

  exportTeam: leagueReadProcedure
    .input(z.object({ teamId: z.uuid() }))
    .query(async ({ ctx, input }) => {
      const payload = await teamTracesExport(input.teamId);
      if (!payload || payload.team.leagueId !== ctx.league.id) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Team not found" });
      }
      return payload;
    }),
});
