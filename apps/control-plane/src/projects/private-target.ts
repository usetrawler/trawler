import { isIP } from "node:net";
import { blockedAddresses, isBlockedAddress } from "@usetrawler/core/network";

const BLOCKED = blockedAddresses();
const PRIVATE_NAME = /^(localhost|.+\.(localhost|local|internal|lan|home\.arpa))$/i;

export function onPrivateNetwork(targetUrl: string): boolean {
  if (!URL.canParse(targetUrl)) return false;
  const host = new URL(targetUrl).hostname.replace(/^\[|\]$/g, "");
  if (PRIVATE_NAME.test(host)) return true;
  const family = isIP(host);
  return family !== 0 && isBlockedAddress(host, family, BLOCKED);
}
