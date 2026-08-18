import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { roobert, mono } from "@/lib/fonts";

export const metadata: Metadata = {
  title: "Eco X Template Tracker",
  description: "Per-template posting cadence & performance for the @eco X account.",
};

// V1 is deployed publicly (no login yet — @eco.com Google auth is a later add).
// The money-spending sync/classify endpoints stay locked to CRON_SECRET.
//
// Navigation lives entirely in the left rail (Sidebar) — the header only carries
// the wordmark (a home link) and the logo, so the two aren't redundant.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${roobert.variable} ${mono.variable} h-full antialiased`}>
      <body className="min-h-screen bg-black font-sans text-white antialiased">
        <header className="sticky top-0 z-10 border-b border-white/10 bg-black/70 backdrop-blur">
          <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3">
            <Link href="/insights" className="text-sm font-medium tracking-[-0.01em] transition hover:opacity-80">
              Eco <span className="text-white/30">·</span> X Template Tracker
            </Link>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/eco-logo-white.svg" alt="Eco" className="h-5 w-auto opacity-90" />
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
