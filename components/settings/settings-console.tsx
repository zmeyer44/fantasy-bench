"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui";

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
 * The commissioner console. One client component so tab state survives a save
 * (each form's mutation calls `router.refresh()`, which re-renders the server
 * page beneath without unmounting the tab).
 */
export function SettingsConsole({ data }: { data: SettingsData }) {
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
