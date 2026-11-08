import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import type { ReactNode } from "react";
import { ThemeScript } from "../components/theme-toggle.tsx";
import { sentryMeta } from "../server/sentry.ts";
import "./globals.css";

const sans = Geist({ subsets: ["latin", "latin-ext"], variable: "--font-geist-sans" });
const mono = Geist_Mono({ subsets: ["latin", "latin-ext"], variable: "--font-geist-mono" });

export const viewport: Viewport = { colorScheme: "light dark" };

export function generateMetadata(): Metadata {
  const other = sentryMeta();
  return {
    title: { default: "Trawler", template: "%s · Trawler" },
    description: "Agents use your product in a real browser and report what they found, confirmed by a blind replay.",
    ...(other ? { other } : {}),
  };
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <ThemeScript />
      </head>
      <body className="min-h-dvh font-sans antialiased">{children}</body>
    </html>
  );
}
