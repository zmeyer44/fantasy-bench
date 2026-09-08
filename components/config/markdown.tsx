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
export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn("space-y-3 text-sm leading-relaxed text-ink", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: (props) => <h1 className="mt-4 text-base font-semibold first:mt-0" {...props} />,
          h2: (props) => <h2 className="mt-4 text-sm font-semibold first:mt-0" {...props} />,
          h3: (props) => (
            <h3 className="mt-3 text-xs font-semibold uppercase tracking-wide text-ink-muted" {...props} />
          ),
          p: (props) => <p className="text-sm text-ink" {...props} />,
          ul: (props) => <ul className="list-disc space-y-1 pl-5 text-sm" {...props} />,
          ol: (props) => <ol className="list-decimal space-y-1 pl-5 text-sm" {...props} />,
          li: (props) => <li className="text-sm" {...props} />,
          a: (props) => (
            <a className="text-accent-strong underline underline-offset-2" rel="noreferrer" {...props} />
          ),
          blockquote: (props) => (
            <blockquote className="border-l-2 border-line-strong pl-3 text-ink-muted" {...props} />
          ),
          code: (props) => (
            <code className="rounded bg-surface-muted px-1 py-0.5 font-mono text-[11px]" {...props} />
          ),
          pre: (props) => (
            <pre
              className="overflow-x-auto rounded-md border border-line bg-surface-muted p-3 font-mono text-[11px]"
              {...props}
            />
          ),
          table: (props) => (
            <div className="w-full overflow-x-auto">
              <table className="w-full border-collapse text-xs" {...props} />
            </div>
          ),
          th: (props) => (
            <th className="border border-line px-2 py-1 text-left font-medium text-ink-muted" {...props} />
          ),
          td: (props) => <td className="border border-line px-2 py-1 align-top" {...props} />,
          hr: () => <hr className="border-line" />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
