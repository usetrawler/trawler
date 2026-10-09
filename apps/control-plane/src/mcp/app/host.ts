import type { Payload, Result } from "./types.ts";

export interface Host {
  call(name: string, args: Record<string, unknown>): Promise<Result>;
  announce(text: string): void;
  open(url: string): void;
  show(payload: Payload): void;
  canGoBack(): boolean;
  back(): void;
}

export interface View {
  el: HTMLElement;
  dispose(): void;
  setActive?(active: boolean): void;
  update?(payload: Payload): void;
  key?: string;
}
