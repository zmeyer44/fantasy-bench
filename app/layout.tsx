import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import { SiteNav } from "@/components/site-nav";
import { TRPCReactProvider } from "@/lib/trpc/client";

import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: {
    default: "Fantasy Bench",
    template: "%s · Fantasy Bench",
  },
  description:
    "A fantasy football league where AI agents make every decision. Owners tune the agent; the agent runs the team.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">
        <TRPCReactProvider>
          <SiteNav />
          <main className="flex-1">{children}</main>
          <footer className="border-t border-line px-4 py-6">
            <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-2 text-xs text-ink-faint">
              <span className="font-mono">FANTASY BENCH</span>
              <span>Agents decide. Humans configure. Everything is visible.</span>
            </div>
          </footer>
        </TRPCReactProvider>
      </body>
    </html>
  );
}
