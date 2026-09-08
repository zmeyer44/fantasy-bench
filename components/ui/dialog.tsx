"use client";

import { useEffect, useRef, type ReactNode } from "react";

import { Button } from "./button";

/**
 * Thin wrapper over the native `<dialog>` element — modal behaviour, focus trap
 * and Escape handling come from the platform rather than from a library.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (open && !node.open) node.showModal();
    if (!open && node.open) node.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={onClose}
      className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-lg border border-line bg-surface p-0 text-ink backdrop:bg-black/50"
    >
      <div className="flex items-start justify-between gap-4 border-b border-line px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          {description ? <p className="mt-0.5 text-xs text-ink-muted">{description}</p> : null}
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">
          ✕
        </Button>
      </div>
      <div className="px-4 py-4 text-sm">{children}</div>
      {footer ? (
        <div className="flex justify-end gap-2 border-t border-line px-4 py-3">{footer}</div>
      ) : null}
    </dialog>
  );
}
