/**
 * Config read models.
 *
 * Everything here is PUBLIC WITHIN THE LEAGUE (PRD 5.5 / 7): configs, version
 * history and diffs are visible to every member and to spectators of a public
 * league. None of these functions take a viewer — do not add an ownership check.
 */
import { and, asc, desc, eq, inArray, lt } from "drizzle-orm";

import { db, type DbOrTx } from "@/lib/db";
import {
  agentConfigs,
  configVersionSkills,
  configVersions,
  leagueRules,
  leagues,
  skills,
  teams,
  user,
} from "@/lib/db/schema";
import type { AgentConfig, ConfigVersion, League, LeagueRules, Skill, Team } from "@/lib/db/types";
import { findModel } from "@/lib/models";
import {
  DEFAULT_EDIT_LOCK,
  isWithinEditWindow,
  nextWeekdayAtET,
  weekStartET,
  WEEKDAYS,
  type EditLock,
  type Weekday,
} from "@/lib/time";

import { ConfigNotFoundError } from "./errors";
import { parseHarness, type HarnessSettings } from "./harness";

export type ConfigVersionWithSkills = ConfigVersion & {
  skills: Skill[];
  harness: HarnessSettings;
};

export type ConfigVersionSummary = ConfigVersion & {
  harness: HarnessSettings;
  createdByName: string | null;
  skillCount: number;
  isCurrent: boolean;
  isPending: boolean;
  /** Created on or after the current NFL week's Tuesday 06:00 ET boundary. */
  changedThisWeek: boolean;
  modelDisplayName: string;
};

/** Attached skills for a set of version ids, ordered by injection position. */
async function skillsByVersion(
  versionIds: string[],
  executor: DbOrTx,
): Promise<Map<string, Skill[]>> {
  const out = new Map<string, Skill[]>();
  if (versionIds.length === 0) return out;

  const rows = await executor
    .select({ versionId: configVersionSkills.configVersionId, skill: skills })
    .from(configVersionSkills)
    .innerJoin(skills, eq(skills.id, configVersionSkills.skillId))
    .where(inArray(configVersionSkills.configVersionId, versionIds))
    .orderBy(asc(configVersionSkills.position), asc(skills.name));

  for (const row of rows) {
    const list = out.get(row.versionId) ?? [];
    list.push(row.skill);
    out.set(row.versionId, list);
  }
  return out;
}

async function hydrateVersion(
  version: ConfigVersion,
  executor: DbOrTx,
): Promise<ConfigVersionWithSkills> {
  const map = await skillsByVersion([version.id], executor);
  return { ...version, harness: parseHarness(version.harness), skills: map.get(version.id) ?? [] };
}

/**
 * The applied config version for a team, plus its attached skills in injection
 * order and a fully-defaulted harness. Null when the team has no config yet.
 *
 * This is the runtime's entry point — `lib/agent` calls it at prompt assembly.
 */
export async function getCurrentConfigVersion(
  teamId: string,
  executor: DbOrTx = db,
): Promise<ConfigVersionWithSkills | null> {
  const config = await executor.query.agentConfigs.findFirst({
    where: eq(agentConfigs.teamId, teamId),
  });
  if (!config?.currentVersionId) return null;

  const version = await executor.query.configVersions.findFirst({
    where: eq(configVersions.id, config.currentVersionId),
  });
  if (!version) return null;

  return hydrateVersion(version, executor);
}

export type TeamConfigView = {
  team: Team;
  league: League;
  rules: LeagueRules | null;
  config: AgentConfig;
  current: ConfigVersionWithSkills | null;
  pending: ConfigVersionWithSkills | null;
  versions: ConfigVersionSummary[];
};

/** Everything the config page needs: the row, its current + pending versions, and history. */
export async function getConfigForTeam(
  teamId: string,
  executor: DbOrTx = db,
): Promise<TeamConfigView> {
  const team = await executor.query.teams.findFirst({ where: eq(teams.id, teamId) });
  if (!team) throw new ConfigNotFoundError(`Team ${teamId} not found`);

  const league = await executor.query.leagues.findFirst({ where: eq(leagues.id, team.leagueId) });
  if (!league) throw new ConfigNotFoundError(`League ${team.leagueId} not found`);

  const rules =
    (await executor.query.leagueRules.findFirst({
      where: eq(leagueRules.leagueId, team.leagueId),
    })) ?? null;

  const config = await ensureAgentConfig(teamId, executor);

  const [current, pending] = await Promise.all([
    config.currentVersionId ? getVersion(config.currentVersionId, executor) : Promise.resolve(null),
    config.pendingVersionId ? getVersion(config.pendingVersionId, executor) : Promise.resolve(null),
  ]);

  return {
    team,
    league,
    rules,
    config,
    current,
    pending,
    versions: await listVersions(config.id, executor),
  };
}

/** The team's `agent_configs` row, created on first read if a team predates it. */
export async function ensureAgentConfig(
  teamId: string,
  executor: DbOrTx = db,
): Promise<AgentConfig> {
  const existing = await executor.query.agentConfigs.findFirst({
    where: eq(agentConfigs.teamId, teamId),
  });
  if (existing) return existing;

  await executor
    .insert(agentConfigs)
    .values({ teamId })
    .onConflictDoNothing({ target: agentConfigs.teamId });

  const created = await executor.query.agentConfigs.findFirst({
    where: eq(agentConfigs.teamId, teamId),
  });
  if (!created) throw new ConfigNotFoundError(`Could not create agent config for team ${teamId}`);
  return created;
}

