"use client";

import { useState } from "react";
import Image from "next/image";
import { TeamLogo } from "@/components/nfl/team-logo";
import { cn } from "@/lib/utils";

export const TEAM_AVATARS = [
  "bolt",
  "helmet",
  "orbit",
  "crown",
  "wolf",
  "shield",
] as const;

export function TeamAvatar({
  name,
  teamId = name,
  avatarUrl,
  avatarTemplate,
  size = 40,
}: {
  name: string;
  teamId?: string;
  avatarUrl?: string | null;
  avatarTemplate?: string;
  size?: number;
}) {
  const hash = Array.from(teamId).reduce(
    (sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0,
    0,
  );
  const template =
    TEAM_AVATARS.find((item) => item === avatarTemplate) ??
    TEAM_AVATARS[hash % TEAM_AVATARS.length];
  const fallback = `/avatars/${template}.svg`;
  const [failedUrl, setFailedUrl] = useState<string>();
  const src = avatarUrl && avatarUrl !== failedUrl ? avatarUrl : fallback;
  return (
    <Image
      unoptimized
      src={src}
      alt={`${name} avatar`}
      width={size}
      height={size}
      className="shrink-0 rounded-xl object-cover"
      style={{ width: size, height: size }}
      onError={() => setFailedUrl(src)}
    />
  );
}

export function PlayerHeadshot({
  name,
  sleeperId,
  nflTeam,
  position,
  size = 40,
}: {
  name: string;
  sleeperId?: string | null;
  nflTeam?: string | null;
  position?: string | null;
  size?: number;
}) {
  const [failedId, setFailedId] = useState<string>();
  const hasPhoto =
    sleeperId &&
    /^\d+$/.test(sleeperId) &&
    position !== "DEF" &&
    sleeperId !== failedId;
  return (
    <span
      className="relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-secondary"
      style={{ width: size, height: size }}
    >
      {hasPhoto ? (
        <Image
          unoptimized
          src={`https://sleepercdn.com/content/nfl/players/${sleeperId}.jpg`}
          alt={name}
          width={size}
          height={size}
          className="h-full w-full object-cover"
          onError={() => setFailedId(sleeperId)}
        />
      ) : nflTeam ? (
        <TeamLogo team={nflTeam} size={Math.round(size * 0.75)} />
      ) : (
        <span
          aria-label={name}
          className="text-xs font-medium text-muted-foreground"
        >
          {name
            .split(" ")
            .map((word) => word[0])
            .slice(0, 2)
            .join("")}
        </span>
      )}
    </span>
  );
}

export function PositionTag({ slot }: { slot: string }) {
  const base = slot.replace(/\d+$/, "");
  return (
    <span
      className={cn(
        "inline-flex min-h-7 min-w-8 items-center justify-center rounded px-1 font-mono text-[10px] font-medium",
        base === "QB" || base === "WR"
          ? "bg-blue-soft text-blue-strong"
          : base === "RB" || base === "FLEX"
            ? "bg-brand-soft text-brand"
            : "bg-secondary text-muted-foreground",
      )}
      title={slot}
    >
      {base === "BENCH" ? "BN" : base === "SUPERFLEX" ? "SFLX" : base}
    </span>
  );
}
