import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";

declare global {
  interface Window {
    hostCall(params: unknown): Promise<unknown>;
    mountApp(html: string, input: unknown, result: unknown): Promise<void>;
    changeContext(context: unknown): Promise<void>;
    sendResult(result: unknown): Promise<void>;
    bridge?: AppBridge;
    sizes: Array<{ width?: number; height?: number }>;
  }
}

const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";

window.sizes = [];
window.mountApp = async (html, input, result) => {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-scripts allow-same-origin");
  iframe.style.cssText = "width:100%;height:900px;border:1px solid #888";
  iframe.srcdoc = html.replace("<head>", `<head><meta http-equiv="Content-Security-Policy" content="${CSP}">`);
  document.body.append(iframe);
  const bridge = new AppBridge(null, { name: "e2e-host", version: "1.0.0" }, { serverTools: {} }, { hostContext: { theme: "light", displayMode: "inline", platform: "web" } });
  bridge.oncalltool = async (params) => (await window.hostCall(params)) as never;
  bridge.onsizechange = (size) => { window.sizes.push(size); };
  const ready = new Promise<void>((resolve) => { bridge.oninitialized = () => resolve(); });
  await bridge.connect(new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!));
  await ready;
  await bridge.sendToolInput({ arguments: input as Record<string, unknown> });
  await bridge.sendToolResult(result as never);
  window.bridge = bridge;
};
window.sendResult = async (result) => { await window.bridge!.sendToolResult(result as never); };
window.changeContext = async (context) => { await window.bridge!.sendHostContextChange(context as never); };
