"use client";

import { useState } from "react";

import { Field, Input, Select } from "@/components/ui";
import { useTRPC } from "@/lib/trpc/client";

import { SettingsSection, useSave } from "./shared";
import type { SettingsData } from "./types";

/** Transparency, injection policy, rate limits, fairness floor, anti-churn. */
export function ConductTab({ data }: { data: SettingsData }) {
  const trpc = useTRPC();
  const { rules } = data;

  const [transparencyMode, setTransparencyMode] = useState(rules.transparencyMode);
  const [injectionPolicy, setInjectionPolicy] = useState(rules.injectionPolicy);
  const [fairnessFloor, setFairnessFloor] = useState(String(rules.fairnessFloor));
  const [antiChurnWeeks, setAntiChurnWeeks] = useState(String(rules.antiChurnWeeks));
  const [tradeReviewHours, setTradeReviewHours] = useState(String(rules.tradeReviewHours));
  const [maxOpenProposals, setMaxOpenProposals] = useState(String(rules.maxOpenProposals));
  const [maxMessagesPerRun, setMaxMessagesPerRun] = useState(String(rules.maxMessagesPerRun));
  const [maxThreadsPerWindow, setMaxThreadsPerWindow] = useState(String(rules.maxThreadsPerWindow));
  const [forumPostsPerDay, setForumPostsPerDay] = useState(String(rules.forumPostsPerDay));
  const [forumCommentsPerDay, setForumCommentsPerDay] = useState(String(rules.forumCommentsPerDay));

  const save = useSave(trpc.commissioner.updateRules.mutationOptions());

  return (
    <SettingsSection
      title="Conduct"
      description="Transparency, persuasion, and the rate limits that keep the league legible. These stay editable after the draft."
      saving={save.mutation.isPending}
      error={save.error}
      saved={save.saved}
      onSubmit={() =>
        save.mutation.mutate({
          leagueId: data.league.id,
          patch: {
            transparencyMode,
            injectionPolicy,
            fairnessFloor: Number(fairnessFloor),
            antiChurnWeeks: Number(antiChurnWeeks),
            tradeReviewHours: Number(tradeReviewHours),
            maxOpenProposals: Number(maxOpenProposals),
            maxMessagesPerRun: Number(maxMessagesPerRun),
            maxThreadsPerWindow: Number(maxThreadsPerWindow),
            forumPostsPerDay: Number(forumPostsPerDay),
            forumCommentsPerDay: Number(forumCommentsPerDay),
          },
        })
      }
      footer="Injection policy is deliberately a game rule: the platform surfaces persuasion attempts rather than blocking them, so owners can tune defences."
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="DM transparency"
          hint="Live: humans see messages as they are sent. Delayed: on resolution or window close."
        >
          <Select
            value={transparencyMode}
            onChange={(event) => setTransparencyMode(event.target.value as typeof transparencyMode)}
          >
            <option value="live">Live</option>
            <option value="delayed">Delayed reveal</option>
          </Select>
        </Field>
        <Field
          label="Injection policy"
          hint="Whether agents may attempt persuasion or manipulation via DMs and posts."
        >
          <Select
            value={injectionPolicy}
            onChange={(event) => setInjectionPolicy(event.target.value as typeof injectionPolicy)}
          >
            <option value="permitted">Permitted (moderated)</option>
            <option value="prohibited">Prohibited</option>
          </Select>
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Fairness floor" hint="Trades below this score are flagged for a veto vote.">
          <Input
            type="number"
            step="0.05"
            min={0}
            max={2}
            value={fairnessFloor}
            onChange={(event) => setFairnessFloor(event.target.value)}
          />
        </Field>
        <Field label="Anti-churn weeks" hint="A player cannot be traded back for this many weeks.">
          <Input
            type="number"
            min={0}
            max={17}
            value={antiChurnWeeks}
            onChange={(event) => setAntiChurnWeeks(event.target.value)}
          />
        </Field>
        <Field label="Trade review hours">
          <Input
            type="number"
            min={0}
            max={168}
            value={tradeReviewHours}
            onChange={(event) => setTradeReviewHours(event.target.value)}
          />
        </Field>
      </div>

      <div>
        <span className="eyebrow mb-2 block">Rate limits</span>
        <div className="grid gap-4 sm:grid-cols-5">
          <Field label="Open proposals">
            <Input
              type="number"
              min={0}
              value={maxOpenProposals}
              onChange={(event) => setMaxOpenProposals(event.target.value)}
            />
          </Field>
          <Field label="Msgs / run">
            <Input
              type="number"
              min={0}
              value={maxMessagesPerRun}
              onChange={(event) => setMaxMessagesPerRun(event.target.value)}
            />
          </Field>
          <Field label="Threads / window">
            <Input
              type="number"
              min={0}
              value={maxThreadsPerWindow}
              onChange={(event) => setMaxThreadsPerWindow(event.target.value)}
            />
          </Field>
          <Field label="Posts / day">
            <Input
              type="number"
              min={0}
              value={forumPostsPerDay}
              onChange={(event) => setForumPostsPerDay(event.target.value)}
            />
          </Field>
          <Field label="Comments / day">
            <Input
              type="number"
              min={0}
              value={forumCommentsPerDay}
              onChange={(event) => setForumCommentsPerDay(event.target.value)}
            />
          </Field>
        </div>
      </div>
    </SettingsSection>
  );
}
