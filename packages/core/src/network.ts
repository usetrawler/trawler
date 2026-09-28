import { BlockList } from "node:net";

function ipv4Compatible(): Array<[string, number]> {
  return Array.from({ length: 31 }, (_, i) => [`::${(1n << BigInt(i + 1)).toString(16).replace(/(?=(\w{4})+$)/g, ":").replace(/^:/, "")}`, 127 - i] as [string, number]);
}

export function blockedAddresses(options: { allowLoopback?: boolean } = {}): BlockList {
  const list = new BlockList();
  const v4: Array<[string, number]> = [
    ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24],
    ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
  ];
  const v6: Array<[string, number]> = [
    ["::", 128], ...ipv4Compatible(), ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8], ["64:ff9b::", 96], ["64:ff9b:1::", 48],
    ["100::", 64], ["2001::", 32], ["2001:db8::", 32], ["2002::", 16], ["::ffff:0:0:0", 96],
  ];
  if (!options.allowLoopback) {
    v4.push(["127.0.0.0", 8]);
    v6.push(["::1", 128]);
  }
  for (const [net, prefix] of v4) {
    list.addSubnet(net, prefix, "ipv4");
    list.addSubnet(`::ffff:${net}`, 96 + prefix, "ipv6");
  }
  for (const [net, prefix] of v6) list.addSubnet(net, prefix, "ipv6");
  return list;
}

export const isBlockedAddress = (address: string, family: number, blocked: BlockList) => blocked.check(address, family === 6 ? "ipv6" : "ipv4");
