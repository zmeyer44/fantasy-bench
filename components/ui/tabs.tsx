"use client";

import { createContext, useContext, useId, useState, type ReactNode } from "react";

import { cn } from "./utils";

type TabsContextValue = { value: string; setValue: (v: string) => void; baseId: string };
const TabsContext = createContext<TabsContextValue | null>(null);

function useTabs(component: string): TabsContextValue {
  const ctx = useContext(TabsContext);
  if (!ctx) throw new Error(`<${component}> must be used inside <Tabs>`);
  return ctx;
}

export function Tabs({
  defaultValue,
  value: controlled,
  onValueChange,
  children,
  className,
}: {
  defaultValue: string;
  value?: string;
  onValueChange?: (value: string) => void;
  children: ReactNode;
  className?: string;
}) {
  const [uncontrolled, setUncontrolled] = useState(defaultValue);
  const baseId = useId();
  const value = controlled ?? uncontrolled;
  const setValue = (next: string) => {
    if (controlled === undefined) setUncontrolled(next);
    onValueChange?.(next);
  };
  return (
    <TabsContext.Provider value={{ value, setValue, baseId }}>
      <div className={className}>{children}</div>
    </TabsContext.Provider>
  );
}

export function TabsList({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      role="tablist"
      className={cn("flex items-center gap-1 border-b border-line", className)}
    >
      {children}
    </div>
  );
}

export function TabsTrigger({ value, children }: { value: string; children: ReactNode }) {
  const { value: active, setValue, baseId } = useTabs("TabsTrigger");
  const selected = active === value;
  return (
    <button
      type="button"
      role="tab"
      id={`${baseId}-tab-${value}`}
      aria-selected={selected}
      aria-controls={`${baseId}-panel-${value}`}
      onClick={() => setValue(value)}
      className={cn(
        "-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors",
        selected
          ? "border-accent text-ink"
          : "border-transparent text-ink-muted hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}

export function TabsContent({ value, children }: { value: string; children: ReactNode }) {
  const { value: active, baseId } = useTabs("TabsContent");
  if (active !== value) return null;
  return (
    <div
      role="tabpanel"
      id={`${baseId}-panel-${value}`}
      aria-labelledby={`${baseId}-tab-${value}`}
      className="pt-4"
    >
      {children}
    </div>
  );
}
