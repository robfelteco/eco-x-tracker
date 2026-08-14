import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { roobert, mono } from "@/lib/fonts";

export const metadata: Metadata = {
  title: "Eco X Template Tracker",
  description: "Per-template posting cadence & performance for the @eco X account.",
};

const NAV = [
  { href: "/", label: "Overview" },
  { href: "/posts", label: "All posts" },
  { href: "/review", label: "Review queue" },
];

// V1 is deployed publicly (no login yet — @eco.com Google auth is a later add).
// The money-spending sync/classify endpoints stay locked to CRON_SECRET.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${roobert.variable} ${mono.variable} h-full antialiased`}>
      <body className="min-h-screen bg-black font-sans text-white antialiased">
        <header className="sticky top-0 z-10 border-b border-white/10 bg-black/70 backdrop-blur">
          <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3">
            <div className="flex items-center gap-6">
              <span className="text-sm font-medium tracking-[-0.01em]">
                Eco <span className="text-white/30">·</span> X Template Tracker
              </span>
              <nav className="flex items-center gap-1 rounded-full border border-white/10 p-1">
                {NAV.map((n) => (
                  <Link
                    key={n.href}
                    href={n.href}
                    className="rounded-full px-3 py-1 text-xs font-medium text-white/60 transition hover:text-white"
                  >
                    {n.label}
                  </Link>
                ))}
              </nav>
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/eco-logo-white.svg" alt="Eco" className="h-5 w-auto opacity-90" />
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
