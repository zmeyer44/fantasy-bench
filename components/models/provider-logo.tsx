import { FlaskConical } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Display metadata for each gateway provider slug in the catalog. Logos are
 * monochrome SVGs under `public/providers` (sourced from models.dev) drawn
 * through a CSS mask so they take the current text colour like an icon.
 */
const PROVIDERS: Record<string, { label: string; logo: string | null }> = {
  openai: { label: "OpenAI", logo: "openai" },
  anthropic: { label: "Anthropic", logo: "anthropic" },
  google: { label: "Google", logo: "google" },
  deepseek: { label: "DeepSeek", logo: "deepseek" },
  inception: { label: "Inception", logo: "inception" },
  zai: { label: "Z.ai", logo: "zai" },
  alibaba: { label: "Alibaba", logo: "alibaba" },
  meta: { label: "Meta", logo: "meta" },
  spacexai: { label: "xAI", logo: "xai" },
  moonshotai: { label: "Moonshot AI", logo: "moonshotai" },
  mock: { label: "Mock", logo: null },
};

/** Human name for a provider slug; unknown slugs are shown as-is. */
export function providerLabel(provider: string): string {
  return PROVIDERS[provider]?.label ?? provider;
}

/** The provider's mark, sized like a lucide icon. Falls back to a flask for the mock provider. */
export function ProviderLogo({ provider, className }: { provider: string; className?: string }) {
  const logo = PROVIDERS[provider]?.logo;
  if (!logo) {
    return <FlaskConical aria-hidden className={cn("size-4 shrink-0", className)} />;
  }
  const url = `url(/providers/${logo}.svg)`;
  return (
    <span
      aria-hidden
      className={cn("inline-block size-4 shrink-0 bg-current", className)}
      style={{
        maskImage: url,
        WebkitMaskImage: url,
        maskSize: "contain",
        WebkitMaskSize: "contain",
        maskRepeat: "no-repeat",
        WebkitMaskRepeat: "no-repeat",
        maskPosition: "center",
        WebkitMaskPosition: "center",
      }}
    />
  );
}
