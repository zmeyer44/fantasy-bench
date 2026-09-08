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
 * `commissioner.settings` is preloaded on the server and then lives here — it
 * carries the roster for the Teams tab too — so a saved rule, a rotated join
 * code or an owner assignment shows up as soon as the mutation lands: no
 * `router.refresh()`, and the open tab is never unmounted. The tabs write with
 * Convex mutations, so the console re-renders from the same subscription.
 */
export function SettingsConsole({
  preloadedSettings,
}: {
  preloadedSettings: Preloaded<typeof api.commissioner.settings>;
}) {
  const settings = usePreloadedQuery(preloadedSettings);

  const data: SettingsData = {
    ...settings,
    league: { ...settings.league, id: settings.league._id },
  };

  return (
    <Tabs defaultValue="league" className="gap-0">
      <TabsList
        variant="line"
        className="h-auto! w-full justify-start gap-4 overflow-x-auto border-b border-border pb-[5px] *:flex-none"
      >
        <TabsTrigger value="league">League</TabsTrigger>
        <TabsTrigger value="rules">Rules</TabsTrigger>
        <TabsTrigger value="models">Models</TabsTrigger>
        <TabsTrigger value="budgets">Budgets</TabsTrigger>
        <TabsTrigger value="windows">Windows</TabsTrigger>
        <TabsTrigger value="conduct">Conduct</TabsTrigger>
        <TabsTrigger value="teams">Teams</TabsTrigger>
        <TabsTrigger value="log">Change log</TabsTrigger>
      </TabsList>

      <TabsContent value="league" className="pt-8">
        <LeagueTab data={data} />
      </TabsContent>
      <TabsContent value="rules" className="pt-8">
        <RulesTab data={data} />
      </TabsContent>
      <TabsContent value="models" className="pt-8">
        <ModelsTab data={data} />
      </TabsContent>
      <TabsContent value="budgets" className="pt-8">
        <BudgetsTab data={data} />
      </TabsContent>
      <TabsContent value="windows" className="pt-8">
        <WindowsTab data={data} />
      </TabsContent>
      <TabsContent value="conduct" className="pt-8">
        <ConductTab data={data} />
      </TabsContent>
      <TabsContent value="teams" className="pt-8">
        <TeamsTab data={data} />
      </TabsContent>
      <TabsContent value="log" className="pt-8">
        <ChangeLogTab data={data} />
      </TabsContent>
    </Tabs>
  );
}
