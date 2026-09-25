import type { Metadata } from "next";
import { Instrument_Sans, JetBrains_Mono } from "next/font/google";
import type { ReactNode } from "react";
import { SENTRY_META } from "../lib/browser-sentry.ts";
import { browserSentryConfig } from "../server/sentry.ts";
import "./globals.css";

const sans = Instrument_Sans({ subsets: ["latin", "latin-ext"], variable: "--font-instrument-sans" });
const mono = JetBrains_Mono({ subsets: ["latin", "latin-ext"], variable: "--font-jetbrains-mono" });

export function generateMetadata(): Metadata {
  const sentry = browserSentryConfig();
  return {
    title: "Trawler",
    description: "Agents use your product in a real browser and report what they found, confirmed by a blind replay.",
    ...(sentry ? { other: { [SENTRY_META]: JSON.stringify(sentry) } } : {}),
  };
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body className="min-h-dvh font-sans antialiased">{children}</body>
    </html>
  );
}
