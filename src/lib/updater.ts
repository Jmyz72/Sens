import { useCallback, useRef, useState } from "react";
import type { Update } from "@tauri-apps/plugin-updater";

export type UpdateStatus = "idle" | "checking" | "current" | "available" | "downloading" | "error";
export type UpdateTone = "muted" | "accent" | "success" | "error";

export interface UpdateState {
  status: UpdateStatus;
  currentVersion: string;
  latestVersion: string | null;
  message: string;
  lastCheckedAt: string | null;
  downloadProgress: number | null;
}

export interface UpdatePanelInput {
  isDesktop: boolean;
  status: UpdateStatus;
  currentVersion: string;
  latestVersion?: string | null;
  message?: string;
  lastCheckedAt?: string | null;
  downloadProgress?: number | null;
}

export interface UpdatePanelCopy {
  tone: UpdateTone;
  title: string;
  detail: string;
  primaryAction: string;
}

export function isTauriDesktop(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function updateProgressPercent(downloaded: number, total?: number): number | null {
  if (!total || total <= 0) return null;
  return Math.min(100, Math.round((downloaded / total) * 100));
}

export function formatLastChecked(value: string | null): string {
  if (!value) return "Not checked yet";
  return new Intl.DateTimeFormat("en-MY", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function updatePanelCopy(input: UpdatePanelInput): UpdatePanelCopy {
  if (!input.isDesktop) {
    return {
      tone: "muted",
      title: "Desktop app only",
      detail: "Update checks are available in the installed Sens app.",
      primaryAction: "Check",
    };
  }

  switch (input.status) {
    case "checking":
      return {
        tone: "muted",
        title: "Checking for updates",
        detail: "Looking for a newer signed Sens release.",
        primaryAction: "Checking",
      };
    case "current":
      return {
        tone: "success",
        title: "Sens is up to date",
        detail: `You are running version ${input.currentVersion}.`,
        primaryAction: "Check again",
      };
    case "available":
      return {
        tone: "accent",
        title: "Update available",
        detail: `Sens ${input.latestVersion ?? "update"} is ready to download. You are on ${input.currentVersion}.`,
        primaryAction: "Download & Install",
      };
    case "downloading":
      return {
        tone: "accent",
        title: "Installing update",
        detail:
          input.downloadProgress === null || input.downloadProgress === undefined
            ? "Downloading and installing the update."
            : `Downloading and installing the update (${input.downloadProgress}%).`,
        primaryAction: "Installing",
      };
    case "error":
      return {
        tone: "error",
        title: "Update check failed",
        detail: input.message || "Could not check for updates.",
        primaryAction: "Try again",
      };
    case "idle":
      return {
        tone: "muted",
        title: "Automatic checks are on",
        detail: "Sens checks once after launch and never downloads updates automatically.",
        primaryAction: "Check",
      };
  }
}

export function useUpdater() {
  const desktop = isTauriDesktop();
  const pendingUpdate = useRef<Update | null>(null);
  const [state, setState] = useState<UpdateState>({
    status: "idle",
    currentVersion: __APP_VERSION__,
    latestVersion: null,
    message: "",
    lastCheckedAt: null,
    downloadProgress: null,
  });

  const checkForUpdates = useCallback(async () => {
    if (!desktop) return;

    pendingUpdate.current = null;
    setState((prev) => ({
      ...prev,
      status: "checking",
      latestVersion: null,
      message: "",
      downloadProgress: null,
    }));

    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      const checkedAt = new Date().toISOString();

      if (!update) {
        setState((prev) => ({
          ...prev,
          status: "current",
          latestVersion: null,
          message: "Sens is up to date",
          lastCheckedAt: checkedAt,
        }));
        return;
      }

      pendingUpdate.current = update;
      setState((prev) => ({
        ...prev,
        status: "available",
        latestVersion: update.version,
        message: `Sens ${update.version} is available`,
        lastCheckedAt: checkedAt,
      }));
    } catch (err) {
      setState((prev) => ({
        ...prev,
        status: "error",
        message: err instanceof Error ? err.message : "Could not check for updates",
        lastCheckedAt: new Date().toISOString(),
      }));
    }
  }, [desktop]);

  const installUpdate = useCallback(async () => {
    const update = pendingUpdate.current;
    if (!update) return;

    setState((prev) => ({
      ...prev,
      status: "downloading",
      message: `Installing Sens ${update.version}`,
      downloadProgress: null,
    }));

    try {
      let downloaded = 0;
      let total: number | undefined;

      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength;
          downloaded = 0;
          setState((prev) => ({ ...prev, downloadProgress: updateProgressPercent(downloaded, total) }));
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          setState((prev) => ({ ...prev, downloadProgress: updateProgressPercent(downloaded, total) }));
        } else {
          setState((prev) => ({ ...prev, downloadProgress: 100 }));
        }
      });

      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (err) {
      setState((prev) => ({
        ...prev,
        status: "error",
        message: err instanceof Error ? err.message : "Could not install update",
      }));
    }
  }, []);

  return {
    desktop,
    state,
    checkForUpdates,
    installUpdate,
  };
}
