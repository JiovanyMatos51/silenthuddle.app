import { invoke } from "@tauri-apps/api/core";
import type { AppLanguage } from "./i18n";
import { normalizeBackendUrl } from "./backendUrl.ts";

export interface AppSettings {
  backendUrl: string;
  lastNickname: string;
  microphoneId: string;
  speakerId: string;
  cameraId: string;
  noiseSuppression: boolean;
  callEffects: boolean;
  buttonEffects: boolean;
  messageEffects: boolean;
  sidebarCollapsed: boolean;
  avatarColor: string;
  language: AppLanguage;
}

export const DEFAULT_SETTINGS: AppSettings = {
  backendUrl: "",
  lastNickname: "",
  microphoneId: "",
  speakerId: "",
  cameraId: "",
  noiseSuppression: true,
  callEffects: true,
  buttonEffects: true,
  messageEffects: true,
  sidebarCollapsed: false,
  avatarColor: "#f2f2f2",
  language: "pt-BR",
};

const STORAGE_KEY = "p2p-app-settings";

function isTauriRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

function sanitizeSettings(value: unknown): AppSettings {
  const candidate = value && typeof value === "object" ? value as Partial<AppSettings> : {};
  let backendUrl = "";
  try { backendUrl = normalizeBackendUrl(typeof candidate.backendUrl === "string" ? candidate.backendUrl : ""); }
  catch { /* Ignore invalid values from older or manually edited settings. */ }
  return {
    backendUrl,
    lastNickname: typeof candidate.lastNickname === "string"
      ? candidate.lastNickname.trim().slice(0, 18)
      : "",
    microphoneId: typeof candidate.microphoneId === "string" ? candidate.microphoneId : "",
    speakerId: typeof candidate.speakerId === "string" ? candidate.speakerId : "",
    cameraId: typeof candidate.cameraId === "string" ? candidate.cameraId : "",
    noiseSuppression: candidate.noiseSuppression !== false,
    callEffects: candidate.callEffects !== false,
    buttonEffects: candidate.buttonEffects !== false,
    messageEffects: candidate.messageEffects !== false,
    sidebarCollapsed: candidate.sidebarCollapsed === true,
    avatarColor: typeof candidate.avatarColor === "string" ? candidate.avatarColor : DEFAULT_SETTINGS.avatarColor,
    language: candidate.language === "en-US" ? "en-US" : "pt-BR",
  };
}

export async function loadAppSettings(): Promise<AppSettings> {
  try {
    if (isTauriRuntime()) {
      const settings = await invoke<unknown>("load_app_settings");
      return sanitizeSettings(settings);
    }
    const stored = localStorage.getItem(STORAGE_KEY);
    return sanitizeSettings(stored ? JSON.parse(stored) : null);
  } catch (error) {
    console.warn("Não foi possível carregar as configurações", error);
    return { ...DEFAULT_SETTINGS };
  }
}

let saveQueue: Promise<boolean> = Promise.resolve(true);

export function saveAppSettings(settings: AppSettings): Promise<boolean> {
  const snapshot = { ...settings };
  saveQueue = saveQueue.then(() => writeAppSettings(snapshot), () => writeAppSettings(snapshot));
  return saveQueue;
}

async function writeAppSettings(settings: AppSettings): Promise<boolean> {
  try {
    if (isTauriRuntime()) {
      await invoke("save_app_settings", { settings });
      return true;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    return true;
  } catch (error) {
    console.warn("Não foi possível salvar as configurações", error);
    return false;
  }
}
