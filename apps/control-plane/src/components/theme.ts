export type ThemeChoice = "system" | "light" | "dark";

export const THEME_KEY = "trawler-theme";

export const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem("${THEME_KEY}");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}})()`;

export function storedChoice(storage: Pick<Storage, "getItem"> | undefined): ThemeChoice {
  try {
    const value = storage?.getItem(THEME_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

export function nextChoice(choice: ThemeChoice, systemDark: boolean): ThemeChoice {
  const system = systemDark ? "dark" : "light";
  const opposite = systemDark ? "light" : "dark";
  if (choice === "system") return opposite;
  return choice === opposite ? system : "system";
}
