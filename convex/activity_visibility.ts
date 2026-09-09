/**
 * Live visibility for sensitive rows retained in paged activity history.
 *
 * Historical activity pages are fetched imperatively, so their post/message
 * payloads cannot be trusted after moderation, ownership, or transparency
 * changes. Clients subscribe to this bounded query and apply only these fresh
 * database-backed decisions to cached sensitive events.
 */
import { v } from "convex/values";

import { query } from "./_generated/server";
import { requireLeagueRead, viewerTeamIds } from "./lib/auth";
import { appError } from "./lib/errors";
import { isThreadRevealed, isUnresolvedTradeStatus } from "./lib/social_pure";

const MAX_SENSITIVE_EVENTS = 100;

type VisibilityEntry = {
  id: string;
  visible: boolean;
  body: string | null;
};

/** Revalidate cached `forum_posts/<id>` and `messages/<id>` activity events. */
export const current = query({
  args: { leagueId: v.id("leagues"), ids: v.array(v.string()) },
  returns: v.array(
    v.object({
      id: v.string(),
      visible: v.boolean(),
      body: v.union(v.string(), v.null()),
    }),
  ),
  handler: async (ctx, { leagueId, ids }): Promise<VisibilityEntry[]> => {
    const access = await requireLeagueRead(ctx, leagueId);
    if (ids.length > MAX_SENSITIVE_EVENTS) {
      throw appError(
        "BAD_REQUEST",
        `At most ${MAX_SENSITIVE_EVENTS} sensitive activity events may be checked at once.`,
      );
    }

    const now = Date.now();
    const rules = await ctx.db
      .query("league_rules")
      .withIndex("by_leagueId", (q) => q.eq("leagueId", leagueId))
      .unique();
    const ownedTeamIds = (await viewerTeamIds(
      ctx,
      leagueId,
      access.viewer,
    )) as unknown as string[];
    const threadVisibility = new Map<string, { revealed: boolean } | null>();

    const unavailable = (id: string): VisibilityEntry => ({
      id,
      visible: false,
      body: null,
    });

    const entries: VisibilityEntry[] = [];
    for (const id of ids) {
      const [source, rawId, extra] = id.split("/");
      if (!rawId || extra !== undefined) {
        entries.push(unavailable(id));
        continue;
      }

      if (source === "forum_posts") {
        const postId = ctx.db.normalizeId("forum_posts", rawId);
        const post = postId ? await ctx.db.get("forum_posts", postId) : null;
        entries.push({
          id,
          visible: Boolean(post && post.leagueId === leagueId && !post.hidden),
          body: null,
        });
        continue;
      }

      if (source !== "messages") {
        entries.push(unavailable(id));
        continue;
      }

      const messageId = ctx.db.normalizeId("messages", rawId);
      const message = messageId ? await ctx.db.get("messages", messageId) : null;
      if (!message || message.leagueId !== leagueId) {
        entries.push(unavailable(id));
        continue;
      }

      const threadKey = message.threadId as string;
      let state = threadVisibility.get(threadKey);
      if (state === undefined) {
        const thread = await ctx.db.get("threads", message.threadId);
        if (!thread || thread.leagueId !== leagueId) {
          state = null;
        } else {
          const window = thread.createdInWindowId
            ? await ctx.db.get("windows", thread.createdInWindowId)
            : null;
          const trades = await ctx.db
            .query("trades")
            .withIndex("by_threadId", (q) => q.eq("threadId", thread._id))
            .take(20);
          const reveal = isThreadRevealed({
            transparencyMode: rules?.transparencyMode ?? "live",
            windowClosesAt: window?.closesAt ?? null,
            windowStatus: window?.status ?? null,
            viewerTeamIds: ownedTeamIds,
            threadTeams: [thread.teamAId as string, thread.teamBId as string],
            hasUnresolvedTrade: trades.some((trade) =>
              isUnresolvedTradeStatus(trade.status),
            ),
            isCommissioner: access.isCommissioner,
            now,
          });
          state = { revealed: reveal.revealed };
        }
        threadVisibility.set(threadKey, state);
      }

      entries.push(
        state
          ? {
              id,
              visible: true,
              body: state.revealed ? message.body : null,
            }
          : unavailable(id),
      );
    }

    return entries;
  },
});
