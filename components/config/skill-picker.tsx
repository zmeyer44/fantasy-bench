"use client";

import { useQuery } from "convex/react";
import { Check, Plus, Search } from "lucide-react";
import { useState } from "react";

import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
} from "@/components/ui";
import { api } from "@/convex/_generated/api";

export type AttachedSkill = {
  id: string;
  name: string;
  slug: string;
  description: string;
  bodyMd: string;
};

/** "Attach from library": searchable list of public skills with usage counts. */
export function AttachSkillDialog({
  open,
  onClose,
  attachedIds,
  onAttach,
}: {
  open: boolean;
  onClose: () => void;
  attachedIds: string[];
  onAttach: (skill: AttachedSkill) => void;
}) {
  const [query, setQuery] = useState("");

  // Live library search, skipped entirely while the dialog is closed.
  const term = query.trim();
  const list = useQuery(api.skills.list, open ? (term ? { query: term } : {}) : "skip");

  const attached = new Set(attachedIds);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Attach a skill</DialogTitle>
          <DialogDescription>
            The library is public across every league. Attaching by id means the author&apos;s
            future edits reach your agent.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search
            className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            autoFocus
            placeholder="Search skills…"
            aria-label="Search skills"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-8"
          />
        </div>

        <div className="-mx-4 max-h-80 overflow-y-auto border-y border-border">
          {list === undefined ? (
            <p className="px-4 py-6 text-sm text-muted-foreground">Loading…</p>
          ) : list.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted-foreground">No skills match that search.</p>
          ) : (
            <ul className="divide-y divide-border">
              {list.map((skill) => {
                const isAttached = attached.has(skill._id);
                return (
                  <li
                    key={skill._id}
                    className="flex items-start justify-between gap-3 px-4 py-2.5 transition-colors hover:bg-accent"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-foreground">
                          {skill.name}
                        </span>
                        <Badge variant="outline">{skill.usageCount} in use</Badge>
                      </div>
                      <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">
                        {skill.description || `${skill.bodyMd.length.toLocaleString()} chars`}
                      </p>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant={isAttached ? "ghost" : "outline"}
                      disabled={isAttached}
                      onClick={() =>
                        onAttach({
                          id: skill._id,
                          name: skill.name,
                          slug: skill.slug,
                          description: skill.description ?? "",
                          bodyMd: skill.bodyMd,
                        })
                      }
                    >
                      {isAttached ? <Check data-icon="inline-start" /> : <Plus data-icon="inline-start" />}
                      {isAttached ? "Attached" : "Attach"}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
