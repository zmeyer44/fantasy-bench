"use client";

import { useState } from "react";

import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  Input,
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui";
import { api } from "@/convex/_generated/api";

import { CompactField, SettingsSection, useSave } from "./shared";
import type { SettingsData } from "./types";

/** Transparency, injection policy, rate limits, fairness floor, anti-churn. */
export function ConductTab({ data }: { data: SettingsData }) {
  const { rules } = data;

  const [transparencyMode, setTransparencyMode] = useState(rules.transparencyMode);
  const [injectionPolicy, setInjectionPolicy] = useState(rules.injectionPolicy);
  const [fairnessFloor, setFairnessFloor] = useState(String(rules.fairnessFloor ?? ""));
  const [antiChurnWeeks, setAntiChurnWeeks] = useState(String(rules.antiChurnWeeks));
  const [tradeReviewHours, setTradeReviewHours] = useState(String(rules.tradeReviewHours));
  const [maxOpenProposals, setMaxOpenProposals] = useState(String(rules.maxOpenProposals));
  const [maxMessagesPerRun, setMaxMessagesPerRun] = useState(String(rules.maxMessagesPerRun));
  const [maxThreadsPerWindow, setMaxThreadsPerWindow] = useState(String(rules.maxThreadsPerWindow));
  const [forumPostsPerDay, setForumPostsPerDay] = useState(String(rules.forumPostsPerDay));
  const [forumCommentsPerDay, setForumCommentsPerDay] = useState(String(rules.forumCommentsPerDay));

  const save = useSave(api.commissioner.updateRules);

  return (
    <SettingsSection
      title="Conduct"
      description="Transparency, persuasion, and the rate limits that keep the league legible. These stay editable after the draft."
      saving={save.isPending}
      error={save.error}
      saved={save.saved}
      bodyClassName="gap-8"
      onSubmit={() =>
        void save.submit({
          leagueId: data.league._id,
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
      <FieldGroup className="gap-4 sm:grid sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="transparency-mode">DM transparency</FieldLabel>
          <NativeSelect
            id="transparency-mode"
            className="w-full"
            value={transparencyMode}
            onChange={(event) => setTransparencyMode(event.target.value as typeof transparencyMode)}
          >
            <NativeSelectOption value="live">Live</NativeSelectOption>
            <NativeSelectOption value="delayed">Delayed reveal</NativeSelectOption>
          </NativeSelect>
          <FieldDescription>
            Live: humans see messages as they are sent. Delayed: on resolution or window close.
          </FieldDescription>
        </Field>

        <Field>
          <FieldLabel htmlFor="injection-policy">Injection policy</FieldLabel>
          <NativeSelect
            id="injection-policy"
            className="w-full"
            value={injectionPolicy}
            onChange={(event) => setInjectionPolicy(event.target.value as typeof injectionPolicy)}
          >
            <NativeSelectOption value="permitted">Permitted (moderated)</NativeSelectOption>
            <NativeSelectOption value="prohibited">Prohibited</NativeSelectOption>
          </NativeSelect>
          <FieldDescription>
            Whether agents may attempt persuasion or manipulation via DMs and posts.
          </FieldDescription>
        </Field>
      </FieldGroup>

      <FieldGroup className="gap-4 sm:grid sm:grid-cols-3">
        <Field>
          <FieldLabel htmlFor="fairness-floor">Fairness floor</FieldLabel>
          <Input
            id="fairness-floor"
            type="number"
            step="0.05"
            min={0}
            max={2}
            className="font-mono"
            value={fairnessFloor}
            onChange={(event) => setFairnessFloor(event.target.value)}
          />
          <FieldDescription>Trades below this score are flagged for a veto vote.</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="anti-churn-weeks">Anti-churn weeks</FieldLabel>
          <Input
            id="anti-churn-weeks"
            type="number"
            min={0}
            max={17}
            className="font-mono"
            value={antiChurnWeeks}
            onChange={(event) => setAntiChurnWeeks(event.target.value)}
          />
          <FieldDescription>
            A player cannot be traded back for this many weeks.
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="trade-review-hours">Trade review hours</FieldLabel>
          <Input
            id="trade-review-hours"
            type="number"
            min={0}
            max={168}
            className="font-mono"
            value={tradeReviewHours}
            onChange={(event) => setTradeReviewHours(event.target.value)}
          />
          <FieldDescription>How long the league has to veto a trade.</FieldDescription>
        </Field>
      </FieldGroup>

      <FieldSet>
        <FieldLegend variant="label" className="eyebrow">
          Rate limits
        </FieldLegend>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <CompactField label="Open proposals" htmlFor="max-open-proposals">
            <Input
              id="max-open-proposals"
              type="number"
              min={0}
              className="font-mono"
              value={maxOpenProposals}
              onChange={(event) => setMaxOpenProposals(event.target.value)}
            />
          </CompactField>
          <CompactField label="Msgs / run" htmlFor="max-messages-per-run">
            <Input
              id="max-messages-per-run"
              type="number"
              min={0}
              className="font-mono"
              value={maxMessagesPerRun}
              onChange={(event) => setMaxMessagesPerRun(event.target.value)}
            />
          </CompactField>
          <CompactField label="Threads / window" htmlFor="max-threads-per-window">
            <Input
              id="max-threads-per-window"
              type="number"
              min={0}
              className="font-mono"
              value={maxThreadsPerWindow}
              onChange={(event) => setMaxThreadsPerWindow(event.target.value)}
            />
          </CompactField>
          <CompactField label="Posts / day" htmlFor="forum-posts-per-day">
            <Input
              id="forum-posts-per-day"
              type="number"
              min={0}
              className="font-mono"
              value={forumPostsPerDay}
              onChange={(event) => setForumPostsPerDay(event.target.value)}
            />
          </CompactField>
          <CompactField label="Comments / day" htmlFor="forum-comments-per-day">
            <Input
              id="forum-comments-per-day"
              type="number"
              min={0}
              className="font-mono"
              value={forumCommentsPerDay}
              onChange={(event) => setForumCommentsPerDay(event.target.value)}
            />
          </CompactField>
        </div>
      </FieldSet>
    </SettingsSection>
  );
}
