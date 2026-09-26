import type { Metadata } from "next";
import { BrandMark } from "../components/brand-mark.tsx";
import { ThemeToggle } from "../components/theme-toggle.tsx";
import { RequestedPath } from "./requested-path.tsx";

const label = "font-mono text-[10px] text-muted uppercase";

const TITLE = "Page not found · Trawler";

export const metadata: Metadata = { title: TITLE };

export default function NotFound() {
  return (
    <div className="app-frame grid min-h-dvh grid-rows-[76px_1fr_46px] overflow-hidden max-[821px]:grid-rows-[64px_auto_46px]">
      <title>{TITLE}</title>
      <header className="flex items-center justify-between border-b border-line bg-[var(--header)] px-[clamp(20px,4.2vw,72px)] backdrop-blur-md">
        <a href="/" className="flex items-center gap-2.5 text-[22px] font-bold tracking-tight">
          <BrandMark className="h-7 w-7" />
          trawler
        </a>
        <ThemeToggle />
      </header>
      <main className="relative m-auto grid w-[min(1220px,calc(100%-48px))] grid-cols-[minmax(0,1fr)_360px] items-center gap-20 max-[821px]:grid-cols-1 max-[821px]:gap-[55px] max-[821px]:py-[60px] max-[521px]:w-[calc(100%-36px)]">
        <div aria-hidden className="pointer-events-none absolute top-1/2 -right-[2vw] z-0 -translate-y-[54%] text-[clamp(260px,35vw,540px)] leading-[0.75] font-[850] tracking-[-0.1em] text-[color-mix(in_srgb,var(--ink)_4%,transparent)] select-none forced-colors:hidden max-[821px]:relative max-[821px]:top-auto max-[821px]:right-auto max-[821px]:row-start-1 max-[821px]:h-[0.7em] max-[821px]:translate-y-0 max-[821px]:text-[clamp(120px,38vw,190px)] max-[821px]:text-[color-mix(in_srgb,var(--action)_14%,transparent)]">404</div>
        <section className="relative z-10 min-w-0 max-[821px]:row-start-2">
          <p className="flex items-center gap-2.5 font-mono text-[11px] tracking-[0.12em] text-action uppercase">
            <i aria-hidden className="h-2 w-2 rounded-full bg-action shadow-[0_0_0_7px_color-mix(in_srgb,var(--action)_13%,transparent)]" />
            Page not found
          </p>
          <h1 className="my-7 text-[clamp(68px,8vw,124px)] leading-[0.87] font-bold tracking-[-0.075em] max-[821px]:text-[clamp(58px,16vw,84px)]">This route<br />doesn’t exist.</h1>
          <p className="max-w-[480px] text-xl leading-normal text-muted">The address may be wrong, or the page may have moved.</p>
          <div className="mt-[38px] flex flex-wrap gap-[9px] max-[521px]:flex-col">
            <a href="/" className="flex h-[51px] min-w-[220px] items-center justify-between gap-6 bg-action px-[17px] font-mono text-[11px] whitespace-nowrap text-[#17191c] uppercase hover:brightness-110">
              Open Trawler<span aria-hidden>→</span>
            </a>
            <a href="https://usetrawler.com/" className="flex h-[51px] items-center border border-line bg-panel px-[17px] font-mono text-[11px] whitespace-nowrap text-ink uppercase hover:border-ink">Visit usetrawler.com</a>
          </div>
        </section>
        <section aria-label="Route check" className="relative z-10 min-w-0 border border-line bg-panel p-5 shadow-[18px_18px_0_var(--soft)] max-[821px]:row-start-3 max-[821px]:shadow-[10px_10px_0_var(--soft)] max-[521px]:shadow-none">
          <div>
            <p className={`mb-2 ${label}`}>Requested route</p>
            <RequestedPath />
          </div>
          <div aria-hidden className="flex h-[115px] items-center">
            <i className="h-[11px] w-[11px] flex-none rounded-full border-2 border-ink" />
            <b className="h-0.5 flex-1 bg-[linear-gradient(90deg,var(--action)_0_45%,transparent_45%_55%,var(--line)_55%)]" />
            <i className="h-[11px] w-[11px] flex-none rounded-full border-2 border-ink" />
            <strong className="grid h-9 w-9 place-items-center rounded-full border-2 border-action text-2xl leading-none text-action">×</strong>
          </div>
          <p className="flex items-end justify-between border-t border-line pt-[17px]">
            <span className={label}>Result</span>
            <b className="font-mono text-[11px] font-normal text-action uppercase">Not found</b>
          </p>
          <small className="mt-[18px] block text-[11px] text-muted">Checked twice by Trawler.</small>
        </section>
      </main>
      <footer className="flex items-center justify-between border-t border-line px-[clamp(20px,4.2vw,72px)] font-mono text-[10px] text-muted uppercase">
        <span>HTTP 404</span>
        <a href="mailto:contact@usetrawler.com" className="underline underline-offset-2 hover:text-ink max-[521px]:hidden">Report a broken link</a>
      </footer>
    </div>
  );
}
