export interface Untrusted {
  untrusted: true;
  from: string;
  text: string;
}

export type Goal = string | Untrusted;

type Attrs = Record<string, string | number | boolean | undefined | null>;
type Kid = Node | string | null | false | undefined;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...kids: Kid[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === null) continue;
    if (value === false && !name.startsWith("aria-")) continue;
    node.setAttribute(name, value === true && !name.startsWith("aria-") ? "" : String(value));
  }
  for (const kid of kids) if (kid) node.append(kid);
  return node;
}

export function put(node: Element, ...kids: Kid[]): void {
  for (const kid of kids) if (kid) node.append(kid);
}

export const clear = (node: Element): void => node.replaceChildren();

export const textOf = (value: Goal): string => (typeof value === "string" ? value : value.text);

export function untrustedBlock(block: Untrusted, tag: "pre" | "p" = "pre"): HTMLElement {
  return el("figure", { class: "untrusted" }, el("figcaption", {}, `Text from the product or its AI people, shown as plain text: ${block.from}`), el(tag, {}, block.text));
}

export function inlineText(value: Goal): HTMLElement {
  return typeof value === "string" ? el("span", {}, value) : el("span", { class: "from-product", title: `Text from the product: ${value.from}` }, value.text);
}

const SVG = "http://www.w3.org/2000/svg";

const ICONS: Record<string, string> = {
  check: "M5 12l5 5L20 7", x: "M6 6l12 12M18 6L6 18", minus: "M5 12h14", chevron: "M6 9l6 6 6-6", back: "M19 12H5M11 6l-6 6 6 6", arrow: "M5 12h14M13 6l6 6-6 6",
  external: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  camera: "M4 8h3l2-3h6l2 3h3v11H4zM12 17a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z", steps: "M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01",
  globe: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18",
  cpu: "M7 7h10v10H7zM10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4", layers: "M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5",
  alert: "M12 4l9 16H3L12 4zM12 10v4M12 17h.01", bolt: "M13 3L5 14h6l-1 7 8-11h-6l1-7z",
  coins: "M12 6c4.4 0 8 1.1 8 2.5S16.4 11 12 11 4 9.9 4 8.5 7.6 6 12 6zM4 8.5v4C4 13.9 7.6 15 12 15s8-1.1 8-2.5v-4M4 12.5v4C4 17.9 7.6 19 12 19s8-1.1 8-2.5v-4",
  play: "M7 5l12 7-12 7z", stop: "M6 6h12v12H6z", target: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z", folder: "M3 6h6l2 2h10v11H3z",
};

export function icon(name: keyof typeof ICONS | string, size = 16): SVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", ICONS[name] ?? ICONS.minus!);
  svg.append(path);
  return svg;
}
