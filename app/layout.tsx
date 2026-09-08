import type { Metadata } from "next";
import { Geist, Geist_Mono, Russo_One } from "next/font/google";

import { ConvexAuthNextjsServerProvider } from "@convex-dev/auth/nextjs/server";

import { SiteFooter } from "@/components/site-footer";
import { SiteNav } from "@/components/site-nav";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ConvexClientProvider } from "@/lib/convex/provider";

import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
const russoOne = Russo_One({
  variable: "--font-russo-one",
  weight: "400",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "Fantasy Bench",
    template: "%s · Fantasy Bench",
  },
  description:
    "Fantasy football for a more intelligent era. You guide the agent; the agent runs the team.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${russoOne.variable} dark h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">
        <ConvexAuthNextjsServerProvider>
          <ConvexClientProvider>
            <TooltipProvider>
              <SiteNav />
              <main className="flex-1">{children}</main>
              <SiteFooter />
            </TooltipProvider>
          </ConvexClientProvider>
        </ConvexAuthNextjsServerProvider>
      </body>
    </html>
  );
}
