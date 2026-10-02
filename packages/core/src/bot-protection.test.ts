import { describe, expect, test } from "vitest";
import { botProtection, type PageSignals } from "./bot-protection.ts";

const page = (over: Partial<PageSignals> = {}): PageSignals => ({ title: "Accounts Overview", text: "Welcome back", frames: [], scripts: [], selectors: [], ...over });

describe("botProtection", () => {
  test.each([
    ["Cloudflare", page({ title: "Just a moment...", scripts: ["https://parabank.test/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1?ray=1"] })],
    ["Cloudflare", page({ title: "Attention Required! | Cloudflare" })],
    ["Cloudflare", page({ selectors: ["#challenge-form"] })],
    ["Cloudflare Turnstile", page({ frames: [{ src: "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/turnstile/if/ov2/av0/rcv0/0/abc", visible: true }] })],
    ["reCAPTCHA", page({ frames: [{ src: "https://www.google.com/recaptcha/api2/anchor?ar=1&k=key&size=normal", visible: true }] })],
    ["reCAPTCHA", page({ frames: [{ src: "https://www.google.com/recaptcha/api2/bframe?hl=en&k=key", visible: true }] })],
    ["hCaptcha", page({ frames: [{ src: "https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html#frame=checkbox&id=0", visible: true }] })],
    ["DataDome", page({ frames: [{ src: "https://geo.captcha-delivery.com/captcha/?initialCid=abc", visible: true }] })],
    ["PerimeterX", page({ selectors: ["#px-captcha"], text: "Press & Hold to confirm you are a human (and not a bot)." })],
    ["Akamai", page({ title: "Access Denied", text: "You don't have permission to access this resource. Reference #18.6f3b1d17.1727873452.2a4c" })],
    ["Imperva", page({ text: "Request unsuccessful. Incapsula incident ID: 1234000460123456789-123456789012345678" })],
    ["AWS WAF", page({ title: "Human Verification", scripts: ["https://abc123.edge.sdk.awswaf.com/abc123/def456/challenge.js"] })],
  ])("%s is recognised", (vendor, signals) => {
    expect(botProtection(signals)).toBe(vendor);
  });

  test.each([
    ["an ordinary page", page()],
    ["an invisible reCAPTCHA badge", page({ scripts: ["https://www.google.com/recaptcha/api.js?render=key"], frames: [{ src: "https://www.google.com/recaptcha/api2/anchor?ar=1&k=key&size=invisible", visible: true }] })],
    ["a reCAPTCHA checkbox that is hidden", page({ frames: [{ src: "https://www.google.com/recaptcha/api2/anchor?ar=1&k=key&size=normal", visible: false }] })],
    ["Cloudflare's own error page for a server that is down", page({ title: "parabank.test | 521: Web server is down", text: "Web server is down Error code 521 Ray ID: 8c1f Performance & security by Cloudflare" })],
    ["Cloudflare's silent bot-detection script on an ordinary page", page({ scripts: ["https://parabank.test/cdn-cgi/challenge-platform/scripts/jsd/main.js"] })],
    ["AWS WAF's silent token script on an ordinary page", page({ scripts: ["https://abc123.edge.sdk.awswaf.com/abc123/def456/challenge.js"] })],
    ["a product page that talks about access", page({ title: "Access denied for this role", text: "Ask an administrator for access." })],
  ])("%s is not", (_name, signals) => {
    expect(botProtection(signals)).toBeNull();
  });
});