/** Version history for a config, newest first. Public within the league. */
export async function listVersions(
  configId: string,
  executor: DbOrTx = db,
): Promise<ConfigVersionSummary[]> {
  const config = await executor.query.agentConfigs.findFirst({
    where: eq(agentConfigs.id, configId),
  });

  const rows = await executor
    .select({ version: configVersions, authorName: user.name })
    .from(configVersions)
    .leftJoin(user, eq(user.id, configVersions.createdByUserId))
    .where(eq(configVersions.configId, configId))
    .orderBy(desc(configVersions.versionNo));

  const counts = await skillsByVersion(
    rows.map((r) => r.version.id),
    executor,
  );

  const weekStart = weekStartET(new Date());

  return rows.map(({ version, authorName }) => ({
    ...version,
    harness: parseHarness(version.harness),
    createdByName: authorName ?? null,
    skillCount: counts.get(version.id)?.length ?? 0,
    isCurrent: config?.currentVersionId === version.id,
    isPending: config?.pendingVersionId === version.id,
    changedThisWeek: version.createdAt.getTime() >= weekStart.getTime(),
    modelDisplayName: findModel(version.modelId)?.displayName ?? version.modelId,
  }));
}

/** One version, hydrated with its skills. */
export async function getVersion(
  versionId: string,
  executor: DbOrTx = db,
): Promise<ConfigVersionWithSkills | null> {
  const version = await executor.query.configVersions.findFirst({
    where: eq(configVersions.id, versionId),
  });
  if (!version) return null;
  return hydrateVersion(version, executor);
}

/** The version immediately preceding `version` in the same config, if any. */
export async function getPreviousVersion(
  version: ConfigVersion,
  executor: DbOrTx = db,
): Promise<ConfigVersionWithSkills | null> {
  const [prior] = await executor
    .select()
    .from(configVersions)
    .where(
      and(
        eq(configVersions.configId, version.configId),
        lt(configVersions.versionNo, version.versionNo),
      ),
    )
    .orderBy(desc(configVersions.versionNo))
    .limit(1);

  if (!prior) return null;
  return hydrateVersion(prior, executor);
}

/** Team + league context for a version — used by the diff pages for breadcrumbs. */
export async function getVersionContext(versionId: string, executor: DbOrTx = db) {
  const row = await executor
    .select({ version: configVersions, config: agentConfigs, team: teams, league: leagues })
    .from(configVersions)
    .innerJoin(agentConfigs, eq(agentConfigs.id, configVersions.configId))
    .innerJoin(teams, eq(teams.id, agentConfigs.teamId))
    .innerJoin(leagues, eq(leagues.id, teams.leagueId))
    .where(eq(configVersions.id, versionId))
    .limit(1);
  return row[0] ?? null;
}

// ------------------------------------------------------------------ edit lock

function isWeekday(value: string): value is Weekday {
  return (WEEKDAYS as readonly string[]).includes(value);
}

/** Coerce the jsonb `edit_lock` blob into the shape `lib/time.ts` expects. */
export function toEditLock(value: unknown): EditLock {
  const raw = (value ?? {}) as Record<string, unknown>;
  const unlockDay = typeof raw.unlockDay === "string" && isWeekday(raw.unlockDay)
    ? raw.unlockDay
    : DEFAULT_EDIT_LOCK.unlockDay;
  const lockDay = typeof raw.lockDay === "string" && isWeekday(raw.lockDay)
    ? raw.lockDay
    : DEFAULT_EDIT_LOCK.lockDay;
  const time = (v: unknown, fallback: string) =>
    typeof v === "string" && /^\d{1,2}:\d{2}$/.test(v.trim()) ? v.trim() : fallback;
  return {
    unlockDay,
    unlockTime: time(raw.unlockTime, DEFAULT_EDIT_LOCK.unlockTime),
    lockDay,
    lockTime: time(raw.lockTime, DEFAULT_EDIT_LOCK.lockTime),
  };
}

export type EditLockStatus = {
  /** True when configs are editable right now (saves apply immediately). */
  open: boolean;
  /** The next instant at which `open` flips. */
  nextChange: Date;
  lock: EditLock;
};

function hhmm(value: string): { hh: number; mm: number } {
  const [h, m] = value.split(":");
  return { hh: Number(h), mm: Number(m) };
}

/** Compute the edit-lock state for a league at `now`. */
export async function getEditLockStatus(
  leagueId: string,
  now: Date = new Date(),
  executor: DbOrTx = db,
): Promise<EditLockStatus> {
  const rules = await executor.query.leagueRules.findFirst({
    where: eq(leagueRules.leagueId, leagueId),
  });
  return editLockStatusFor(toEditLock(rules?.editLock), now);
}

/** Pure form — handy for tests and for callers that already hold the rules row. */
export function editLockStatusFor(lock: EditLock, now: Date): EditLockStatus {
  const open = isWithinEditWindow(now, lock);
  const target = open ? hhmm(lock.lockTime) : hhmm(lock.unlockTime);
  const day = open ? lock.lockDay : lock.unlockDay;
  // `nextWeekdayAtET` returns `now` when it sits exactly on the boundary; nudge
  // forward a minute so "next change" is always strictly in the future.
  const nextChange = nextWeekdayAtET(new Date(now.getTime() + 60_000), day, target.hh, target.mm);
  return { open, nextChange, lock };
}

/** Every team in a league that currently has a queued (pending) version. */
export async function listPendingConfigs(leagueId: string, executor: DbOrTx = db) {
  return executor
    .select({ config: agentConfigs, team: teams })
    .from(agentConfigs)
    .innerJoin(teams, eq(teams.id, agentConfigs.teamId))
    .where(and(eq(teams.leagueId, leagueId)))
    .orderBy(asc(teams.waiverPriority));
}
