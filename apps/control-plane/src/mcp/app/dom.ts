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
    if (value === undefined || value === null || value === false) continue;
    node.setAttribute(name, value === true ? "" : String(value));
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
