import Image from "next/image";

import { cn } from "@/lib/utils";
import { nflTeamInfo } from "@/lib/nfl-teams";

/**
 * A club logo from the self-hosted set in `public/nfl`. Renders nothing for a
 * token that is not an NFL team (free agents, unknown feeds), so callers can
 * pass whatever the data has. The faint backdrop keeps dark marks (Raiders,
 * Bears) legible on the near-black canvas.
 */
export function TeamLogo({
  team,
  size = 20,
  backdrop = true,
  className,
}: {
  team: string | null | undefined;
  size?: number;
  backdrop?: boolean;
  className?: string;
}) {
  const info = nflTeamInfo(team);
  if (!info) return null;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full",
        backdrop && "bg-foreground/8 ring-1 ring-foreground/10",
        className,
      )}
      style={{ width: size, height: size }}
    >
      <Image
        src={info.logo}
        alt={info.name}
        title={info.name}
        width={size}
        height={size}
        unoptimized
        className="size-[78%] object-contain"
      />
    </span>
  );
}

/**
 * Logo plus abbreviation as one mono label: the standard way to name a club
 * inline next to a player. Falls back to the raw token when it is not a club.
 */
export function TeamTag({
  team,
  size = 16,
  className,
}: {
  team: string | null | undefined;
  size?: number;
  className?: string;
}) {
  if (!team) return null;
  const info = nflTeamInfo(team);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 align-middle font-mono text-[10px] text-ink-faint",
        className,
      )}
    >
      <TeamLogo team={team} size={size} />
      <span>{info?.abbr ?? team}</span>
    </span>
  );
}

/** An opponent token such as "@KC" or "vs DEN", keeping the home/away prefix. */
export function OpponentTag({
  opponent,
  size = 16,
  className,
}: {
  opponent: string | null | undefined;
  size?: number;
  className?: string;
}) {
  if (!opponent) return null;
  const prefix = /^@/.test(opponent.trim()) ? "@" : "";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 align-middle font-mono text-[10px] text-muted-foreground",
        className,
      )}
    >
      {prefix ? <span className="text-ink-faint">{prefix}</span> : null}
      <TeamLogo team={opponent} size={size} />
      <span>{nflTeamInfo(opponent)?.abbr ?? opponent.replace(/^@/, "")}</span>
    </span>
  );
}
