// Theme context: holds the active mode (persisted), exposes the resolved token
// object, and injects base CSS (scrollbars, hover/animation classes) keyed off
// CSS variables so hover states recolor with the theme.

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { hexA, THEMES, type Theme, type ThemeMode } from "./tokens";

interface Ctx {
  theme: Theme;
  mode: ThemeMode;
  toggle: () => void;
}

const ThemeCtx = createContext<Ctx>({ theme: THEMES.dark, mode: "dark", toggle: () => {} });
export const useTheme = () => useContext(ThemeCtx).theme;
export const useThemeMode = () => useContext(ThemeCtx);

const STORE_KEY = "sens.theme";

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>(() => (localStorage.getItem(STORE_KEY) as ThemeMode) || "dark");
  const theme = THEMES[mode];

  useEffect(() => {
    localStorage.setItem(STORE_KEY, mode);
    document.body.style.background = theme.bg;
    document.body.style.colorScheme = mode;
  }, [mode, theme.bg]);

  const value = useMemo<Ctx>(() => ({ theme, mode, toggle: () => setMode((m) => (m === "dark" ? "light" : "dark")) }), [theme, mode]);

  return (
    <ThemeCtx.Provider value={value}>
      <style>{baseCss(theme)}</style>
      {children}
    </ThemeCtx.Provider>
  );
}

function baseCss(t: Theme): string {
  return `
    .sens *{box-sizing:border-box;}
    .sens{--acc:${t.accent};--acc-soft:${t.accentSoft};--row-hover:${t.rowHover};}
    .sens ::-webkit-scrollbar{width:9px;height:9px;}
    .sens ::-webkit-scrollbar-thumb{background:${hexA(t.mode === "dark" ? "#ffffff" : "#000000", 0.12)};border-radius:6px;border:2px solid transparent;background-clip:padding-box;}
    .sens ::-webkit-scrollbar-thumb:hover{background:${hexA(t.mode === "dark" ? "#ffffff" : "#000000", 0.2)};background-clip:padding-box;}
    .sens-nav{cursor:pointer;transition:background-color .12s,color .12s;}
    .sens-nav:hover{background-color:var(--row-hover);}
    .sens-row{transition:background-color .12s;}
    .sens-row.click{cursor:pointer;}
    .sens-row:hover{background-color:var(--row-hover);}
    .sens-btn{cursor:pointer;border:none;font-family:inherit;transition:filter .12s,border-color .12s,background-color .12s;display:inline-flex;align-items:center;gap:6px;white-space:nowrap;}
    .sens-btn:disabled{cursor:not-allowed;}
    .sens-btn-primary:hover:not(:disabled){filter:brightness(1.08);}
    .sens-btn-primary:active:not(:disabled){filter:brightness(.94);}
    .sens-btn-ghost:hover:not(:disabled){background-color:var(--row-hover);}
    .sens-btn-outline:hover:not(:disabled){background-color:var(--row-hover);}
    .sens-icon-btn{cursor:pointer;border:none;background:transparent;display:flex;align-items:center;justify-content:center;border-radius:8px;transition:background-color .12s;}
    .sens-icon-btn:hover{background-color:var(--row-hover);}
    .sens-pill{cursor:pointer;transition:color .12s,border-color .12s,background-color .12s;}
    .sens-pill:hover{background-color:var(--row-hover);}
    .sens-link{cursor:pointer;color:var(--acc);transition:opacity .12s;}
    .sens-link:hover{opacity:.72;}
    .sens-input{font-family:inherit;outline:none;transition:border-color .12s;}
    .sens-input:focus{border-color:var(--acc)!important;}
    .sens-screen{animation:sensFade .32s cubic-bezier(.2,.7,.3,1);}
    @keyframes sensFade{from{opacity:.4;transform:translateY(8px);}to{opacity:1;transform:translateY(0);}}
    .sens-pop{animation:sensPop .18s cubic-bezier(.2,.8,.3,1);}
    @keyframes sensPop{from{opacity:.6;transform:scale(.98) translateY(5px);}to{opacity:1;transform:scale(1) translateY(0);}}
    .sens-bar{transition:width .5s cubic-bezier(.2,.7,.3,1);}
    @keyframes sensShimmer{from{background-position:200% center;}to{background-position:-200% center;}}
    .sens-shimmer{background-size:300% 100%;animation:sensShimmer 2s linear infinite;}
    @media (prefers-reduced-motion: reduce){.sens-shimmer{animation:none;}.sens-screen{animation:none;}.sens-pop{animation:none;}}
  `;
}
