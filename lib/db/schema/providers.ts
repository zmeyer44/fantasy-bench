/**
 * Owner- or commissioner-registered external data sources.
 *
 * A downstream work package turns each enabled row into a custom AI SDK tool
 * exposed to that league's (or that team's) agent. Nothing here executes yet.
 */
import { relations } from "drizzle-orm";
import {
  boolean,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { user } from "./auth";
import { leagues, teams } from "./league";

export const customProviderKindEnum = pgEnum("custom_provider_kind", ["http_json"]);

export type HttpJsonProviderConfig = {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  /** Dot path into the JSON response to hand back to the agent. */
  jsonPath?: string;
  /** Tool description shown to the model. */
  description?: string;
};

/** `league_id = null` means a global provider available to every league. */
export const customProviders = pgTable(
  "custom_providers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leagueId: uuid("league_id").references(() => leagues.id, { onDelete: "cascade" }),
    teamId: uuid("team_id").references(() => teams.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: customProviderKindEnum("kind").notNull().default("http_json"),
    config: jsonb("config").$type<HttpJsonProviderConfig>().notNull(),
    enabled: boolean("enabled").notNull().default(true),
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("custom_providers_league_idx").on(t.leagueId),
    index("custom_providers_team_idx").on(t.teamId),
  ],
);

export const customProvidersRelations = relations(customProviders, ({ one }) => ({
  league: one(leagues, { fields: [customProviders.leagueId], references: [leagues.id] }),
  team: one(teams, { fields: [customProviders.teamId], references: [teams.id] }),
  createdBy: one(user, { fields: [customProviders.createdByUserId], references: [user.id] }),
}));
