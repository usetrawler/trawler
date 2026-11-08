"use client";
import { useEffect, useRef, type ReactNode } from "react";

export function Menu({ className, children }: { className: string; children: ReactNode }) {
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = () => {
      if (menu.current?.open) menu.current.open = false;
    };
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !menu.current?.open) return;
      close();
      menu.current.querySelector("summary")?.focus();
    };
    const leave = (event: FocusEvent) => {
      const next = event.relatedTarget as Node | null;
      if (next && !menu.current?.contains(next)) close();
    };
    const node = menu.current;
    node?.addEventListener("focusout", leave);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      node?.removeEventListener("focusout", leave);
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, []);
  return <details ref={menu} className={className}>{children}</details>;
}
