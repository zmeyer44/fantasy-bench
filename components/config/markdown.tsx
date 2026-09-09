import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "@/components/ui";

/**
 * Markdown renderer for agent context and skill bodies.
 *
 * There is no typography plugin in this project, so element styles are declared
 * here. Everything an agent or an owner writes is untrusted text — react-markdown
 * escapes HTML by default and we do not enable `rehype-raw`.
 */
export function Markdown({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "space-y-3 text-sm leading-relaxed text-foreground",
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: (props) => (
            <h1
              className="mt-5 text-base font-semibold tracking-tight first:mt-0"
              {...props}
            />
          ),
          h2: (props) => (
            <h2
              className="mt-5 text-sm font-semibold tracking-tight first:mt-0"
              {...props}
            />
          ),
          h3: (props) => (
            <h3
              className="eyebrow mt-4 text-foreground first:mt-0"
              {...props}
            />
          ),
          p: (props) => <p className="text-sm text-foreground" {...props} />,
          ul: (props) => (
            <ul className="list-disc space-y-1 pl-5 text-sm" {...props} />
          ),
          ol: (props) => (
            <ol className="list-decimal space-y-1 pl-5 text-sm" {...props} />
          ),
          li: (props) => <li className="text-sm" {...props} />,
          a: (props) => (
            <a
              className="text-foreground underline decoration-border underline-offset-4 transition-colors hover:decoration-brand"
              rel="noreferrer"
              {...props}
            />
          ),
          blockquote: (props) => (
            <blockquote
              className="border-l-2 border-line-strong pl-3 text-muted-foreground"
              {...props}
            />
          ),
          code: (props) => (
            <code
              className="rounded-sm bg-muted px-1 py-0.5 font-mono text-xs"
              {...props}
            />
          ),
          pre: (props) => (
            <pre
              className="overflow-x-auto rounded-lg border border-border bg-muted p-3 font-mono text-xs leading-relaxed"
              {...props}
            />
          ),
          table: (props) => (
            <div className="w-full overflow-x-auto">
              <table
                className="w-full caption-bottom border-collapse text-sm tabular-nums"
                {...props}
              />
            </div>
          ),
          th: (props) => (
            <th
              className="border-b border-border px-3 py-2 text-left font-mono text-[11px] font-medium text-muted-foreground"
              {...props}
            />
          ),
          td: (props) => (
            <td
              className="border-b border-border px-3 py-2 align-top"
              {...props}
            />
          ),
          hr: () => <hr className="border-border" />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
