"use client";

import { usePreloadedQuery, type Preloaded } from "convex/react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui";
import type { api } from "@/convex/_generated/api";

import { BudgetsTab } from "./budgets-tab";
import { ChangeLogTab } from "./change-log-tab";
import { ConductTab } from "./conduct-tab";
import { LeagueTab } from "./league-tab";
import { ModelsTab } from "./models-tab";
import { RulesTab } from "./rules-tab";
import { TeamsTab } from "./teams-tab";
import { WindowsTab } from "./windows-tab";
import type { SettingsData } from "./types";

/**
 * The commissioner console.
 *
 * Both reads are preloaded on the server and then live here, so a saved rule,
 * a rotated join code or an owner assignment shows up as soon as the mutation
 * lands — no `router.refresh()`, and the open tab is never unmounted.
 *
 * The tabs still mutate over tRPC (Phase 3 moves them to Convex mutations).
 */
export function SettingsConsole({
  preloadedSettings,
  preloadedTeams,
}: {
  preloadedSettings: Preloaded<typeof api.commissioner.settings>;
  preloadedTeams: Preloaded<typeof api.views.teams>;
}) {
  const settings = usePreloadedQuery(preloadedSettings);
  const teams = usePreloadedQuery(preloadedTeams);

  const data: SettingsData = {
    ...settings,
    league: { ...settings.league, id: settings.league._id },
    teams: teams.map((team) => ({
      id: team.id,
      name: team.name,
      abbreviation: team.abbreviation,
      ownerUserId: team.ownerUserId,
      ownerName: team.ownerName,
      // `views.teams` does not expose owner emails; the badge falls back to the name.
      ownerEmail: null,
      modelId: team.modelId,
      configVersionNo: team.configVersionNo,
    })),
  };

  return (
    <Tabs defaultValue="league">
      <TabsList className="overflow-x-auto">
        <TabsTrigger value="league">League</TabsTrigger>
        <TabsTrigger value="rules">Rules</TabsTrigger>
        <TabsTrigger value="models">Models</TabsTrigger>
        <TabsTrigger value="budgets">Budgets</TabsTrigger>
        <TabsTrigger value="windows">Windows</TabsTrigger>
        <TabsTrigger value="conduct">Conduct</TabsTrigger>
        <TabsTrigger value="teams">Teams</TabsTrigger>
        <TabsTrigger value="log">Change log</TabsTrigger>
      </TabsList>

      <TabsContent value="league">
        <LeagueTab data={data} />
      </TabsContent>
      <TabsContent value="rules">
        <RulesTab data={data} />
      </TabsContent>
      <TabsContent value="models">
        <ModelsTab data={data} />
      </TabsContent>
      <TabsContent value="budgets">
        <BudgetsTab data={data} />
      </TabsContent>
      <TabsContent value="windows">
        <WindowsTab data={data} />
      </TabsContent>
      <TabsContent value="conduct">
        <ConductTab data={data} />
      </TabsContent>
      <TabsContent value="teams">
        <TeamsTab data={data} />
      </TabsContent>
      <TabsContent value="log">
        <ChangeLogTab data={data} />
      </TabsContent>
    </Tabs>
  );
}
