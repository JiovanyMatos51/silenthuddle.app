/* ============================================================================
 * SilentHuddle — main.ts
 *
 * Interface de desktop/Android. O encontro inicial usa signaling.ts;
 * a sala, as apresentações e a presença usam exclusivamente roomMesh.ts
 * e os DataChannels de peerManager.ts.
 * ========================================================================== */

import {
  JOIN_POLL_INTERVAL_MS,
  JOIN_POLL_MAX_ATTEMPTS,
  MAX_NICKNAME_LENGTH,
  SIGNALING_API_BASE,
} from "./config";
import { normalizeBackendUrl } from "./backendUrl";
import { nativeClipboardFiles, clearClipboardFiles, pastedFiles } from "./clipboardFiles";
import { RendezvousClient, SignalingError, type WaitingTicket } from "./signaling";
import { RoomMesh } from "./roomMesh";
import { snapshotPublicHistory, historyBatches, validHistoryEntry } from "./chatHistory";
import { PeerManager } from "./peerManager";
import { MediaService } from "./mediaService";
import { SoundService, type SoundEffect } from "./soundService";
import {
  DEFAULT_SETTINGS,
  loadAppSettings,
  saveAppSettings,
  type AppSettings,
} from "./settingsService";
import { FileStorageService, type StoredFile } from "./fileStorageService";
import { getLanguage, setLanguage, t, translateDocument, type AppLanguage } from "./i18n";
import type {
  Participant,
  ChatMessage,
  ChatReplyReference,
  PeerInfo,
  IncomingFileOffer,
  ReceivedFile,
  HistoryReaction,
  OutgoingFileSource,
} from "./types";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import cameraIconUrl from "./assets/icons/camera.svg";
import cameraOffIconUrl from "./assets/icons/camera-off.svg";
import headphoneIconUrl from "./assets/icons/headphone.svg";
import headphoneOffIconUrl from "./assets/icons/headphone-off.svg";
import micIconUrl from "./assets/icons/mic.svg";
import micOffIconUrl from "./assets/icons/mic-off.svg";
import screenIconUrl from "./assets/icons/screen.svg";
import screenOffIconUrl from "./assets/icons/screen-off.svg";
import replyIconUrl from "./assets/icons/reply.svg";
import reactionIconUrl from "./assets/icons/reaction.svg";

/* ----------------------------------------------------------------------------
 * Helpers de DOM
 * -------------------------------------------------------------------------- */

function qs<T extends HTMLElement>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`Elemento não encontrado: ${selector}`);
  return el;
}

function el<T extends HTMLElement>(id: string): T {
  return qs<T>(`#${id}`);
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString(getLanguage(), { hour: "2-digit", minute: "2-digit" });
}

async function setNativeCallService(active: boolean, cameraActive = false): Promise<void> {
  if (!("__TAURI_INTERNALS__" in window)) return;
  try {
    await invoke("set_android_call_service", { active, cameraActive });
  } catch (error) {
    console.warn("Não foi possível atualizar o serviço nativo da chamada", error);
  }
}

type SidebarPanel = "participants" | "settings";

/* ============================================================================
 * REFERÊNCIAS — TELA INICIAL
 * ========================================================================== */

const screenHome = el<HTMLElement>("screen-home");
const screenApp = el<HTMLElement>("screen-app");

const btnAvatarPicker = el<HTMLButtonElement>("btn-avatar-picker");
const btnAvatarColor = el<HTMLButtonElement>("btn-avatar-color");
const formHome = el<HTMLFormElement>("form-home");
const inputNickname = el<HTMLInputElement>("input-nickname");
const btnCreateRoom = el<HTMLButtonElement>("btn-create-room");
const btnJoinRoom = el<HTMLButtonElement>("btn-join-room");
const btnConfigureBackend = el<HTMLButtonElement>("btn-configure-backend");
const backendDialog = el<HTMLDivElement>("backend-dialog");
const formBackend = el<HTMLFormElement>("form-backend");
const inputBackendUrl = el<HTMLInputElement>("input-backend-url");
const backendStatus = el<HTMLParagraphElement>("backend-status");
const btnConfirmBackend = el<HTMLButtonElement>("btn-confirm-backend");
const btnCancelBackend = el<HTMLButtonElement>("btn-cancel-backend");

/* ============================================================================
 * REFERÊNCIAS — TOPBAR
 * ========================================================================== */

const btnToggleSettings = el<HTMLButtonElement>("btn-toggle-settings");
const btnToggleParticipants = el<HTMLButtonElement>("btn-toggle-participants");
const btnStartCall = el<HTMLButtonElement>("btn-start-call");
const btnAddFriend = el<HTMLButtonElement>("btn-add-friend");
const btnLeaveRoom = el<HTMLButtonElement>("btn-leave-room");

/* ============================================================================
 * REFERÊNCIAS — SIDEBAR
 * ========================================================================== */

const sidebarParticipantsPanel = el<HTMLDivElement>("sidebar-participants");
const sidebarSettingsPanel = el<HTMLDivElement>("sidebar-settings");
const sidebar = el<HTMLElement>("sidebar");
const btnToggleSidebar = el<HTMLButtonElement>("btn-toggle-sidebar");
const connectedCountEl = el<HTMLParagraphElement>("connected-count");
const participantsListEl = el<HTMLUListElement>("participants-list");
const selectMicrophone = el<HTMLSelectElement>("select-microphone");
const selectSpeaker = el<HTMLSelectElement>("select-speaker");
const selectCamera = el<HTMLSelectElement>("select-camera");
const settingNoiseSuppression = el<HTMLInputElement>("setting-noise-suppression");
const settingCallEffects = el<HTMLInputElement>("setting-call-effects");
const settingButtonEffects = el<HTMLInputElement>("setting-button-effects");
const settingMessageEffects = el<HTMLInputElement>("setting-message-effects");

/* ============================================================================
 * REFERÊNCIAS — ÁREA DE VÍDEO / CALL
 * ========================================================================== */

const videoArea = el<HTMLElement>("video-area");
const mainContent = qs<HTMLElement>(".main-content");
const videoGrid = el<HTMLDivElement>("video-grid");
const screenShareView = el<HTMLDivElement>("screen-share-view");
const screenShareMain = el<HTMLDivElement>("screen-share-main");
const screenShareStream = el<HTMLVideoElement>("screen-share-stream");
const screenShareThumbs = el<HTMLDivElement>("screen-share-thumbs");
const btnStopWatchingScreen = el<HTMLButtonElement>("btn-stop-watching-screen");
const btnScreenPip = el<HTMLButtonElement>("btn-screen-pip");
const btnScreenFullscreen = el<HTMLButtonElement>("btn-screen-fullscreen");
const btnJoinCall = el<HTMLButtonElement>("btn-join-call");
const watchingLabel = el<HTMLParagraphElement>("watching-label");
const watchingUsernameEl = el<HTMLSpanElement>("watching-username");
const callControls = el<HTMLDivElement>("call-controls");
const btnToggleMic = el<HTMLButtonElement>("btn-toggle-mic");
const btnToggleSpeaker = el<HTMLButtonElement>("btn-toggle-speaker");
const btnToggleCamera = el<HTMLButtonElement>("btn-toggle-camera");
const btnToggleScreenshare = el<HTMLButtonElement>("btn-toggle-screenshare");
const btnLeaveCall = el<HTMLButtonElement>("btn-leave-call");

void videoArea;

/* ============================================================================
 * REFERÊNCIAS — CHAT
 * ========================================================================== */

const chatMessagesEl = el<HTMLDivElement>("chat-messages");
const formChat = el<HTMLFormElement>("form-chat");
const inputChat = el<HTMLInputElement>("input-chat");
const btnAttachFile = el<HTMLButtonElement>("btn-attach-file");
const btnEmojiPicker = el<HTMLButtonElement>("btn-emoji-picker");
const emojiPicker = el<HTMLDivElement>("emoji-picker");
const replyContext = el<HTMLDivElement>("reply-context");
const replyContextText = el<HTMLSpanElement>("reply-context-text");
const btnCancelReply = el<HTMLButtonElement>("btn-cancel-reply");
const btnLanguagePt = el<HTMLButtonElement>("btn-language-pt");
const btnLanguageEn = el<HTMLButtonElement>("btn-language-en");
const btnLanguageSettingsPt = el<HTMLButtonElement>("btn-language-settings-pt");
const btnLanguageSettingsEn = el<HTMLButtonElement>("btn-language-settings-en");
const fileLightbox = el<HTMLDivElement>("file-lightbox");
const fileLightboxImage = el<HTMLImageElement>("file-lightbox-image");
const btnCloseFileLightbox = el<HTMLButtonElement>("btn-close-file-lightbox");

const ICON_URLS = {
  camera: cameraIconUrl,
  cameraOff: cameraOffIconUrl,
  headphone: headphoneIconUrl,
  headphoneOff: headphoneOffIconUrl,
  mic: micIconUrl,
  micOff: micOffIconUrl,
  screen: screenIconUrl,
  screenOff: screenOffIconUrl,
  reply: replyIconUrl,
  reaction: reactionIconUrl,
} as const;

type ControlIconName = "mic" | "headphone" | "camera" | "screen";

const CONTROL_ICON_URLS: Record<ControlIconName, { on: string; off: string }> = {
  mic: { on: ICON_URLS.mic, off: ICON_URLS.micOff },
  headphone: { on: ICON_URLS.headphone, off: ICON_URLS.headphoneOff },
  camera: { on: ICON_URLS.camera, off: ICON_URLS.cameraOff },
  screen: { on: ICON_URLS.screen, off: ICON_URLS.screenOff },
};

/* ============================================================================
 * ESTADO DA SESSÃO P2P
 * ========================================================================== */

const mediaService = new MediaService();
const soundService = new SoundService();
const fileStorageService = new FileStorageService();

const rendezvous = new RendezvousClient(() => appSettings.backendUrl || SIGNALING_API_BASE);
let roomMesh: RoomMesh | null = null;
let roomEpoch = 0;
let peerManager: PeerManager | null = null;
let selfParticipant: Participant | null = null;

const participants = new Map<string, Participant>();
/** peers cuja câmera nós pedimos para ver ativamente (click-to-view) */
const videoSubscriptions = new Set<string>();
/** peers cuja transmissão de tela está sendo recebida ou foi solicitada */
const screenSubscriptions = new Set<string>();
/** streams remotas em cache, reanexadas a cada re-render da grid */
const remoteStreams = new Map<string, { camera?: MediaStream; screen?: MediaStream }>();
const remoteAudioEls = new Map<string, HTMLAudioElement>();
const remoteVoiceStreams = new Map<string, MediaStream>();
const remoteScreenAudioEls = new Map<string, HTMLAudioElement>();
const participantVoiceVolumes = new Map<string, number>();
let watchingScreenPeerId: string | null = null;
let screenFullscreenPeerId: string | null = null;
let screenFullscreenRequest = 0;
let pingTimer: number | null = null;

interface RemoteVoiceController {
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  gain: GainNode;
}

const remoteVoiceControllers = new Map<string, RemoteVoiceController>();

interface IncomingFileView {
  offer: IncomingFileOffer;
  card: HTMLDivElement;
  status: HTMLParagraphElement;
  progress: HTMLDivElement;
  progressBar: HTMLDivElement;
  actions: HTMLDivElement;
  handled: boolean;
}

const incomingFileViews = new Map<string, IncomingFileView>();
const outgoingPreviewUrls = new Set<string>();

interface ChatMessageView {
  message: ChatMessage;
  wrapper: HTMLDivElement;
  reactionsElement: HTMLDivElement;
  reactions: Map<string, Set<string>>;
  reactionEvents: Map<string, HistoryReaction>;
}

type ReactionEvent = HistoryReaction;

const chatMessageViews = new Map<string, ChatMessageView>();
const fileHistory = new Map<string, { message: ChatMessage; reactions: Map<string, Set<string>> }>();
const pendingReactionEvents = new Map<string, ReactionEvent[]>();
let pendingReply: ChatReplyReference | null = null;
let openMessageReactionPicker: HTMLDivElement | null = null;

function fileTransferKey(peerId: string, fileId: string): string {
  return `${peerId}:${fileId}`;
}

/* ============================================================================
 * MENU DE CONTEXTO — volume individual de voz
 * ========================================================================== */

const participantVolumePopup = document.createElement("div");
participantVolumePopup.className = "participant-volume-popup hidden";
participantVolumePopup.setAttribute("role", "dialog");

const participantVolumeLabel = document.createElement("label");
participantVolumeLabel.className = "participant-volume-popup__label";
const participantVolumeName = document.createElement("span");
const participantVolumeValue = document.createElement("strong");
participantVolumeLabel.append(participantVolumeName, participantVolumeValue);

const participantVolumeSlider = document.createElement("input");
participantVolumeSlider.className = "participant-volume-popup__slider";
participantVolumeSlider.type = "range";
participantVolumeSlider.min = "0";
participantVolumeSlider.max = "200";
participantVolumeSlider.step = "1";
participantVolumePopup.append(participantVolumeLabel, participantVolumeSlider);
document.body.appendChild(participantVolumePopup);

let volumePopupPeerId: string | null = null;

function setParticipantVoiceVolume(peerId: string, percentage: number): void {
  const normalized = Math.max(0, Math.min(200, Math.round(percentage)));
  participantVoiceVolumes.set(peerId, normalized);
  void applyParticipantVoiceVolume(peerId);
  participantVolumeValue.textContent = `${normalized}%`;
}

function openParticipantVolumePopup(peerId: string, clientX: number, clientY: number): void {
  if (peerId === selfParticipant?.id) return;
  const participant = participants.get(peerId);
  if (!participant) return;

  volumePopupPeerId = peerId;
  const value = participantVoiceVolumes.get(peerId) ?? 100;
  participantVolumeName.textContent = t("voiceVolume", { name: participant.nickname });
  participantVolumeValue.textContent = `${value}%`;
  participantVolumeSlider.value = String(value);
  participantVolumePopup.classList.remove("hidden");

  const popupWidth = 270;
  const popupHeight = 92;
  participantVolumePopup.style.left = `${Math.max(8, Math.min(clientX, window.innerWidth - popupWidth - 8))}px`;
  participantVolumePopup.style.top = `${Math.max(8, Math.min(clientY, window.innerHeight - popupHeight - 8))}px`;
  participantVolumeSlider.focus({ preventScroll: true });
}

function closeParticipantVolumePopup(): void {
  participantVolumePopup.classList.add("hidden");
  volumePopupPeerId = null;
}

function addParticipantVolumeMenu(element: HTMLElement, peerId: string): void {
  if (peerId === selfParticipant?.id) return;
  element.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openParticipantVolumePopup(peerId, event.clientX, event.clientY);
  });
}

participantVolumeSlider.addEventListener("input", () => {
  if (volumePopupPeerId) setParticipantVoiceVolume(volumePopupPeerId, Number(participantVolumeSlider.value));
});

// O WebView não deve expor o menu de navegador (Salvar como, inspecionar etc.).
document.addEventListener("contextmenu", (event) => {
  event.preventDefault();
});

document.addEventListener("pointerdown", (event) => {
  const target = event.target;
  if (target instanceof Node && !participantVolumePopup.contains(target)) closeParticipantVolumePopup();
});

window.addEventListener("blur", closeParticipantVolumePopup);
window.addEventListener("resize", closeParticipantVolumePopup);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeParticipantVolumePopup();
});

/* ============================================================================
 * NAVEGAÇÃO ENTRE TELAS
 * ========================================================================== */

function showScreen(screen: "home" | "app"): void {
  screenHome.classList.toggle("hidden", screen !== "home");
  screenApp.classList.toggle("hidden", screen !== "app");
}

/* ============================================================================
 * TELA INICIAL — avatar
 * ========================================================================== */

const AVATAR_COLORS = ["#f2f2f2", "#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#a855f7", "#ec4899"];
let avatarColorIndex = 0;
let localAvatarColor = AVATAR_COLORS[0];
let appSettings: AppSettings = { ...DEFAULT_SETTINGS };
let saveSettingsTimer: number | null = null;

setLanguage(appSettings.language);
translateDocument();
updateLanguageButtons();

const settingsReady = Promise.all([loadAppSettings(), fileStorageService.cleanup()]).then(([loaded]) => {
  appSettings = loaded;
  inputNickname.value = loaded.lastNickname;
  applyLanguage(loaded.language, false);
  localAvatarColor = loaded.avatarColor;
  const savedColorIndex = AVATAR_COLORS.indexOf(localAvatarColor);
  avatarColorIndex = savedColorIndex >= 0 ? savedColorIndex : 0;
  btnAvatarPicker.style.borderColor = localAvatarColor;
  const avatarIcon = btnAvatarPicker.querySelector<HTMLImageElement>("img");
  if (avatarIcon) avatarIcon.style.color = localAvatarColor;
  settingNoiseSuppression.checked = loaded.noiseSuppression;
  settingCallEffects.checked = loaded.callEffects;
  settingButtonEffects.checked = loaded.buttonEffects;
  settingMessageEffects.checked = loaded.messageEffects;
  mediaService.setAudioProcessing(loaded.noiseSuppression);
  setSidebarCollapsed(loaded.sidebarCollapsed, false);
});

function applyLanguage(language: AppLanguage, persist = true): void {
  setLanguage(language);
  appSettings.language = language;
  translateDocument();
  updateLanguageButtons();
  updateScreenFullscreenButton();
  if (pendingReply) replyContextText.textContent = t("replyingComposer", { name: pendingReply.nickname });
  setSidebarCollapsed(sidebar.classList.contains("sidebar--collapsed"), false);
  if (selfParticipant) {
    refreshParticipantsUI();
    refreshVideoGridUI();
  } else {
    connectedCountEl.textContent = t("connected", { count: participants.size });
  }
  if (persist) persistSettings();
}

function updateLanguageButtons(): void {
  const portuguese = getLanguage() === "pt-BR";
  for (const button of [btnLanguagePt, btnLanguageSettingsPt]) {
    button.classList.toggle("is-active", portuguese);
  }
  for (const button of [btnLanguageEn, btnLanguageSettingsEn]) {
    button.classList.toggle("is-active", !portuguese);
  }
}

btnLanguagePt.addEventListener("click", () => applyLanguage("pt-BR"));
btnLanguageEn.addEventListener("click", () => applyLanguage("en-US"));
btnLanguageSettingsPt.addEventListener("click", () => applyLanguage("pt-BR"));
btnLanguageSettingsEn.addEventListener("click", () => applyLanguage("en-US"));

function persistSettings(): void {
  if (saveSettingsTimer !== null) window.clearTimeout(saveSettingsTimer);
  saveSettingsTimer = window.setTimeout(() => {
    saveSettingsTimer = null;
    void saveAppSettings(appSettings);
  }, 120);
}

let backendSaveBusy = false;
btnConfigureBackend.addEventListener("click", () => {
  void settingsReady.then(() => {
    inputBackendUrl.value = appSettings.backendUrl;
    inputBackendUrl.setCustomValidity("");
    backendStatus.textContent = "";
    backendDialog.classList.remove("hidden");
    inputBackendUrl.focus();
  });
});

function closeBackendDialog(): void {
  if (backendSaveBusy) return;
  backendDialog.classList.add("hidden");
  btnConfigureBackend.focus();
}
btnCancelBackend.addEventListener("click", closeBackendDialog);
inputBackendUrl.addEventListener("input", () => {
  inputBackendUrl.setCustomValidity("");
  backendStatus.textContent = "";
});
formBackend.addEventListener("submit", (event) => {
  event.preventDefault();
  void confirmBackendSettings();
});

async function confirmBackendSettings(): Promise<void> {
  if (backendSaveBusy) return;
  let backendUrl: string;
  try { backendUrl = normalizeBackendUrl(inputBackendUrl.value); }
  catch {
    backendStatus.textContent = t("backendUrlInvalid");
    inputBackendUrl.setCustomValidity(t("backendUrlInvalid"));
    inputBackendUrl.reportValidity();
    return;
  }
  backendSaveBusy = true;
  btnConfirmBackend.disabled = btnCancelBackend.disabled = inputBackendUrl.disabled = true;
  const previous = appSettings.backendUrl;
  appSettings.backendUrl = backendUrl;
  if (saveSettingsTimer !== null) window.clearTimeout(saveSettingsTimer);
  saveSettingsTimer = null;
  const saved = await saveAppSettings(appSettings);
  backendSaveBusy = false;
  btnConfirmBackend.disabled = btnCancelBackend.disabled = inputBackendUrl.disabled = false;
  if (saved) closeBackendDialog();
  else {
    appSettings.backendUrl = previous;
    backendStatus.textContent = t("settingsSaveFailed");
  }
}

function playEffect(effect: SoundEffect, category: "call" | "button" | "message"): void {
  const enabled = category === "call"
    ? appSettings.callEffects
    : category === "button"
      ? appSettings.buttonEffects
      : appSettings.messageEffects;
  if (enabled) void soundService.play(effect);
}

function setSidebarCollapsed(collapsed: boolean, persist = true): void {
  sidebar.classList.toggle("sidebar--collapsed", collapsed);
  btnToggleSidebar.setAttribute("aria-expanded", String(!collapsed));
  btnToggleSidebar.title = collapsed ? t("expandSidebar") : t("collapseSidebar");
  btnToggleSidebar.setAttribute("aria-label", btnToggleSidebar.title);
  appSettings.sidebarCollapsed = collapsed;
  if (persist) persistSettings();
}

btnToggleSidebar.addEventListener("click", () => {
  setSidebarCollapsed(!sidebar.classList.contains("sidebar--collapsed"));
});

const avatarImageInput = document.createElement("input");
avatarImageInput.type = "file";
avatarImageInput.accept = "image/*";
avatarImageInput.style.display = "none";
document.body.appendChild(avatarImageInput);

btnAvatarPicker.addEventListener("click", () => avatarImageInput.click());

avatarImageInput.addEventListener("change", () => {
  const file = avatarImageInput.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const icon = btnAvatarPicker.querySelector<HTMLImageElement>("img");
    if (icon && typeof reader.result === "string") icon.src = reader.result;
  };
  reader.readAsDataURL(file);
});

btnAvatarColor.addEventListener("click", () => {
  avatarColorIndex = (avatarColorIndex + 1) % AVATAR_COLORS.length;
  localAvatarColor = AVATAR_COLORS[avatarColorIndex];
  btnAvatarPicker.style.borderColor = localAvatarColor;
  const icon = btnAvatarPicker.querySelector("img");
  if (icon) icon.style.color = localAvatarColor;
  appSettings.avatarColor = localAvatarColor;
  persistSettings();

  if (selfParticipant) {
    selfParticipant.avatarColor = localAvatarColor;
    refreshParticipantsUI();
    broadcastPresence();
  }
});

/* ============================================================================
 * TELA INICIAL — criar / entrar em uma sala
 * ========================================================================== */

const joinDialog = el<HTMLDivElement>("join-dialog");
const joinCodeEl = el<HTMLOutputElement>("join-code");
const joinStatus = el<HTMLParagraphElement>("join-status");
const btnCopyJoinCode = el<HTMLButtonElement>("btn-copy-join-code");
const btnConfirmJoin = el<HTMLButtonElement>("btn-confirm-join");
const btnCancelJoin = el<HTMLButtonElement>("btn-cancel-join");
const btnRegenerateJoin = el<HTMLButtonElement>("btn-regenerate-join");
const addFriendDialog = el<HTMLDivElement>("add-friend-dialog");
const formAddFriend = el<HTMLFormElement>("form-add-friend");
const inputFriendCode = el<HTMLInputElement>("input-friend-code");
const addFriendStatus = el<HTMLParagraphElement>("add-friend-status");
const btnConfirmFriend = el<HTMLButtonElement>("btn-confirm-friend");
const btnCancelFriend = el<HTMLButtonElement>("btn-cancel-friend");

interface PendingJoin {
  ticket?: WaitingTicket;
  pendingPeerId: string;
  sponsorId?: string;
  attempts: number;
  lastPollAt: number;
  inFlight: boolean;
  matched: boolean;
  released?: boolean;
  timer?: number;
  expirationTimer?: number;
  cooldownTimer?: number;
}

let pendingJoin: PendingJoin | null = null;
let addFriendBusy = false;

formHome.addEventListener("submit", (event) => {
  event.preventDefault();
  void soundService.unlock();
  void handleCreateRoom();
});
btnJoinRoom.addEventListener("click", () => {
  void soundService.unlock();
  void handleJoinRoom();
});

function getNickname(): string | null {
  const nickname = inputNickname.value.trim() || t("anonymous");
  if (nickname.length > MAX_NICKNAME_LENGTH) {
    window.alert(t("nicknameTooLong", { max: MAX_NICKNAME_LENGTH }));
    inputNickname.focus();
    return null;
  }
  return nickname;
}

function setRoomFormBusy(busy: boolean): void {
  btnCreateRoom.disabled = busy;
  btnJoinRoom.disabled = busy;
}

function getSelfPeer(): PeerInfo {
  return {
    peerId: selfParticipant!.id, nickname: selfParticipant!.nickname,
    color: selfParticipant!.avatarColor ?? "#f2f2f2", lastSeen: Date.now(),
  };
}

function initializeRoom(nickname: string, roomId: string | null): PeerManager {
  const peerId = crypto.randomUUID();
  selfParticipant = {
    id: peerId, nickname, avatarColor: localAvatarColor, inCall: false,
    micOn: false, audioOn: true, cameraOn: false, screenSharing: false, speaking: false,
  };
  appSettings.lastNickname = nickname;
  inputNickname.value = nickname;
  persistSettings();
  participants.set(peerId, selfParticipant);
  const manager = new PeerManager(peerId);
  peerManager = manager;
  roomMesh = new RoomMesh(manager, getSelfPeer, {
    onMember: ensurePeerDiscovered,
    onMemberLeft: handlePeerLeft,
    onJoined: () => {
      if (peerManager !== manager) return;
      stopJoinWaiting();
      joinDialog.classList.add("hidden");
      setRoomFormBusy(false);
      enterRoom();
    },
    onHistoryRequested: (id) => { void sendChatHistory(manager, id); },
  }, roomId);
  wirePeerManagerCallbacks(manager);
  startPingMonitor(manager);
  return manager;
}

async function handleCreateRoom(): Promise<void> {
  await settingsReady;
  if (selfParticipant) return;
  const nickname = getNickname();
  if (!nickname) return;
  initializeRoom(nickname, crypto.randomUUID());
  enterRoom();
}

function enterRoom(): void {
  if (window.matchMedia("(max-width: 640px)").matches) setSidebarCollapsed(true, false);
  showScreen("app");
  refreshParticipantsUI();
  void populateDeviceSelects();
  playEffect("channel-join", "call");
  inputChat.focus();
}

async function handleJoinRoom(): Promise<void> {
  await settingsReady;
  if (selfParticipant) return;
  const nickname = getNickname();
  if (!nickname) return;
  const manager = initializeRoom(nickname, null);
  const pending: PendingJoin = {
    pendingPeerId: `waiting-${crypto.randomUUID()}`,
    attempts: 0, lastPollAt: 0, inFlight: false, matched: false,
  };
  pendingJoin = pending;
  setRoomFormBusy(true);
  joinDialog.classList.remove("hidden");
  btnCancelJoin.focus();
  joinCodeEl.textContent = "·····";
  joinStatus.textContent = t("joinPreparing");
  btnConfirmJoin.disabled = true;
  btnCopyJoinCode.disabled = true;
  btnRegenerateJoin.classList.add("hidden");
  try {
    const offer = await manager.createOffer(pending.pendingPeerId);
    if (pendingJoin !== pending) return;
    const ticket = await rendezvous.register(selfParticipant!.id, offer);
    if (pendingJoin !== pending) {
      void rendezvous.cancel(ticket).catch(() => undefined);
      return;
    }
    pending.ticket = ticket;
    joinCodeEl.textContent = ticket.code;
    joinStatus.textContent = t("joinWaiting", { count: 0, max: JOIN_POLL_MAX_ATTEMPTS });
    btnConfirmJoin.disabled = false;
    btnCopyJoinCode.disabled = false;
    btnCopyJoinCode.focus();
    pending.expirationTimer = window.setTimeout(() => failPendingJoin(t("codeExpired")),
      Math.max(0, ticket.expiresAt - Date.now()));
    scheduleJoinCheck(pending);
  } catch (error) {
    if (pendingJoin === pending) failPendingJoin(error instanceof SignalingError
      ? localizeSignalingError(error) : t("joinFailed"));
  }
}

function scheduleJoinCheck(pending: PendingJoin): void {
  if (pendingJoin !== pending || pending.matched || pending.attempts >= JOIN_POLL_MAX_ATTEMPTS) return;
  if (pending.timer !== undefined) window.clearTimeout(pending.timer);
  pending.timer = window.setTimeout(() => { void checkPendingJoin(false); }, JOIN_POLL_INTERVAL_MS);
}

async function checkPendingJoin(manual: boolean): Promise<void> {
  const pending = pendingJoin;
  if (!pending?.ticket || pending.inFlight || pending.matched) return;
  if (Date.now() - pending.lastPollAt < JOIN_POLL_INTERVAL_MS) {
    scheduleJoinCheck(pending);
    return;
  }
  if (pending.timer !== undefined) window.clearTimeout(pending.timer);
  pending.inFlight = true;
  pending.lastPollAt = Date.now();
  if (!manual) pending.attempts++;
  btnConfirmJoin.disabled = true;
  try {
    const match = await rendezvous.poll(pending.ticket);
    if (pendingJoin !== pending) return;
    if (match.answer) {
      pending.matched = true;
      pending.sponsorId = match.answer.peerId;
      if (pending.expirationTimer !== undefined) window.clearTimeout(pending.expirationTimer);
      joinStatus.textContent = t("joinConnecting");
      roomMesh!.expectSponsor(match.answer.peerId);
      releaseWaitingTicket(pending);
      await peerManager!.acceptAnswer(match.answer.peerId, match.answer.sdp, pending.pendingPeerId);
      if (pendingJoin !== pending) return;
      pending.expirationTimer = window.setTimeout(() => failPendingJoin(t("joinFailed")), 20_000);
      return;
    }
    joinStatus.textContent = pending.attempts >= JOIN_POLL_MAX_ATTEMPTS
      ? t("joinPollingStopped")
      : t("joinWaiting", { count: pending.attempts, max: JOIN_POLL_MAX_ATTEMPTS });
  } catch (error) {
    if (pendingJoin !== pending) return;
    if (pending.matched || error instanceof SignalingError && ["CODE_NOT_FOUND", "INVALID_TOKEN", "CLIENT_OUTDATED"].includes(error.code)) {
      failPendingJoin(error instanceof SignalingError ? localizeSignalingError(error) : t("joinFailed"));
      return;
    }
    joinStatus.textContent = error instanceof SignalingError ? localizeSignalingError(error) : t("joinFailed");
  } finally {
    pending.inFlight = false;
    if (pendingJoin === pending && !pending.matched && btnRegenerateJoin.classList.contains("hidden")) {
      pending.cooldownTimer = window.setTimeout(() => {
        if (pendingJoin === pending && !pending.matched) btnConfirmJoin.disabled = false;
      }, Math.max(0, JOIN_POLL_INTERVAL_MS - (Date.now() - pending.lastPollAt)));
      scheduleJoinCheck(pending);
    }
  }
}

function clearJoinTimers(pending: PendingJoin): void {
  for (const timer of [pending.timer, pending.expirationTimer, pending.cooldownTimer]) {
    if (timer !== undefined) window.clearTimeout(timer);
  }
}

function failPendingJoin(message: string): void {
  if (!pendingJoin) return;
  clearJoinTimers(pendingJoin);
  pendingJoin.matched = true;
  releaseWaitingTicket(pendingJoin);
  roomMesh?.stop();
  peerManager?.closeAll();
  joinStatus.textContent = message;
  btnConfirmJoin.disabled = true;
  btnRegenerateJoin.classList.remove("hidden");
  btnCopyJoinCode.disabled = true;
}

function releaseWaitingTicket(pending: PendingJoin): void {
  if (pending.ticket && !pending.released) {
    pending.released = true;
    void rendezvous.cancel(pending.ticket).catch(() => undefined);
  }
}

function stopJoinWaiting(): void {
  const pending = pendingJoin;
  pendingJoin = null;
  if (pending) {
    clearJoinTimers(pending);
    releaseWaitingTicket(pending);
  }
}

btnConfirmJoin.addEventListener("click", () => { void checkPendingJoin(true); });
btnCancelJoin.addEventListener("click", () => leaveRoomSession(false));
btnRegenerateJoin.addEventListener("click", () => {
  leaveRoomSession(false);
  void handleJoinRoom();
});
btnCopyJoinCode.addEventListener("click", () => {
  if (!pendingJoin?.ticket) return;
  const ticket = pendingJoin.ticket;
  void copyText(ticket.code).then((copied) => {
    if (pendingJoin?.ticket === ticket) joinStatus.textContent = t(copied ? "codeCopied" : "copyFailed");
  });
});

async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    const temporary = document.createElement("textarea");
    temporary.value = value;
    temporary.style.position = "fixed";
    temporary.style.opacity = "0";
    document.body.appendChild(temporary);
    temporary.select();
    const copied = document.execCommand("copy");
    temporary.remove();
    return copied;
  }
}

btnAddFriend.addEventListener("click", () => {
  if (!selfParticipant || pendingJoin) return;
  inputFriendCode.value = "";
  addFriendStatus.textContent = "";
  addFriendDialog.classList.remove("hidden");
  inputFriendCode.focus();
});
inputFriendCode.addEventListener("input", () => {
  inputFriendCode.value = inputFriendCode.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 5);
});
btnCancelFriend.addEventListener("click", () => {
  if (!addFriendBusy) addFriendDialog.classList.add("hidden");
});
formAddFriend.addEventListener("submit", (event) => {
  event.preventDefault();
  void addFriend();
});

async function addFriend(): Promise<void> {
  const code = inputFriendCode.value.trim().toUpperCase();
  if (!/^[A-Z]{5}$/.test(code)) {
    addFriendStatus.textContent = t("invalidCode");
    return;
  }
  const manager = peerManager;
  const mesh = roomMesh;
  const localId = selfParticipant?.id;
  const epoch = roomEpoch;
  if (!manager || !mesh || !localId || addFriendBusy) return;
  addFriendBusy = true;
  btnConfirmFriend.disabled = true;
  addFriendStatus.textContent = t("addingFriend");
  let remoteId: string | undefined;
  try {
    const claimed = await rendezvous.claim(code, localId);
    if (roomEpoch !== epoch) return;
    remoteId = claimed.peerId;
    mesh.admit(remoteId);
    const answer = await manager.acceptOffer(remoteId, claimed.offer);
    if (roomEpoch !== epoch) return;
    await rendezvous.answer(code, localId, claimed.claimToken, answer);
    if (roomEpoch !== epoch) return;
    addFriendStatus.textContent = t("friendAdded");
    addFriendDialog.classList.add("hidden");
  } catch (error) {
    if (roomEpoch !== epoch) return;
    if (remoteId) mesh.forgetAdmission(remoteId);
    addFriendStatus.textContent = error instanceof SignalingError
      ? localizeSignalingError(error) : t("joinFailed");
  } finally {
    if (roomEpoch === epoch) {
      addFriendBusy = false;
      btnConfirmFriend.disabled = false;
    }
  }
}

function ensurePeerDiscovered(peer: PeerInfo): void {
  if (peer.peerId === selfParticipant?.id) return;
  if (!participants.has(peer.peerId)) {
    participants.set(peer.peerId, {
      id: peer.peerId, nickname: peer.nickname, avatarColor: peer.color,
      inCall: false, micOn: false, audioOn: true, cameraOn: false, screenSharing: false,
    });
    refreshParticipantsUI();
  }
}

function handlePeerLeft(peerId: string): void {
  const departedParticipant = participants.get(peerId);
  if (departedParticipant?.inCall && selfParticipant?.inCall) playEffect("call-leave", "call");
  if (departedParticipant) {
    const delay = departedParticipant.inCall && selfParticipant?.inCall ? 300 : 0;
    window.setTimeout(() => playEffect("channel-leave", "call"), delay);
  }
  participants.delete(peerId);
  videoSubscriptions.delete(peerId);
  screenSubscriptions.delete(peerId);
  remoteStreams.delete(peerId);
  removeRemoteAudio(peerId);
  removeRemoteScreenAudio(peerId);
  participantVoiceVolumes.delete(peerId);
  peerManager?.closePeer(peerId);
  if (pendingReply?.peerId === peerId) clearPendingReply();
  refreshParticipantsUI();
  refreshVideoGridUI();
  syncCallEntryUI();

  if (watchingScreenPeerId === peerId) {
    // se estávamos assistindo a tela de quem saiu, volta para a grid
    hideScreenShareView();
  }
}

/* ============================================================================
 * PEERMANAGER — callbacks (dados, mídia, arquivos)
 * ========================================================================== */

function wirePeerManagerCallbacks(manager: PeerManager): void {
  manager.setCallbacks({
    onChannelOpen: (peerId) => {
      if (peerManager !== manager) return;
      roomMesh?.channelOpened(peerId);
      sendPresenceTo(peerId);
      if (!pendingJoin) playEffect("channel-join", "call");
      void refreshPeerPings(manager);
      if (selfParticipant?.inCall && participants.get(peerId)?.inCall) syncCallMediaToPeer(manager, peerId);
    },

    onMessage: (peerId, message) => {
      if (peerManager !== manager || roomMesh?.handle(peerId, message)) return;
      if (!roomMesh?.isMember(peerId)) return;
      switch (message.type) {
        case "presence": {
          if (typeof message.nickname !== "string" || message.nickname.length > 18
            || typeof message.color !== "string" || message.color.length > 64
            || [message.inCall, message.micOn, message.audioOn, message.cameraOn, message.screenSharing]
              .some((flag) => typeof flag !== "boolean")) return;
          const participant = participants.get(peerId);
          if (!participant) return;
          const wasInCall = participant.inCall;
          const hadActiveCall = Array.from(participants.values()).some(
            (item) => item.id !== peerId && item.inCall,
          );
          participant.nickname = message.nickname || participant.nickname;
          participant.avatarColor = message.color || participant.avatarColor;
          participant.inCall = message.inCall;
          participant.micOn = message.micOn;
          participant.audioOn = message.audioOn !== false;
          participant.cameraOn = message.cameraOn;
          participant.screenSharing = message.screenSharing;
          roomMesh.updateIdentity(peerId, participant.nickname, participant.avatarColor ?? "#f2f2f2");

          if (message.inCall && !wasInCall) {
            if (!hadActiveCall) playEffect("call-start", "call");
            if (selfParticipant?.inCall) playEffect("call-join", "call");
          } else if (!message.inCall && wasInCall && selfParticipant?.inCall) {
            playEffect("call-leave", "call");
          }

          if (selfParticipant?.inCall && message.inCall && !wasInCall) {
            syncCallMediaToPeer(manager, peerId);
          } else if (!message.inCall && wasInCall) {
            manager.removeCallMediaFromPeer(peerId);
            videoSubscriptions.delete(peerId);
            screenSubscriptions.delete(peerId);
            remoteStreams.delete(peerId);
            removeRemoteAudio(peerId);
            removeRemoteScreenAudio(peerId);
            if (watchingScreenPeerId === peerId) hideScreenShareView();
          }

          if (selfParticipant?.inCall && message.inCall && message.cameraOn && !videoSubscriptions.has(peerId)) {
            videoSubscriptions.add(peerId);
            manager.sendTo(peerId, { type: "video-request" });
          } else if (!message.cameraOn) {
            videoSubscriptions.delete(peerId);
          }

          refreshParticipantsUI();
          refreshVideoGridUI();
          syncCallEntryUI();

          const sharedScreen = remoteStreams.get(peerId)?.screen;
          if (message.screenSharing && sharedScreen && selfParticipant?.inCall) {
            showScreenShareView(participant, Array.from(participants.values()).filter((item) => item.inCall));
            attachFocusedScreenStream(sharedScreen);
          }

          if (!message.screenSharing && watchingScreenPeerId === peerId) {
            hideScreenShareView();
          }
          return;
        }

        case "chat": {
          if (typeof message.text !== "string" || message.text.length > 8_192
            || typeof message.messageId !== "string" || message.messageId.length > 64
            || typeof message.time !== "string" || message.time.length > 32
            || !["normal", "warn", "private"].includes(message.kind)
            || message.replyTo && (typeof message.replyTo.peerId !== "string" || typeof message.replyTo.nickname !== "string"
              || message.replyTo.peerId.length > 64 || message.replyTo.nickname.length > 18)) return;
          const participant = participants.get(peerId);
          const kind = message.kind ?? "normal";
          appendChatMessage({
            id: message.messageId || crypto.randomUUID(),
            authorId: peerId,
            author: participant?.nickname ?? "Peer",
            text: message.text,
            time: message.time,
            createdAt: Number.isFinite(message.createdAt) ? message.createdAt : Date.now(),
            avatarColor: participant?.avatarColor,
            kind,
            replyTo: message.replyTo,
            highlighted: kind === "warn" || kind === "private" || message.replyTo?.peerId === selfParticipant?.id,
            notice: kind === "private" ? t("privateReceivedNotice") : undefined,
            actions: kind !== "private",
          });
          playEffect("message", "message");
          return;
        }

        case "reaction":
          if (typeof message.messageId !== "string" || message.messageId.length > 64
            || typeof message.emoji !== "string" || typeof message.active !== "boolean") return;
          applyReactionEvent(message.messageId, {
            peerId,
            emoji: message.emoji,
            active: message.active,
            revision: message.revision,
          });
          return;

        case "history-batch":
          if (!Array.isArray(message.entries) || message.entries.length > 250) return;
          for (const entry of message.entries) {
            if (!validHistoryEntry(entry)) continue;
            appendChatMessage({
              ...entry.message,
              highlighted: entry.message.kind === "warn" || entry.message.replyTo?.peerId === selfParticipant?.id,
              notice: undefined,
              actions: true,
            });
            for (const reaction of entry.reactions) {
              applyReactionEvent(entry.message.id, reaction);
            }
          }
          return;

        case "speaking": {
          const participant = participants.get(peerId);
          if (participant) participant.speaking = message.speaking;
          updateSpeakingVisuals(peerId, message.speaking);
          return;
        }

        default:
          return;
      }
    },

    onRemoteTrack: (peerId, kind, stream) => {
      if (kind === "audio") {
        attachRemoteAudio(peerId, stream);
        return;
      }
      if (kind === "screen-audio") {
        attachRemoteScreenAudio(peerId, stream);
        return;
      }

      const cache = remoteStreams.get(peerId) ?? {};
      cache[kind] = stream;
      remoteStreams.set(peerId, cache);

      if (kind === "camera") {
        videoSubscriptions.add(peerId);
        refreshVideoGridUI();
        return;
      }

      // kind === "screen"
      screenSubscriptions.add(peerId);
      const participant = participants.get(peerId);
      if (participant?.screenSharing) {
        showScreenShareView(participant, Array.from(participants.values()).filter((p) => p.inCall));
        attachFocusedScreenStream(stream);
      }
    },

    onRemoteTrackEnded: (peerId, kind) => {
      if (kind === "audio") {
        removeRemoteAudio(peerId);
        return;
      }
      if (kind === "screen-audio") {
        removeRemoteScreenAudio(peerId);
        return;
      }
      const cache = remoteStreams.get(peerId);
      if (cache) delete cache[kind];

      if (kind === "camera") {
        videoSubscriptions.delete(peerId);
        refreshVideoGridUI();
      } else if (kind === "screen") {
        screenSubscriptions.delete(peerId);
        if (watchingScreenPeerId === peerId) {
          hideScreenShareView();
        }
        refreshVideoGridUI();
      }
    },

    onVideoRequested: (peerId) => {
      if (
        selfParticipant?.inCall &&
        participants.get(peerId)?.inCall &&
        mediaService.isCameraActive &&
        mediaService.cameraTrack &&
        mediaService.localCameraStream
      ) {
        void manager.attachCameraToPeer(peerId, mediaService.cameraTrack, mediaService.localCameraStream);
      }
    },

    onVideoStopRequested: (peerId) => {
      manager.removeCameraFromPeer(peerId);
    },

    onScreenRequested: (peerId) => {
      if (
        selfParticipant?.inCall &&
        participants.get(peerId)?.inCall &&
        mediaService.screenTrack &&
        mediaService.localScreenStream
      ) {
        void manager.attachScreenToPeer(peerId, mediaService.screenTrack, mediaService.localScreenStream);
      }
    },

    onScreenStopRequested: (peerId) => {
      manager.removeScreenFromPeer(peerId);
    },

    onFileOffered: (offer) => {
      void handleIncomingFileOffer(manager, offer);
    },

    onFileSendError: (_peerId, name) => {
      if (peerManager === manager) appendLocalSystemMessage(t("fileSendFailed", { name }), true);
    },

    onFileChunk: async (_peerId, fileId, base64Data) => {
      await fileStorageService.append(fileId, base64Data);
    },

    onFileProgress: (peerId, fileId, receivedBytes, totalBytes) => {
      const view = incomingFileViews.get(fileTransferKey(peerId, fileId));
      if (!view) return;
      const percentage = totalBytes > 0 ? Math.min(100, Math.round((receivedBytes / totalBytes) * 100)) : 100;
      view.progressBar.style.width = `${percentage}%`;
      view.status.textContent = t("receiving", { progress: percentage });
    },

    onFileReceived: (file) => {
      void completeIncomingFile(file);
    },

    onFileTransferError: (peerId, fileId, error) => {
      console.error("Falha na transferência do arquivo", error);
      markIncomingFileFailed(peerId, fileId);
    },

    onPeerConnectionStateChange: (peerId, state) => {
      if (peerManager !== manager) return;
      if (state === "closed") {
        roomMesh?.peerClosed(peerId);
        if (pendingJoin?.sponsorId === peerId) failPendingJoin(t("joinFailed"));
      }
    },
  });
}

async function sendChatHistory(manager: PeerManager, peerId: string): Promise<void> {
  const snapshot = snapshotPublicHistory([
    ...chatMessageViews.values(),
    ...Array.from(fileHistory.values()).filter((view) => !chatMessageViews.has(view.message.id)),
  ]).sort((a, b) => a.message.createdAt - b.message.createdAt);
  for (const entries of historyBatches(snapshot)) {
    if (manager !== peerManager || !await manager.sendBuffered(peerId, { type: "history-batch", entries })) return;
  }
}

/* ============================================================================
 * PRESENÇA — envio do estado local para os peers
 * ========================================================================== */

function broadcastPresence(): void {
  if (!peerManager || !selfParticipant) return;
  peerManager.broadcast({
    type: "presence",
    nickname: selfParticipant.nickname,
    color: selfParticipant.avatarColor ?? "",
    inCall: selfParticipant.inCall,
    micOn: selfParticipant.micOn,
    audioOn: selfParticipant.audioOn,
    cameraOn: selfParticipant.cameraOn,
    screenSharing: selfParticipant.screenSharing,
  });
}

function sendPresenceTo(peerId: string): void {
  if (!peerManager || !selfParticipant) return;
  peerManager.sendTo(peerId, {
    type: "presence",
    nickname: selfParticipant.nickname,
    color: selfParticipant.avatarColor ?? "",
    inCall: selfParticipant.inCall,
    micOn: selfParticipant.micOn,
    audioOn: selfParticipant.audioOn,
    cameraOn: selfParticipant.cameraOn,
    screenSharing: selfParticipant.screenSharing,
  });
}

function syncCallMediaToPeer(manager: PeerManager, peerId: string): void {
  void manager.syncActiveMediaToPeer(peerId, {
    micTrack: selfParticipant?.micOn ? mediaService.micTrack : null,
    micStream: selfParticipant?.micOn ? mediaService.localMicStream : null,
    cameraTrack: selfParticipant?.cameraOn ? mediaService.cameraTrack : null,
    cameraStream: selfParticipant?.cameraOn ? mediaService.localCameraStream : null,
    screenTrack: mediaService.screenTrack,
    screenStream: mediaService.localScreenStream,
  });
}

/* ============================================================================
 * TOPBAR
 * ========================================================================== */

function setSidebarPanel(panel: SidebarPanel): void {
  if (sidebar.classList.contains("sidebar--collapsed")) setSidebarCollapsed(false);
  sidebarParticipantsPanel.classList.toggle("hidden", panel !== "participants");
  sidebarSettingsPanel.classList.toggle("hidden", panel !== "settings");
  btnToggleParticipants.classList.toggle("is-active", panel === "participants");
  btnToggleSettings.classList.toggle("is-active", panel === "settings");
}

btnToggleParticipants.addEventListener("click", () => setSidebarPanel("participants"));
btnToggleSettings.addEventListener("click", () => setSidebarPanel("settings"));

btnLeaveRoom.addEventListener("click", () => {
  leaveRoomSession(true);
});

function localizeSignalingError(error: SignalingError): string {
  switch (error.code) {
    case "CLIENT_OUTDATED": return t("clientOutdated");
    case "CODE_NOT_FOUND": return t("codeExpired");
    case "CODE_USED": return t("codeUsed");
    case "INVALID_CODE": return t("invalidCode");
    case "SELF_JOIN": return t("selfJoin");
    case "POLL_TOO_FAST": return t("confirmTooFast");
    case "REGISTER_RATE_LIMITED":
    case "CLAIM_RATE_LIMITED":
    case "CODE_ATTEMPTS_BLOCKED": return t("connectionRateLimited");
    case "NETWORK_ERROR": return t("signalingUnavailable");
    default: return error.message;
  }
}

function leaveRoomSession(notifyPeers: boolean): void {
  if (selfParticipant) void clearClipboardFiles(selfParticipant.id).catch(() => undefined);
  exitScreenFullscreen();
  const wasInRoom = !screenApp.classList.contains("hidden");
  roomEpoch++;
  stopJoinWaiting();
  joinDialog.classList.add("hidden");
  addFriendDialog.classList.add("hidden");
  addFriendBusy = false;
  btnConfirmFriend.disabled = false;
  setRoomFormBusy(false);
  if (notifyPeers) roomMesh?.leave();
  else roomMesh?.stop();
  roomMesh = null;
  const wasInCall = selfParticipant?.inCall === true;
  if (wasInCall) playEffect("call-leave", "call");
  if (selfParticipant && wasInRoom) window.setTimeout(() => playEffect("channel-leave", "call"), wasInCall ? 300 : 0);
  mediaService.stopAll();
  peerManager?.closeAll();
  peerManager = null;
  selfParticipant = null;
  participants.clear();
  incomingFileViews.clear();
  chatMessageViews.clear();
  fileHistory.clear();
  pendingReactionEvents.clear();
  clearPendingReply();
  chatMessagesEl.replaceChildren();
  closeFileLightbox();
  for (const url of outgoingPreviewUrls) URL.revokeObjectURL(url);
  outgoingPreviewUrls.clear();
  void fileStorageService.cleanup();
  videoSubscriptions.clear();
  screenSubscriptions.clear();
  remoteStreams.clear();
  for (const peerId of Array.from(remoteAudioEls.keys())) removeRemoteAudio(peerId);
  for (const peerId of Array.from(remoteScreenAudioEls.keys())) removeRemoteScreenAudio(peerId);
  for (const peerId of Array.from(remoteScreenAudioEls.keys())) removeRemoteScreenAudio(peerId);
  participantVoiceVolumes.clear();
  void setNativeCallService(false);
  stopPingMonitor();
  closeParticipantVolumePopup();

  micOn = false;
  speakerOn = true;
  cameraOn = false;
  screenShareOn = false;
  micWasOnBeforeDeafen = false;
  btnToggleMic.disabled = false;
  setControlState(btnToggleMic, "mic", false);
  setControlState(btnToggleSpeaker, "headphone", true);
  setControlState(btnToggleCamera, "camera", false);
  setControlState(btnToggleScreenshare, "screen", false);

  leaveCallUI();
  showScreen("home");
  inputNickname.focus();
}

window.addEventListener("pagehide", () => { roomMesh?.leave(); });

btnStartCall.addEventListener("click", () => {
  void handleJoinCall();
});

/* ============================================================================
 * SIDEBAR — lista de participantes
 * ========================================================================== */

function renderParticipantsList(list: Participant[]): void {
  connectedCountEl.textContent = t("connected", { count: list.length });
  participantsListEl.innerHTML = "";

  for (const participant of list) {
    participantsListEl.appendChild(createParticipantListItem(participant));
  }
}

function createAvatar(className: string, color?: string): HTMLSpanElement {
  const avatar = document.createElement("span");
  avatar.className = className;
  avatar.setAttribute("role", "img");
  avatar.setAttribute("aria-label", "Avatar");
  avatar.style.setProperty("--avatar-color", color || "#f2f2f2");
  return avatar;
}

function createParticipantListItem(participant: Participant): HTMLLIElement {
  const item = document.createElement("li");
  item.className = "participants-list__item";
  item.dataset.userId = participant.id;
  item.dataset.inCall = String(participant.inCall);

  const avatar = createAvatar("participants-list__avatar", participant.avatarColor);

  const name = document.createElement("span");
  name.className = "participants-list__name";
  name.textContent = participant.nickname;

  item.append(avatar, name);
  const meta = document.createElement("span");
  meta.className = "participants-list__meta";
  if (participant.id !== selfParticipant?.id) {
    const ping = createPingElement(participant.pingMs);
    meta.appendChild(ping);
    addParticipantVolumeMenu(item, participant.id);
  }
  const statuses = document.createElement("span");
  statuses.className = "participants-list__statuses";
  if (participant.inCall && !participant.micOn) {
    const micStatus = document.createElement("img");
    micStatus.className = "participants-list__mic-status";
    micStatus.src = ICON_URLS.micOff;
    micStatus.alt = t("micOff");
    micStatus.title = t("micOff");
    statuses.appendChild(micStatus);
  }
  if (participant.inCall && !participant.audioOn) {
    const audioStatus = document.createElement("img");
    audioStatus.className = "participants-list__audio-status";
    audioStatus.src = ICON_URLS.headphoneOff;
    audioStatus.alt = t("audioOff");
    audioStatus.title = t("audioOff");
    statuses.appendChild(audioStatus);
  }
  if (statuses.childElementCount > 0) meta.appendChild(statuses);
  if (meta.childElementCount > 0) item.appendChild(meta);
  return item;
}

function createPingElement(pingMs?: number): HTMLSpanElement {
  const ping = document.createElement("span");
  ping.className = "participant-ping";
  setPingElementState(ping, pingMs);
  return ping;
}

function setPingElementState(element: HTMLElement, pingMs?: number): void {
  element.classList.remove("participant-ping--good", "participant-ping--medium", "participant-ping--poor");
  if (pingMs === undefined) {
    element.textContent = "—ms";
    return;
  }
  element.textContent = `${pingMs}ms`;
  element.classList.add(
    pingMs < 50
      ? "participant-ping--good"
      : pingMs < 100
        ? "participant-ping--medium"
        : "participant-ping--poor",
  );
}

function updatePingVisuals(peerId: string, pingMs?: number): void {
  document.querySelectorAll<HTMLElement>(`[data-user-id="${peerId}"] .participant-ping`).forEach((element) => {
    setPingElementState(element, pingMs);
  });
}

async function refreshPeerPings(manager: PeerManager): Promise<void> {
  const measurements = await manager.measureRoundTripTimes();
  if (peerManager !== manager) return;
  for (const [peerId, pingMs] of measurements) {
    const participant = participants.get(peerId);
    if (!participant) continue;
    participant.pingMs = pingMs ?? undefined;
    updatePingVisuals(peerId, participant.pingMs);
  }
}

function startPingMonitor(manager: PeerManager): void {
  stopPingMonitor();
  void refreshPeerPings(manager);
  pingTimer = window.setInterval(() => void refreshPeerPings(manager), 5000);
}

function stopPingMonitor(): void {
  if (pingTimer !== null) window.clearInterval(pingTimer);
  pingTimer = null;
}

function refreshParticipantsUI(): void {
  const list = Array.from(participants.values()).map((participant) =>
    selfParticipant && participant.id === selfParticipant.id
      ? { ...participant, nickname: `${participant.nickname} (${t("you")})` }
      : participant,
  );
  renderParticipantsList(list);
}

/* ============================================================================
 * SIDEBAR — configurações de dispositivos
 * ========================================================================== */

function populateDeviceOptions(select: HTMLSelectElement, devices: MediaDeviceInfo[]): void {
  select.innerHTML = "";
  for (const device of devices) {
    const option = document.createElement("option");
    option.value = device.deviceId;
    option.textContent = device.label || t("device");
    select.appendChild(option);
  }
}

async function populateDeviceSelects(): Promise<void> {
  try {
    await settingsReady;
    const { mics, speakers, cameras } = await mediaService.listDevices(!!("__TAURI_INTERNALS__" in window));
    populateDeviceOptions(selectMicrophone, mics);
    populateDeviceOptions(selectSpeaker, speakers);
    populateDeviceOptions(selectCamera, cameras);
    restoreSelectedDevice(selectMicrophone, appSettings.microphoneId);
    restoreSelectedDevice(selectSpeaker, appSettings.speakerId);
    restoreSelectedDevice(selectCamera, appSettings.cameraId);
  } catch (err) {
    console.warn("Não foi possível listar dispositivos de mídia", err);
  }
}

function restoreSelectedDevice(select: HTMLSelectElement, deviceId: string): void {
  if (deviceId && Array.from(select.options).some((option) => option.value === deviceId)) {
    select.value = deviceId;
  }
}

selectMicrophone.addEventListener("change", () => {
  appSettings.microphoneId = selectMicrophone.value;
  persistSettings();
  if (!mediaService.isMicActive || !peerManager) return;
  stopLocalSpeakingDetection();
  void mediaService.switchMicDevice(selectMicrophone.value).then((track) => {
    peerManager?.replaceMicTrackForAll(track);
    startLocalSpeakingDetection();
  }).catch(handleMicReconfigurationFailure);
});

selectCamera.addEventListener("change", () => {
  appSettings.cameraId = selectCamera.value;
  persistSettings();
  if (!mediaService.isCameraActive || !peerManager) return;
  void mediaService.switchCameraDevice(selectCamera.value).then((track) => {
    peerManager?.replaceCameraTrackForAll(track);
    refreshVideoGridUI();
  });
});

selectSpeaker.addEventListener("change", () => {
  appSettings.speakerId = selectSpeaker.value;
  persistSettings();
  const sinkId = selectSpeaker.value;
  for (const audioEl of remoteAudioEls.values()) {
    const withSink = audioEl as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
    withSink.setSinkId?.(sinkId).catch(() => {
      /* setSinkId não suportado neste navegador/plataforma */
    });
  }
  for (const audioEl of remoteScreenAudioEls.values()) {
    const withSink = audioEl as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
    withSink.setSinkId?.(sinkId).catch(() => undefined);
  }
  for (const controller of remoteVoiceControllers.values()) {
    void configureAudioContextOutput(controller.context, sinkId);
  }
});

settingNoiseSuppression.addEventListener("change", () => {
  appSettings.noiseSuppression = settingNoiseSuppression.checked;
  mediaService.setAudioProcessing(appSettings.noiseSuppression);
  persistSettings();
  if (!mediaService.isMicActive || !peerManager || !selfParticipant?.inCall) return;
  stopLocalSpeakingDetection();
  void mediaService.switchMicDevice(selectMicrophone.value).then((track) => {
    peerManager?.replaceMicTrackForAll(track);
    startLocalSpeakingDetection();
  }).catch(handleMicReconfigurationFailure);
});

function handleMicReconfigurationFailure(error: unknown): void {
  console.warn("Não foi possível reconfigurar o microfone", error);
  peerManager?.removeMicFromAll();
  micOn = false;
  if (selfParticipant) selfParticipant.micOn = false;
  setControlState(btnToggleMic, "mic", false);
  publishLocalMediaState();
}

settingCallEffects.addEventListener("change", () => {
  appSettings.callEffects = settingCallEffects.checked;
  persistSettings();
});

settingButtonEffects.addEventListener("change", () => {
  const enabled = settingButtonEffects.checked;
  if (!enabled && appSettings.buttonEffects) void soundService.play("toggle-off");
  appSettings.buttonEffects = enabled;
  persistSettings();
  if (enabled) void soundService.play("toggle-on");
});

settingMessageEffects.addEventListener("change", () => {
  appSettings.messageEffects = settingMessageEffects.checked;
  persistSettings();
});

/* ============================================================================
 * ÁREA DE VÍDEO / CALL
 * ========================================================================== */

function createVideoTile(
  participant: Participant,
  size: "normal" | "sm" = "normal",
  onToggleVideo?: (peerId: string) => void,
): HTMLDivElement {
  const tile = document.createElement("div");
  tile.className = `video-tile${size === "sm" ? " video-tile--sm" : ""}`;
  tile.dataset.userId = participant.id;
  tile.classList.toggle("video-tile--active", Boolean(participant.speaking));

  const box = document.createElement("div");
  box.className = "video-tile__box";

  const stream = document.createElement("video");
  stream.className = "video-tile__stream hidden";
  stream.autoplay = true;
  stream.playsInline = true;
  stream.muted = true;

  const avatar = createAvatar("video-tile__avatar", participant.avatarColor);

  const screenIcon = document.createElement("img");
  screenIcon.className = "video-tile__screen-icon hidden";
  screenIcon.src = ICON_URLS.screen;
  screenIcon.alt = "";

  const badge = document.createElement("span");
  badge.className = "video-tile__badge hidden";
  const badgeIcon = document.createElement("img");
  badgeIcon.src = ICON_URLS.camera;
  badgeIcon.alt = "";
  badge.appendChild(badgeIcon);

  const micBadge = document.createElement("span");
  micBadge.className = "video-tile__mic-badge hidden";
  micBadge.title = t("micOff");
  const micBadgeIcon = document.createElement("img");
  micBadgeIcon.src = ICON_URLS.micOff;
  micBadgeIcon.alt = t("micOff");
  micBadge.appendChild(micBadgeIcon);

  const audioBadge = document.createElement("span");
  audioBadge.className = "video-tile__audio-badge hidden";
  audioBadge.title = t("audioOff");
  const audioBadgeIcon = document.createElement("img");
  audioBadgeIcon.src = ICON_URLS.headphoneOff;
  audioBadgeIcon.alt = t("audioOff");
  audioBadge.appendChild(audioBadgeIcon);

  box.append(stream, avatar, screenIcon, badge, micBadge, audioBadge);

  // click-to-view: clicar no tile de outro participante pede/para a câmera dele
  const isSelf = selfParticipant?.id === participant.id;
  if (!isSelf && onToggleVideo) {
    box.style.cursor = "pointer";
    box.title = videoSubscriptions.has(participant.id) ? t("stopCamera") : t("watchCamera");
    box.addEventListener("click", () => onToggleVideo(participant.id));
  }
  if (!isSelf) addParticipantVolumeMenu(tile, participant.id);

  const identity = document.createElement("div");
  identity.className = "video-tile__identity";
  const label = document.createElement("span");
  label.className = "video-tile__label";
  label.textContent = participant.nickname;
  identity.appendChild(label);
  if (!isSelf) identity.appendChild(createPingElement(participant.pingMs));

  tile.append(box, identity);

  applyTileState(tile, participant);

  return tile;
}

function applyTileState(tile: HTMLDivElement, participant: Participant): void {
  const stream = tile.querySelector<HTMLVideoElement>(".video-tile__stream")!;
  const avatar = tile.querySelector<HTMLSpanElement>(".video-tile__avatar")!;
  const screenIcon = tile.querySelector<HTMLImageElement>(".video-tile__screen-icon")!;
  const badge = tile.querySelector<HTMLSpanElement>(".video-tile__badge")!;
  const micBadge = tile.querySelector<HTMLSpanElement>(".video-tile__mic-badge")!;
  const audioBadge = tile.querySelector<HTMLSpanElement>(".video-tile__audio-badge")!;

  const showingCamera = participant.cameraOn;

  stream.classList.toggle("hidden", !showingCamera);
  avatar.classList.toggle("hidden", showingCamera);
  screenIcon.classList.add("hidden");
  badge.classList.toggle("hidden", !showingCamera);
  micBadge.classList.toggle("hidden", participant.micOn);
  audioBadge.classList.toggle("hidden", participant.audioOn);
  avatar.style.setProperty("--avatar-color", participant.avatarColor || "#f2f2f2");
}

function renderVideoGrid(list: Participant[], onToggleVideo?: (peerId: string) => void): void {
  videoGrid.innerHTML = "";
  for (const participant of list) {
    videoGrid.appendChild(createVideoTile(participant, "normal", onToggleVideo));
  }
  for (const participant of list.filter((item) => item.screenSharing)) {
    videoGrid.appendChild(createScreenShareTile(participant));
  }
  videoGrid.classList.toggle("hidden", list.length === 0);
}

function createScreenShareTile(participant: Participant): HTMLDivElement {
  const tile = document.createElement("div");
  tile.className = "video-tile video-tile--screen";
  tile.dataset.screenUserId = participant.id;

  const box = document.createElement("button");
  box.className = "video-tile__box";
  box.type = "button";
  box.title = t("watchScreen");
  box.setAttribute("aria-label", t("watchUsersScreen", { name: participant.nickname }));
  const icon = document.createElement("img");
  icon.className = "video-tile__screen-icon";
  icon.src = ICON_URLS.screen;
  icon.alt = "";
  box.appendChild(icon);
  box.addEventListener("click", () => watchParticipantScreen(participant.id));

  const label = document.createElement("span");
  label.className = "video-tile__label";
  label.textContent = t("screenOf", { name: participant.nickname });
  tile.append(box, label);
  return tile;
}

/** Recalcula quem está na call e reconstrói a grid, respeitando o modelo de
 *  click-to-view (só mostramos vídeo de quem pedimos para ver, exceto o
 *  próprio usuário). Reanexa os MediaStreams reais aos elementos recriados. */
function refreshVideoGridUI(): void {
  if (!selfParticipant) return;

  const inCall = Array.from(participants.values()).filter((p) => p.inCall);
  if (inCall.length === 0) {
    videoGrid.classList.add("hidden");
    videoGrid.innerHTML = "";
    return;
  }

  const presentation = inCall.map((participant) => ({
    ...participant,
    cameraOn: participant.cameraOn && (participant.id === selfParticipant!.id || videoSubscriptions.has(participant.id)),
  }));

  renderVideoGrid(presentation, handleTileVideoToggle);

  for (const participant of presentation) {
    const videoEl = videoGrid.querySelector<HTMLVideoElement>(
      `.video-tile[data-user-id="${participant.id}"] .video-tile__stream`,
    );
    if (!videoEl) continue;

    attachCameraStream(videoEl, participant);
  }

  if (watchingScreenPeerId) {
    renderScreenShareThumbs(Array.from(participants.values()).filter((participant) => participant.inCall));
  }
}

function attachCameraStream(videoEl: HTMLVideoElement, participant: Participant): void {
  const stream = participant.id === selfParticipant?.id
    ? mediaService.localCameraStream
    : remoteStreams.get(participant.id)?.camera;
  if (!stream || !participant.cameraOn) return;
  videoEl.srcObject = stream;
  void videoEl.play().catch(() => undefined);
}

function handleTileVideoToggle(peerId: string): void {
  if (!peerManager) return;

  if (videoSubscriptions.has(peerId)) {
    videoSubscriptions.delete(peerId);
    peerManager.sendTo(peerId, { type: "video-stop" });
  } else {
    videoSubscriptions.add(peerId);
    peerManager.sendTo(peerId, { type: "video-request" });
  }
  refreshVideoGridUI();
}

/* -- fluxo de estados da área de call ------------------------------------- */

function showCallStarted(): void {
  mainContent.classList.add("main-content--chat-focus");
  videoArea.classList.remove("hidden");
  videoArea.classList.add("video-area--collapsed");
  btnStartCall.classList.add("hidden");
  btnJoinCall.classList.remove("hidden");
  callControls.classList.add("hidden");
}

function showJoinedCall(): void {
  mainContent.classList.remove("main-content--chat-focus");
  videoArea.classList.remove("hidden", "video-area--collapsed");
  btnStartCall.classList.add("hidden");
  btnJoinCall.classList.add("hidden");
  callControls.classList.remove("hidden");
}

function leaveCallUI(): void {
  exitScreenFullscreen();
  mainContent.classList.add("main-content--chat-focus");
  videoArea.classList.add("hidden");
  videoArea.classList.remove("video-area--collapsed");
  btnStartCall.classList.remove("hidden");
  btnJoinCall.classList.add("hidden");
  callControls.classList.add("hidden");
  screenShareView.classList.add("hidden");
  mainContent.classList.remove("main-content--screen-focus");
  watchingLabel.classList.add("hidden");
  watchingScreenPeerId = null;
  screenShareStream.srcObject = null;
  screenShareStream.classList.add("hidden");
  screenShareThumbs.innerHTML = "";
  videoGrid.classList.remove("hidden");
  videoGrid.innerHTML = "";
}

function syncCallEntryUI(): void {
  if (!selfParticipant) return;
  if (selfParticipant.inCall) {
    showJoinedCall();
    return;
  }
  const hasRemoteCall = Array.from(participants.values()).some(
    (participant) => participant.id !== selfParticipant?.id && participant.inCall,
  );
  if (hasRemoteCall) showCallStarted();
  else leaveCallUI();
}

btnJoinCall.addEventListener("click", () => {
  void handleJoinCall();
});

async function handleJoinCall(): Promise<void> {
  if (!selfParticipant || !peerManager || btnStartCall.disabled || btnJoinCall.disabled) return;
  btnStartCall.disabled = true;
  btnJoinCall.disabled = true;
  const callWasAlreadyActive = Array.from(participants.values()).some(
    (participant) => participant.id !== selfParticipant?.id && participant.inCall,
  );
  try {
    const track = await mediaService.enableMic(selectMicrophone.value || undefined);
    const peersInCall = Array.from(participants.values()).filter(
      (participant) => participant.id !== selfParticipant?.id && participant.inCall,
    );
    for (const participant of peersInCall) {
      await peerManager.attachMicToPeer(participant.id, track, mediaService.localMicStream!);
    }
  } catch (err) {
    console.error("Não foi possível acessar o microfone", err);
    window.alert(t("microphonePermission"));
    return;
  } finally {
    btnStartCall.disabled = false;
    btnJoinCall.disabled = false;
  }

  selfParticipant.inCall = true;
  if (!("__TAURI_INTERNALS__" in window)) void populateDeviceSelects();
  void setNativeCallService(true);
  selfParticipant.micOn = true;
  selfParticipant.audioOn = true;
  micOn = true;
  speakerOn = true;
  micWasOnBeforeDeafen = false;
  setControlState(btnToggleMic, "mic", true);
  setControlState(btnToggleSpeaker, "headphone", true);
  btnToggleMic.disabled = false;
  startLocalSpeakingDetection();
  showJoinedCall();
  broadcastPresence();
  refreshParticipantsUI();
  refreshVideoGridUI();
  if (!callWasAlreadyActive) {
    playEffect("call-start", "call");
    window.setTimeout(() => playEffect("call-join", "call"), 380);
  } else {
    playEffect("call-join", "call");
  }
}

/* -- controles de mic / áudio / câmera / tela ------------------------------ */

function setControlState(button: HTMLButtonElement, iconName: ControlIconName, active: boolean): void {
  button.classList.toggle("control-btn--on", active);
  button.classList.toggle("control-btn--off", !active);
  const icon = button.querySelector("img")!;
  icon.src = active ? CONTROL_ICON_URLS[iconName].on : CONTROL_ICON_URLS[iconName].off;
}

let micOn = false;
let speakerOn = true;
let cameraOn = false;
let screenShareOn = false;
let micWasOnBeforeDeafen = false;

function startLocalSpeakingDetection(): void {
  if (!selfParticipant?.inCall || !micOn) return;
  try {
    mediaService.startSpeakingDetection((speaking) => {
      if (!selfParticipant || selfParticipant.speaking === speaking) return;
      selfParticipant.speaking = speaking;
      peerManager?.broadcast({ type: "speaking", speaking });
      updateSpeakingVisuals(selfParticipant.id, speaking);
    });
  } catch (error) {
    console.warn("Não foi possível iniciar a detecção de voz", error);
  }
}

function stopLocalSpeakingDetection(): void {
  mediaService.stopSpeakingDetection();
  if (!selfParticipant?.speaking) return;
  selfParticipant.speaking = false;
  peerManager?.broadcast({ type: "speaking", speaking: false });
  updateSpeakingVisuals(selfParticipant.id, false);
}

function updateSpeakingVisuals(peerId: string, speaking: boolean): void {
  for (const container of [videoGrid, screenShareThumbs]) {
    container
      .querySelector<HTMLDivElement>(`.video-tile[data-user-id="${peerId}"]`)
      ?.classList.toggle("video-tile--active", speaking);
  }
}

btnToggleMic.addEventListener("click", () => {
  void handleToggleMic();
});

async function handleToggleMic(): Promise<void> {
  if (!selfParticipant?.inCall || !peerManager || !speakerOn) return;
  btnToggleMic.disabled = true;
  const shouldEnable = !micOn;
  try {
    const changed = await setMicrophoneState(shouldEnable);
    publishLocalMediaState();
    if (changed) playEffect(shouldEnable ? "toggle-on" : "toggle-off", "button");
  } finally {
    btnToggleMic.disabled = false;
  }
}

btnToggleSpeaker.addEventListener("click", () => {
  void handleToggleSpeaker();
});

async function setMicrophoneState(enabled: boolean): Promise<boolean> {
  if (!selfParticipant?.inCall || !peerManager) return false;
  if (enabled === micOn) return true;

  if (!enabled) {
    stopLocalSpeakingDetection();
    peerManager.removeMicFromAll();
    mediaService.disableMic();
    micOn = false;
    selfParticipant.micOn = false;
    setControlState(btnToggleMic, "mic", false);
    return true;
  }

  try {
    const track = await mediaService.enableMic(selectMicrophone.value || undefined);
    const peersInCall = Array.from(participants.values()).filter(
      (participant) => participant.id !== selfParticipant?.id && participant.inCall,
    );
    for (const participant of peersInCall) {
      await peerManager.attachMicToPeer(participant.id, track, mediaService.localMicStream!);
    }
    micOn = true;
    selfParticipant.micOn = true;
    setControlState(btnToggleMic, "mic", true);
    startLocalSpeakingDetection();
    return true;
  } catch (error) {
    console.error("Não foi possível ligar o microfone", error);
    window.alert(t("microphonePermission"));
    micOn = false;
    selfParticipant.micOn = false;
    setControlState(btnToggleMic, "mic", false);
    return false;
  }
}

async function handleToggleSpeaker(): Promise<void> {
  if (!selfParticipant?.inCall || !peerManager || btnToggleSpeaker.disabled) return;
  btnToggleSpeaker.disabled = true;
  btnToggleMic.disabled = true;
  try {
    if (speakerOn) {
      micWasOnBeforeDeafen = micOn;
      if (micOn) await setMicrophoneState(false);
      speakerOn = false;
      selfParticipant.audioOn = false;
    } else {
      speakerOn = true;
      selfParticipant.audioOn = true;
      if (micWasOnBeforeDeafen) await setMicrophoneState(true);
      micWasOnBeforeDeafen = false;
    }

    setControlState(btnToggleSpeaker, "headphone", speakerOn);
    for (const [peerId, audioEl] of remoteAudioEls) {
      const controller = remoteVoiceControllers.get(peerId);
      audioEl.muted = controller ? true : !speakerOn;
      if (controller) {
        const volume = (participantVoiceVolumes.get(peerId) ?? 100) / 100;
        controller.gain.gain.setValueAtTime(speakerOn ? volume : 0, controller.context.currentTime);
        if (speakerOn) void controller.context.resume().catch(() => undefined);
      }
    }
    for (const audioEl of remoteScreenAudioEls.values()) {
      audioEl.muted = !speakerOn;
    }
    publishLocalMediaState();
    playEffect(speakerOn ? "toggle-on" : "toggle-off", "button");
  } finally {
    btnToggleSpeaker.disabled = false;
    btnToggleMic.disabled = !speakerOn;
  }
}

function publishLocalMediaState(): void {
  broadcastPresence();
  refreshParticipantsUI();
  refreshVideoGridUI();
}

btnToggleCamera.addEventListener("click", () => {
  void handleToggleCamera();
});

async function handleToggleCamera(): Promise<void> {
  if (!selfParticipant?.inCall || !peerManager || btnToggleCamera.disabled) return;
  btnToggleCamera.disabled = true;
  const shouldEnable = !cameraOn;
  try {
    let changed = false;
    if (!shouldEnable) {
      peerManager.removeCameraFromAll();
      mediaService.disableCamera();
      cameraOn = false;
      selfParticipant.cameraOn = false;
      changed = true;
    } else {
      try {
        const track = await mediaService.enableCamera(selectCamera.value || undefined);
        const peersInCall = Array.from(participants.values()).filter(
          (participant) => participant.id !== selfParticipant?.id && participant.inCall,
        );
        for (const participant of peersInCall) {
          await peerManager.attachCameraToPeer(participant.id, track, mediaService.localCameraStream!);
        }
        cameraOn = true;
        selfParticipant.cameraOn = true;
        if (!("__TAURI_INTERNALS__" in window)) void populateDeviceSelects();
        changed = true;
      } catch (err) {
        console.error("Não foi possível acessar a câmera", err);
        window.alert(t("cameraPermission"));
        cameraOn = false;
        selfParticipant.cameraOn = false;
      }
    }
    setControlState(btnToggleCamera, "camera", cameraOn);
    publishLocalMediaState();
    void setNativeCallService(true, cameraOn);
    if (changed) playEffect(cameraOn ? "toggle-on" : "toggle-off", "button");
  } finally {
    btnToggleCamera.disabled = false;
  }
}

btnToggleScreenshare.addEventListener("click", () => {
  void handleToggleScreenshare();
});

btnLeaveCall.addEventListener("click", () => {
  leaveCurrentCall();
});

function leaveCurrentCall(): void {
  if (!selfParticipant?.inCall || !peerManager) return;

  stopLocalSpeakingDetection();
  for (const peerId of videoSubscriptions) peerManager.sendTo(peerId, { type: "video-stop" });
  for (const peerId of screenSubscriptions) peerManager.sendTo(peerId, { type: "screen-stop" });
  videoSubscriptions.clear();
  screenSubscriptions.clear();
  remoteStreams.clear();
  for (const peerId of Array.from(remoteAudioEls.keys())) removeRemoteAudio(peerId);

  for (const peerId of peerManager.listConnectedPeerIds()) peerManager.removeCallMediaFromPeer(peerId);
  mediaService.stopAll();

  micOn = false;
  speakerOn = true;
  cameraOn = false;
  screenShareOn = false;
  micWasOnBeforeDeafen = false;
  selfParticipant.inCall = false;
  selfParticipant.micOn = false;
  selfParticipant.audioOn = true;
  selfParticipant.cameraOn = false;
  selfParticipant.screenSharing = false;
  selfParticipant.speaking = false;
  void setNativeCallService(false);

  setControlState(btnToggleMic, "mic", false);
  setControlState(btnToggleSpeaker, "headphone", true);
  setControlState(btnToggleCamera, "camera", false);
  setControlState(btnToggleScreenshare, "screen", false);
  btnToggleMic.disabled = false;
  resetScreenShareView();
  broadcastPresence();
  refreshParticipantsUI();
  refreshVideoGridUI();
  syncCallEntryUI();
  playEffect("call-leave", "call");
}

async function handleToggleScreenshare(): Promise<void> {
  if (!selfParticipant?.inCall || !peerManager || btnToggleScreenshare.disabled) return;
  if (typeof navigator.mediaDevices?.getDisplayMedia !== "function") {
    window.alert(t("screenShareUnsupported"));
    return;
  }
  btnToggleScreenshare.disabled = true;
  const shouldEnable = !screenShareOn;
  try {
    if (!shouldEnable) {
      stopScreenshareLocally();
      playEffect("toggle-off", "button");
      return;
    }
    try {
      const track = await mediaService.startScreenShare();
      const peersInCall = Array.from(participants.values()).filter(
        (participant) => participant.id !== selfParticipant?.id && participant.inCall,
      );
      for (const participant of peersInCall) {
        await peerManager.attachScreenToPeer(participant.id, track, mediaService.localScreenStream!);
      }
      screenShareOn = true;
      selfParticipant.screenSharing = true;
      setControlState(btnToggleScreenshare, "screen", true);
      mediaService.onScreenShareEndedByUser(() => stopScreenshareLocally());
    } catch (err) {
      console.warn("Compartilhamento de tela cancelado", err);
      mediaService.stopScreenShare();
      screenShareOn = false;
      selfParticipant.screenSharing = false;
      setControlState(btnToggleScreenshare, "screen", false);
      return;
    }
    publishLocalMediaState();
    playEffect("toggle-on", "button");
  } finally {
    btnToggleScreenshare.disabled = false;
  }
}

function stopScreenshareLocally(): void {
  if (!selfParticipant || !peerManager) return;
  if (!screenShareOn && !selfParticipant.screenSharing) return;
  screenShareOn = false;
  selfParticipant.screenSharing = false;
  peerManager.stopBroadcastingScreen();
  mediaService.stopScreenShare();
  setControlState(btnToggleScreenshare, "screen", false);
  if (watchingScreenPeerId === selfParticipant.id) hideScreenShareView();
  publishLocalMediaState();
}

/* -- visualização de compartilhamento de tela ------------------------------ */

function watchParticipantScreen(peerId: string): void {
  const participant = participants.get(peerId);
  if (!participant?.screenSharing || !selfParticipant?.inCall) return;

  showScreenShareView(participant, Array.from(participants.values()).filter((item) => item.inCall));
  const stream = peerId === selfParticipant.id
    ? mediaService.localScreenStream
    : remoteStreams.get(peerId)?.screen;
  if (stream) {
    attachFocusedScreenStream(stream);
    return;
  }

  if (peerManager && peerId !== selfParticipant.id) {
    screenSubscriptions.add(peerId);
    peerManager.sendTo(peerId, { type: "screen-request" });
  }
}

function attachFocusedScreenStream(stream: MediaStream): void {
  if (screenShareStream.srcObject !== stream) {
    screenShareStream.srcObject = stream;
  }
  screenShareStream.classList.remove("hidden");
  if (screenShareStream.paused) void screenShareStream.play().catch(() => undefined);
  screenShareMain.querySelector(".screen-share-main__placeholder")?.classList.add("hidden");
}

function showScreenShareView(sharingParticipant: Participant, otherParticipants: Participant[]): void {
  const previousPeerId = watchingScreenPeerId;
  watchingScreenPeerId = sharingParticipant.id;
  if (previousPeerId !== watchingScreenPeerId && isScreenFullscreen()) syncFullscreenScreenQuality();
  mainContent.classList.add("main-content--screen-focus");
  videoGrid.classList.add("hidden");
  screenShareView.classList.remove("hidden");
  watchingLabel.classList.remove("hidden");
  watchingUsernameEl.textContent = sharingParticipant.nickname;

  renderScreenShareThumbs(otherParticipants);
}

function renderScreenShareThumbs(otherParticipants: Participant[]): void {
  screenShareThumbs.innerHTML = "";
  for (const originalParticipant of otherParticipants) {
    const participant = {
      ...originalParticipant,
      cameraOn: originalParticipant.cameraOn && (
        originalParticipant.id === selfParticipant?.id || videoSubscriptions.has(originalParticipant.id)
      ),
    };
    const tile = createVideoTile(participant, "sm", handleTileVideoToggle);
    screenShareThumbs.appendChild(tile);
    const videoEl = tile.querySelector<HTMLVideoElement>(".video-tile__stream");
    if (videoEl) attachCameraStream(videoEl, participant);
  }
}

function hideScreenShareView(): void {
  resetScreenShareView();
  refreshVideoGridUI();
}

function resetScreenShareView(): void {
  exitScreenFullscreen();
  mainContent.classList.remove("main-content--screen-focus");
  screenShareView.classList.add("hidden");
  watchingLabel.classList.add("hidden");
  watchingScreenPeerId = null;
  watchingUsernameEl.textContent = "-";
  screenShareStream.srcObject = null;
  screenShareStream.classList.add("hidden");
  screenShareMain.querySelector(".screen-share-main__placeholder")?.classList.remove("hidden");
  screenShareThumbs.innerHTML = "";
  videoGrid.classList.remove("hidden");
}

btnStopWatchingScreen.addEventListener("click", () => {
  const peerId = watchingScreenPeerId;
  if (peerId && peerId !== selfParticipant?.id) {
    peerManager?.sendTo(peerId, { type: "screen-stop" });
    screenSubscriptions.delete(peerId);
    const streams = remoteStreams.get(peerId);
    if (streams) delete streams.screen;
  }
  hideScreenShareView();
});

btnScreenPip.addEventListener("click", () => {
  void toggleScreenPictureInPicture();
});

function isScreenFullscreen(): boolean {
  return document.fullscreenElement === screenShareMain
    || screenShareMain.classList.contains("screen-share-main--fullscreen");
}

function updateScreenFullscreenButton(): void {
  const active = isScreenFullscreen();
  const label = t(active ? "exitFullscreen" : "openFullscreen");
  btnScreenFullscreen.title = label;
  btnScreenFullscreen.setAttribute("aria-label", label);
  btnScreenFullscreen.setAttribute("aria-pressed", String(active));
}

function syncFullscreenScreenQuality(): void {
  const nextPeerId = isScreenFullscreen() ? watchingScreenPeerId : null;
  if (screenFullscreenPeerId && screenFullscreenPeerId !== selfParticipant?.id && screenFullscreenPeerId !== nextPeerId) {
    peerManager?.sendTo(screenFullscreenPeerId, { type: "screen-quality", fullscreen: false });
  }
  if (nextPeerId && nextPeerId !== selfParticipant?.id) {
    peerManager?.sendTo(nextPeerId, { type: "screen-quality", fullscreen: true });
  }
  screenFullscreenPeerId = nextPeerId;
  // Keep the existing decoder/track; reloading srcObject causes a black flash
  // and cannot manufacture detail that the sender did not capture.
  if (screenShareStream.srcObject && screenShareStream.paused) void screenShareStream.play().catch(() => undefined);
  updateScreenFullscreenButton();
}

function exitScreenFullscreen(): void {
  screenFullscreenRequest++;
  screenShareMain.classList.remove("screen-share-main--fullscreen");
  if (document.fullscreenElement === screenShareMain) void document.exitFullscreen().catch(() => undefined);
  if (screenFullscreenPeerId && screenFullscreenPeerId !== selfParticipant?.id) {
    peerManager?.sendTo(screenFullscreenPeerId, { type: "screen-quality", fullscreen: false });
  }
  screenFullscreenPeerId = null;
  updateScreenFullscreenButton();
}

btnScreenFullscreen.addEventListener("click", () => {
  if (!screenShareStream.srcObject || !watchingScreenPeerId) return;
  if (isScreenFullscreen()) { exitScreenFullscreen(); return; }
  const request = ++screenFullscreenRequest;
  // CSS fallback is useful in Android WebViews without Fullscreen API support.
  if (!screenShareMain.requestFullscreen || !document.fullscreenEnabled) {
    screenShareMain.classList.add("screen-share-main--fullscreen");
    syncFullscreenScreenQuality();
    return;
  }
  void screenShareMain.requestFullscreen().then(() => {
    if (request !== screenFullscreenRequest || !watchingScreenPeerId) {
      exitScreenFullscreen();
      return;
    }
    syncFullscreenScreenQuality();
  }).catch(() => {
    if (request !== screenFullscreenRequest || !watchingScreenPeerId) return;
    screenShareMain.classList.add("screen-share-main--fullscreen");
    syncFullscreenScreenQuality();
  });
});
document.addEventListener("fullscreenchange", syncFullscreenScreenQuality);

async function toggleScreenPictureInPicture(): Promise<void> {
  if (!screenShareStream.srcObject) return;
  try {
    if (document.fullscreenElement === screenShareMain) await document.exitFullscreen();
    if (isScreenFullscreen()) exitScreenFullscreen();
    if (document.pictureInPictureElement === screenShareStream) {
      await document.exitPictureInPicture();
    } else if (screenShareStream.requestPictureInPicture) {
      await screenShareStream.requestPictureInPicture();
    } else {
      window.alert(t("pipUnsupported"));
    }
  } catch (error) {
    console.warn("Não foi possível abrir o Picture-in-Picture", error);
    window.alert(t("pipFailed"));
  }
}

/* ============================================================================
 * ÁUDIO REMOTO (mic dos peers) — elementos <audio> ocultos gerados via JS
 * ========================================================================== */

function attachRemoteAudio(peerId: string, stream: MediaStream): void {
  removeRemoteAudio(peerId);
  const audioEl = createRemoteAudioElement(peerId, "voice");
  remoteVoiceStreams.set(peerId, stream);
  audioEl.srcObject = stream;
  audioEl.muted = !speakerOn;
  configureAudioOutput(audioEl);
  void applyParticipantVoiceVolume(peerId);
  void audioEl.play().catch(() => undefined);
}

async function applyParticipantVoiceVolume(peerId: string): Promise<void> {
  const audioEl = remoteAudioEls.get(peerId);
  const stream = remoteVoiceStreams.get(peerId);
  if (!audioEl || !stream) return;

  const volume = (participantVoiceVolumes.get(peerId) ?? 100) / 100;
  if (volume <= 1) {
    closeRemoteVoiceController(peerId);
    if (audioEl.srcObject !== stream) audioEl.srcObject = stream;
    audioEl.volume = volume;
    audioEl.muted = !speakerOn;
    configureAudioOutput(audioEl);
    await audioEl.play().catch(() => undefined);
    return;
  }

  let controller = remoteVoiceControllers.get(peerId);
  try {
    if (!controller) {
      const context = new AudioContext();
      const source = context.createMediaStreamSource(stream);
      const gain = context.createGain();
      source.connect(gain).connect(context.destination);
      controller = { context, source, gain };
      remoteVoiceControllers.set(peerId, controller);
      await configureAudioContextOutput(context);
      audioEl.srcObject = stream;
      audioEl.volume = 1;
      audioEl.muted = true;
    }
    controller.gain.gain.setValueAtTime(speakerOn ? volume : 0, controller.context.currentTime);
    await controller.context.resume();
    if (controller.context.state !== "running") throw new Error("AudioContext suspenso");
    await audioEl.play().catch(() => undefined);
  } catch (error) {
    console.warn("Amplificação acima de 100% indisponível; usando áudio padrão", error);
    closeRemoteVoiceController(peerId);
    audioEl.srcObject = stream;
    audioEl.volume = 1;
    audioEl.muted = !speakerOn;
    configureAudioOutput(audioEl);
    await audioEl.play().catch(() => undefined);
  }
}

function closeRemoteVoiceController(peerId: string): void {
  const controller = remoteVoiceControllers.get(peerId);
  if (!controller) return;
  controller.source.disconnect();
  controller.gain.disconnect();
  void controller.context.close().catch(() => undefined);
  remoteVoiceControllers.delete(peerId);
}

function removeRemoteAudio(peerId: string): void {
  closeRemoteVoiceController(peerId);
  remoteVoiceStreams.delete(peerId);
  const audioEl = remoteAudioEls.get(peerId);
  if (!audioEl) return;
  audioEl.srcObject = null;
  audioEl.remove();
  remoteAudioEls.delete(peerId);
}

function attachRemoteScreenAudio(peerId: string, stream: MediaStream): void {
  removeRemoteScreenAudio(peerId);
  const audioEl = createRemoteAudioElement(peerId, "screen");
  audioEl.srcObject = stream;
  audioEl.muted = !speakerOn;
  configureAudioOutput(audioEl);
  remoteScreenAudioEls.set(peerId, audioEl);
  void audioEl.play().catch(() => undefined);
}

function removeRemoteScreenAudio(peerId: string): void {
  const audioEl = remoteScreenAudioEls.get(peerId);
  if (!audioEl) return;
  audioEl.srcObject = null;
  audioEl.remove();
  remoteScreenAudioEls.delete(peerId);
}

function createRemoteAudioElement(peerId: string, source: "voice" | "screen"): HTMLAudioElement {
  const audioEl = document.createElement("audio");
  audioEl.autoplay = true;
  audioEl.setAttribute("playsinline", "");
  audioEl.dataset.peerId = peerId;
  audioEl.dataset.source = source;
  audioEl.style.display = "none";
  document.body.appendChild(audioEl);
  if (source === "voice") remoteAudioEls.set(peerId, audioEl);
  return audioEl;
}

function configureAudioOutput(audioEl: HTMLAudioElement): void {
  const withSink = audioEl as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
  if (appSettings.speakerId) withSink.setSinkId?.(appSettings.speakerId).catch(() => undefined);
}

async function configureAudioContextOutput(context: AudioContext, sinkId = appSettings.speakerId): Promise<void> {
  if (!sinkId) return;
  const withSink = context as AudioContext & { setSinkId?: (id: string) => Promise<void> };
  await withSink.setSinkId?.(sinkId).catch(() => undefined);
}

/* ============================================================================
 * CHAT
 * ========================================================================== */

const CHAT_EMOJIS = [
  "😀", "😃", "😄", "😁", "😂", "🤣", "😊",
  "😍", "🥰", "😘", "😎", "🤔", "😅", "😭",
  "😡", "🥳", "🤯", "😴", "🤝", "👍", "👎",
  "👏", "🙏", "💪", "👀", "❤️", "💙", "💚",
  "🔥", "✨", "🎉", "✅", "❌", "⚠️", "💡",
  "🚀", "🎮", "🎵", "📷", "📎", "💬", "👋",
] as const;

for (const emoji of CHAT_EMOJIS) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "emoji-picker__item";
  button.textContent = emoji;
  button.setAttribute("aria-label", emoji);
  button.addEventListener("click", () => {
    const selectionStart = inputChat.selectionStart ?? inputChat.value.length;
    const selectionEnd = inputChat.selectionEnd ?? selectionStart;
    inputChat.setRangeText(emoji, selectionStart, selectionEnd, "end");
    setEmojiPickerOpen(false);
    inputChat.focus();
  });
  emojiPicker.appendChild(button);
}

function setEmojiPickerOpen(open: boolean): void {
  emojiPicker.classList.toggle("hidden", !open);
  btnEmojiPicker.setAttribute("aria-expanded", String(open));
}

btnEmojiPicker.addEventListener("click", () => {
  setEmojiPickerOpen(emojiPicker.classList.contains("hidden"));
});

document.addEventListener("pointerdown", (event) => {
  const target = event.target;
  if (!(target instanceof Node)) return;
  if (!emojiPicker.contains(target) && !btnEmojiPicker.contains(target)) setEmojiPickerOpen(false);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    setEmojiPickerOpen(false);
    closeMessageReactionPicker();
  }
});

function isChatNearBottom(): boolean {
  return chatMessagesEl.scrollHeight - chatMessagesEl.scrollTop - chatMessagesEl.clientHeight <= 80;
}

function scrollChatToBottom(): void {
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
  window.requestAnimationFrame(() => {
    chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
  });
}

function appendFileMessageShell(
  authorName: string,
  avatarColor: string | undefined,
  summary: string,
): HTMLDivElement {
  const wrapper = document.createElement("div");
  wrapper.className = "chat-message";
  const avatar = createAvatar("chat-message__avatar", avatarColor);
  const body = document.createElement("div");
  body.className = "chat-message__body";
  const meta = document.createElement("p");
  meta.className = "chat-message__meta";
  const author = document.createElement("span");
  author.className = "chat-message__author";
  author.textContent = authorName;
  author.style.color = avatarColor || "#f2f2f2";
  meta.append(author, ` - ${formatTime(new Date())}`);
  const text = document.createElement("p");
  text.className = "chat-message__text";
  text.textContent = summary;
  const card = document.createElement("div");
  card.className = "file-card";
  body.append(meta, text, card);
  wrapper.append(avatar, body);
  chatMessagesEl.appendChild(wrapper);
  scrollChatToBottom();
  return card;
}

function createIncomingFileView(offer: IncomingFileOffer): IncomingFileView {
  const participant = participants.get(offer.peerId);
  const authorName = participant?.nickname ?? "Peer";
  const card = appendFileMessageShell(
    authorName,
    participant?.avatarColor,
    t("sentFile", { name: offer.name }),
  );
  const content = document.createElement("div");
  content.className = "file-card__content";
  const name = document.createElement("p");
  name.className = "file-card__name";
  name.textContent = offer.name;
  name.title = offer.name;
  const meta = document.createElement("p");
  meta.className = "file-card__meta";
  meta.textContent = `${offer.mime || "application/octet-stream"} · ${formatFileSize(offer.size)}`;
  const status = document.createElement("p");
  status.className = "file-card__status";
  status.textContent = offer.requiresAcceptance
    ? t("fileOffer", { name: authorName })
    : t("preparingFile");
  const progress = document.createElement("div");
  progress.className = "file-card__progress hidden";
  const progressBar = document.createElement("div");
  progressBar.className = "file-card__progress-bar";
  progress.appendChild(progressBar);
  const actions = document.createElement("div");
  actions.className = "file-card__actions";
  content.append(name, meta, status, progress, actions);
  card.appendChild(content);
  return { offer, card, status, progress, progressBar, actions, handled: false };
}

async function handleIncomingFileOffer(manager: PeerManager, offer: IncomingFileOffer): Promise<void> {
  recordFileHistory(offer.peerId, offer.fileId, offer.name, offer.mime, offer.size);
  const key = fileTransferKey(offer.peerId, offer.fileId);
  const view = createIncomingFileView(offer);
  incomingFileViews.set(key, view);
  playEffect("message", "message");

  const accept = async () => {
    if (view.handled) return;
    view.handled = true;
    view.actions.replaceChildren();
    view.status.textContent = t("preparingFile");
    try {
      await fileStorageService.prepare(offer.fileId, offer.name, offer.mime, offer.size);
      view.progress.classList.remove("hidden");
      view.status.textContent = t("receiving", { progress: 0 });
      manager.respondToFileOffer(offer.peerId, offer.fileId, true);
    } catch (error) {
      console.error("Não foi possível preparar o arquivo temporário", error);
      manager.respondToFileOffer(offer.peerId, offer.fileId, false);
      markIncomingFileFailed(offer.peerId, offer.fileId);
    }
  };

  if (!offer.requiresAcceptance) {
    await accept();
    return;
  }

  const acceptButton = document.createElement("button");
  acceptButton.type = "button";
  acceptButton.className = "file-card__button file-card__button--accept";
  acceptButton.textContent = t("accept");
  acceptButton.addEventListener("click", () => void accept());
  const declineButton = document.createElement("button");
  declineButton.type = "button";
  declineButton.className = "file-card__button file-card__button--decline";
  declineButton.textContent = t("decline");
  declineButton.addEventListener("click", () => {
    if (view.handled) return;
    view.handled = true;
    manager.respondToFileOffer(offer.peerId, offer.fileId, false);
    view.actions.replaceChildren();
    view.status.textContent = t("declined");
    incomingFileViews.delete(key);
  });
  view.actions.append(acceptButton, declineButton);
}

async function completeIncomingFile(file: ReceivedFile): Promise<void> {
  const key = fileTransferKey(file.peerId, file.fileId);
  const view = incomingFileViews.get(key);
  if (!view) return;
  try {
    const stored = await fileStorageService.finalize(file.fileId);
    renderCompletedFileCard(view.card, {
      ...stored,
      name: view.offer.name,
      mime: view.offer.mime || "application/octet-stream",
      size: view.offer.size,
    });
    incomingFileViews.delete(key);
    scrollChatToBottom();
  } catch (error) {
    console.error("Não foi possível finalizar o arquivo recebido", error);
    markIncomingFileFailed(file.peerId, file.fileId);
  }
}

function markIncomingFileFailed(peerId: string, fileId: string): void {
  void fileStorageService.discard(fileId);
  const key = fileTransferKey(peerId, fileId);
  const view = incomingFileViews.get(key);
  if (!view) return;
  view.status.textContent = t("fileFailed");
  view.progress.classList.add("hidden");
  view.actions.replaceChildren();
  incomingFileViews.delete(key);
}

function renderCompletedFileCard(card: HTMLDivElement, file: StoredFile): void {
  const keepAtBottom = isChatNearBottom();
  card.replaceChildren();
  const safeMime = file.mime || "application/octet-stream";

  if (safeMime.startsWith("image/") && safeMime !== "image/svg+xml") {
    const previewButton = document.createElement("button");
    previewButton.type = "button";
    previewButton.className = "file-card__preview";
    previewButton.title = t("enlargeImage");
    previewButton.setAttribute("aria-label", t("enlargeImage"));
    const image = document.createElement("img");
    image.src = file.url;
    image.alt = file.name;
    image.loading = "lazy";
    image.addEventListener("load", () => {
      if (keepAtBottom) scrollChatToBottom();
    }, { once: true });
    previewButton.appendChild(image);
    previewButton.addEventListener("click", () => openFileLightbox(file.url, file.name));
    card.appendChild(previewButton);
  } else if (safeMime.startsWith("video/")) {
    const video = document.createElement("video");
    video.className = "file-card__preview";
    video.src = file.url;
    video.controls = true;
    video.preload = "metadata";
    video.addEventListener("loadedmetadata", () => {
      if (keepAtBottom) scrollChatToBottom();
    }, { once: true });
    card.appendChild(video);
  } else if (safeMime.startsWith("audio/")) {
    const audio = document.createElement("audio");
    audio.className = "file-card__audio";
    audio.src = file.url;
    audio.controls = true;
    audio.preload = "metadata";
    card.appendChild(audio);
  }

  const content = document.createElement("div");
  content.className = "file-card__content";
  const name = document.createElement("p");
  name.className = "file-card__name";
  name.textContent = file.name;
  name.title = file.name;
  const meta = document.createElement("p");
  meta.className = "file-card__meta";
  meta.textContent = `${safeMime} · ${formatFileSize(file.size)}`;
  const actions = document.createElement("div");
  actions.className = "file-card__actions";
  const download = document.createElement("button");
  download.type = "button";
  download.className = "file-card__button";
  download.textContent = t("download");
  download.addEventListener("click", async () => {
    try {
      const savedPath = await fileStorageService.saveToDownloads(file);
      if (!!("__TAURI_INTERNALS__" in window)) window.alert(t("downloadedTo", { path: savedPath }));
    } catch (error) {
      console.error("Não foi possível salvar o arquivo", error);
      window.alert(t("downloadFailed"));
    }
  });
  actions.appendChild(download);
  content.append(name, meta, actions);
  card.appendChild(content);
  if (keepAtBottom) scrollChatToBottom();
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${units[unitIndex]}`;
}

function openFileLightbox(url: string, name: string): void {
  fileLightboxImage.src = url;
  fileLightboxImage.alt = name;
  fileLightbox.classList.remove("hidden");
}

function closeFileLightbox(): void {
  fileLightbox.classList.add("hidden");
  fileLightboxImage.src = "";
}

btnCloseFileLightbox.addEventListener("click", closeFileLightbox);
fileLightbox.addEventListener("click", (event) => {
  if (event.target === fileLightbox) closeFileLightbox();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !fileLightbox.classList.contains("hidden")) closeFileLightbox();
});

const MESSAGE_REACTION_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "😡"] as const;

function appendChatMessage(message: ChatMessage): void {
  if (chatMessageViews.has(message.id)) return;
  message.createdAt ??= Date.now();

  const wrapper = document.createElement("div");
  wrapper.className = "chat-message";
  wrapper.dataset.messageId = message.id;
  wrapper.classList.toggle("chat-message--highlighted", message.highlighted === true);
  wrapper.classList.toggle("chat-message--system", message.kind === "system");

  const avatar = createAvatar("chat-message__avatar", message.avatarColor);
  const body = document.createElement("div");
  body.className = "chat-message__body";

  const meta = document.createElement("p");
  meta.className = "chat-message__meta";
  const author = document.createElement("span");
  author.className = "chat-message__author";
  author.textContent = message.author;
  author.style.color = message.avatarColor || "#f2f2f2";
  meta.append(author, ` - ${message.time}`);
  if (message.replyTo) {
    const replyNotice = document.createElement("span");
    replyNotice.className = "chat-message__notice";
    replyNotice.textContent = t("replyingTo", { name: message.replyTo.nickname });
    meta.append(" · ", replyNotice);
  }
  if (message.notice) {
    const notice = document.createElement("span");
    notice.className = "chat-message__notice";
    notice.textContent = message.notice;
    meta.append(" · ", notice);
  }

  const text = document.createElement("p");
  text.className = "chat-message__text";
  appendLinkifiedText(text, message.text);

  const reactionsElement = document.createElement("div");
  reactionsElement.className = "chat-message__reactions hidden";
  body.append(meta, text, reactionsElement);
  wrapper.append(avatar, body);

  const view: ChatMessageView = {
    message,
    wrapper,
    reactionsElement,
    reactions: new Map(),
    reactionEvents: new Map(),
  };
  chatMessageViews.set(message.id, view);

  if (message.actions !== false && message.kind !== "system" && message.kind !== "private") {
    wrapper.appendChild(createChatMessageActions(view));
  }

  const later = Array.from(chatMessageViews.values())
    .filter((view) => view.message.id !== message.id && (view.message.createdAt ?? 0) > message.createdAt!)
    .sort((a, b) => a.message.createdAt! - b.message.createdAt!)[0];
  chatMessagesEl.insertBefore(wrapper, later?.wrapper ?? null);
  const pending = pendingReactionEvents.get(message.id);
  if (pending) {
    pendingReactionEvents.delete(message.id);
    for (const reaction of pending) applyReactionEvent(message.id, reaction);
  }
  scrollChatToBottom();
}

const CHAT_URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;

function appendLinkifiedText(container: HTMLElement, value: string): void {
  let cursor = 0;
  for (const match of value.matchAll(CHAT_URL_PATTERN)) {
    const matchIndex = match.index ?? 0;
    if (matchIndex > cursor) container.append(document.createTextNode(value.slice(cursor, matchIndex)));

    const matchedValue = match[0];
    const urlText = matchedValue.replace(/[),.!?;:]+$/u, "");
    const trailing = matchedValue.slice(urlText.length);
    const href = urlText.startsWith("www.") ? `https://${urlText}` : urlText;
    const link = document.createElement("a");
    link.className = "chat-message__link";
    link.href = href;
    link.textContent = urlText;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.addEventListener("click", (event) => {
      event.preventDefault();
      void openExternalLink(href);
    });
    container.append(link, document.createTextNode(trailing));
    cursor = matchIndex + matchedValue.length;
  }
  if (cursor < value.length) container.append(document.createTextNode(value.slice(cursor)));
}

async function openExternalLink(url: string): Promise<void> {
  try {
    if ("__TAURI_INTERNALS__" in window) await openUrl(url);
    else window.open(url, "_blank", "noopener,noreferrer");
  } catch (error) {
    console.warn("Não foi possível abrir o link externo", error);
  }
}

function createChatMessageActions(view: ChatMessageView): HTMLDivElement {
  const actions = document.createElement("div");
  actions.className = "chat-message__actions";

  if (view.message.authorId !== selfParticipant?.id) {
    const reply = document.createElement("button");
    reply.type = "button";
    reply.className = "chat-message__action";
    reply.title = t("replyMessage");
    reply.setAttribute("aria-label", t("replyMessage"));
    const icon = document.createElement("img");
    icon.src = ICON_URLS.reply;
    icon.alt = "";
    reply.appendChild(icon);
    reply.addEventListener("click", () => {
      setPendingReply({ peerId: view.message.authorId, nickname: view.message.author });
    });
    actions.appendChild(reply);
  }

  const reaction = document.createElement("button");
  reaction.type = "button";
  reaction.className = "chat-message__action chat-message__action--reaction";
  reaction.title = t("addReaction");
  reaction.setAttribute("aria-label", t("addReaction"));
  const icon = document.createElement("img");
  icon.src = ICON_URLS.reaction;
  icon.alt = "";
  reaction.appendChild(icon);
  reaction.addEventListener("click", () => toggleMessageReactionPicker(view));
  actions.appendChild(reaction);
  return actions;
}

function toggleMessageReactionPicker(view: ChatMessageView): void {
  const existing = view.wrapper.querySelector<HTMLDivElement>(".message-reaction-picker");
  closeMessageReactionPicker();
  if (existing) return;

  const picker = document.createElement("div");
  picker.className = "message-reaction-picker";
  for (const emoji of MESSAGE_REACTION_EMOJIS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "message-reaction-picker__item";
    button.textContent = emoji;
    button.setAttribute("aria-label", emoji);
    button.addEventListener("click", () => {
      toggleOwnReaction(view.message.id, emoji);
      closeMessageReactionPicker();
    });
    picker.appendChild(button);
  }
  view.wrapper.appendChild(picker);
  openMessageReactionPicker = picker;
}

function closeMessageReactionPicker(): void {
  openMessageReactionPicker?.remove();
  openMessageReactionPicker = null;
}

function toggleOwnReaction(messageId: string, emoji: string): void {
  if (!selfParticipant || !peerManager) return;
  const view = chatMessageViews.get(messageId);
  if (!view) return;
  const active = !view.reactions.get(emoji)?.has(selfParticipant.id);
  const revision = (view.reactionEvents.get(`${selfParticipant.id}:${emoji}`)?.revision ?? 0) + 1;
  const event = { peerId: selfParticipant.id, emoji, active, revision };
  applyReactionEvent(messageId, event);
  peerManager.broadcast({ type: "reaction", messageId, emoji, active, revision });
}

function applyReactionEvent(messageId: string, reaction: ReactionEvent): void {
  if (!Number.isSafeInteger(reaction.revision) || reaction.revision < 1) return;
  if (!MESSAGE_REACTION_EMOJIS.includes(reaction.emoji as typeof MESSAGE_REACTION_EMOJIS[number])) return;
  const view = chatMessageViews.get(messageId);
  if (!view) {
    const pending = pendingReactionEvents.get(messageId) ?? [];
    pending.push(reaction);
    pendingReactionEvents.set(messageId, pending);
    return;
  }
  const key = `${reaction.peerId}:${reaction.emoji}`;
  if ((view.reactionEvents.get(key)?.revision ?? 0) >= reaction.revision) return;
  view.reactionEvents.set(key, reaction);
  const peers = view.reactions.get(reaction.emoji) ?? new Set<string>();
  if (reaction.active) peers.add(reaction.peerId);
  else peers.delete(reaction.peerId);
  if (peers.size > 0) view.reactions.set(reaction.emoji, peers);
  else view.reactions.delete(reaction.emoji);
  renderMessageReactions(view);
}

function renderMessageReactions(view: ChatMessageView): void {
  view.reactionsElement.replaceChildren();
  for (const [emoji, peerIds] of view.reactions) {
    if (peerIds.size === 0) continue;
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chat-message__reaction";
    chip.classList.toggle("is-active", Boolean(selfParticipant && peerIds.has(selfParticipant.id)));
    chip.textContent = `${emoji} ${peerIds.size}`;
    chip.setAttribute("aria-label", `${emoji}: ${peerIds.size}`);
    chip.addEventListener("click", () => toggleOwnReaction(view.message.id, emoji));
    view.reactionsElement.appendChild(chip);
  }
  const hasReactions = view.reactionsElement.childElementCount > 0;
  view.reactionsElement.classList.toggle("hidden", !hasReactions);
  view.wrapper.classList.toggle("chat-message--has-reactions", hasReactions);
}

function setPendingReply(reply: ChatReplyReference): void {
  pendingReply = reply;
  replyContextText.textContent = t("replyingComposer", { name: reply.nickname });
  replyContext.classList.remove("hidden");
  inputChat.focus();
}

function clearPendingReply(): void {
  pendingReply = null;
  replyContext.classList.add("hidden");
  replyContextText.textContent = "";
}

btnCancelReply.addEventListener("click", clearPendingReply);

function appendLocalSystemMessage(text: string, highlighted = false): void {
  appendChatMessage({
    id: crypto.randomUUID(),
    authorId: "system",
    author: "SilentHuddle",
    text,
    time: formatTime(new Date()),
    avatarColor: "#f59e0b",
    kind: "system",
    highlighted,
    actions: false,
  });
}

function sendPublicChatMessage(text: string, kind: "normal" | "warn" = "normal"): void {
  if (!selfParticipant || !peerManager) return;
  const messageId = crypto.randomUUID();
  const time = formatTime(new Date());
  const createdAt = Date.now();
  const replyTo = pendingReply ?? undefined;
  peerManager.broadcast({ type: "chat", messageId, text, time, createdAt, kind, replyTo });
  appendChatMessage({
    id: messageId,
    authorId: selfParticipant.id,
    author: selfParticipant.nickname,
    text,
    time,
    createdAt,
    avatarColor: selfParticipant.avatarColor,
    kind,
    replyTo,
    highlighted: kind === "warn",
  });
  clearPendingReply();
  playEffect("message", "message");
}

function handleChatCommand(rawText: string): boolean {
  if (!rawText.startsWith("/")) return false;
  if (!selfParticipant || !peerManager) return true;
  const separator = rawText.search(/\s/);
  const command = (separator === -1 ? rawText : rawText.slice(0, separator)).toLowerCase();
  const argument = separator === -1 ? "" : rawText.slice(separator).trim();

  switch (command) {
    case "/help":
      appendLocalSystemMessage(argument ? t("syntaxHelp") : t("helpCommands"), Boolean(argument));
      return true;

    case "/avatarcolor":
      if (!argument || argument.split(/\s+/).length !== 1) {
        appendLocalSystemMessage(t("syntaxAvatarColor"), true);
        return true;
      }
      changeAvatarColorFromCommand(argument);
      return true;

    case "/nickname":
      if (!argument || argument.length > MAX_NICKNAME_LENGTH) {
        appendLocalSystemMessage(t("syntaxNickname", { max: MAX_NICKNAME_LENGTH }), true);
        return true;
      }
      selfParticipant.nickname = argument;
      inputNickname.value = argument;
      appSettings.lastNickname = argument;
      persistSettings();
      updateLocalMessageIdentity();
      refreshParticipantsUI();
      refreshVideoGridUI();
      broadcastPresence();
      appendLocalSystemMessage(t("nicknameChanged", { name: argument }));
      return true;

    case "/warn":
      if (!argument) {
        appendLocalSystemMessage(t("syntaxWarn"), true);
        return true;
      }
      sendPublicChatMessage(argument, "warn");
      return true;

    case "/msg":
      sendPrivateChatMessage(argument);
      return true;

    default:
      appendLocalSystemMessage(t("commandUnknown"), true);
      return true;
  }
}

function changeAvatarColorFromCommand(value: string): void {
  if (!selfParticipant) return;
  const aliases: Record<string, string> = {
    white: "#f2f2f2", branco: "#f2f2f2",
    red: "#ef4444", vermelho: "#ef4444",
    orange: "#f59e0b", laranja: "#f59e0b",
    green: "#22c55e", verde: "#22c55e",
    blue: "#3b82f6", azul: "#3b82f6",
    purple: "#a855f7", roxo: "#a855f7",
    pink: "#ec4899", rosa: "#ec4899",
  };
  const normalized = aliases[value.toLowerCase()] ?? value;
  if (normalized.length > 64 || !CSS.supports("color", normalized)) {
    appendLocalSystemMessage(t("invalidAvatarColor"), true);
    return;
  }
  localAvatarColor = normalized;
  avatarColorIndex = Math.max(0, AVATAR_COLORS.indexOf(normalized));
  appSettings.avatarColor = normalized;
  btnAvatarPicker.style.borderColor = normalized;
  const avatarIcon = btnAvatarPicker.querySelector<HTMLImageElement>("img");
  if (avatarIcon) avatarIcon.style.color = normalized;
  selfParticipant.avatarColor = normalized;
  updateLocalMessageIdentity();
  persistSettings();
  refreshParticipantsUI();
  refreshVideoGridUI();
  broadcastPresence();
  appendLocalSystemMessage(t("avatarColorChanged", { color: value }));
}

function sendPrivateChatMessage(argument: string): void {
  if (!selfParticipant || !peerManager) return;
  if (!argument || argument.search(/\s/) <= 0) {
    appendLocalSystemMessage(t("syntaxMsg"), true);
    return;
  }
  const normalizedArgument = argument.toLocaleLowerCase();
  const candidates = Array.from(participants.values())
    .filter((participant) => {
      if (participant.id === selfParticipant?.id) return false;
      const nickname = participant.nickname.toLocaleLowerCase();
      return normalizedArgument.startsWith(`${nickname} `);
    })
    .sort((left, right) => right.nickname.length - left.nickname.length);
  const requestedNickname = argument.slice(0, argument.search(/\s/));
  if (candidates.length === 0) {
    appendLocalSystemMessage(t("privateUserNotFound", { name: requestedNickname }), true);
    return;
  }
  const longestNicknameLength = candidates[0].nickname.length;
  const matches = candidates.filter((participant) => participant.nickname.length === longestNicknameLength);
  const recipient = matches[0];
  const text = argument.slice(recipient.nickname.length).trim();
  if (!text) {
    appendLocalSystemMessage(t("syntaxMsg"), true);
    return;
  }
  if (matches.length > 1) {
    appendLocalSystemMessage(t("privateUserAmbiguous", { name: recipient.nickname }), true);
    return;
  }
  const messageId = crypto.randomUUID();
  const time = formatTime(new Date());
  const sent = peerManager.sendTo(recipient.id, {
    type: "chat",
    messageId,
    text,
    time,
    kind: "private",
  });
  if (!sent) {
    appendLocalSystemMessage(t("privateSendFailed", { name: recipient.nickname }), true);
    return;
  }
  appendChatMessage({
    id: messageId,
    authorId: selfParticipant.id,
    author: selfParticipant.nickname,
    text,
    time,
    avatarColor: selfParticipant.avatarColor,
    kind: "private",
    highlighted: true,
    notice: t("privateSentNotice", { name: recipient.nickname }),
    actions: false,
  });
  clearPendingReply();
  playEffect("message", "message");
}

function updateLocalMessageIdentity(): void {
  if (!selfParticipant) return;
  for (const view of chatMessageViews.values()) {
    if (view.message.authorId !== selfParticipant.id) continue;
    view.message.author = selfParticipant.nickname;
    view.message.avatarColor = selfParticipant.avatarColor;
    const author = view.wrapper.querySelector<HTMLElement>(".chat-message__author");
    if (author) {
      author.textContent = selfParticipant.nickname;
      author.style.color = selfParticipant.avatarColor || "#f2f2f2";
    }
    view.wrapper
      .querySelector<HTMLElement>(".chat-message__avatar")
      ?.style.setProperty("--avatar-color", selfParticipant.avatarColor || "#f2f2f2");
  }
}

document.addEventListener("pointerdown", (event) => {
  if (!openMessageReactionPicker) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (openMessageReactionPicker.contains(target) || target.closest(".chat-message__action--reaction")) return;
  closeMessageReactionPicker();
});

formChat.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = inputChat.value.trim();
  if (!text || !selfParticipant || !peerManager) return;
  if (text.length > 8_192) {
    appendLocalSystemMessage(t("messageTooLong"), true);
    return;
  }

  if (!handleChatCommand(text)) sendPublicChatMessage(text);
  inputChat.value = "";
  setEmojiPickerOpen(false);
});

const chatFileInput = document.createElement("input");
chatFileInput.type = "file";
chatFileInput.multiple = true;
chatFileInput.style.display = "none";
document.body.appendChild(chatFileInput);

btnAttachFile.addEventListener("click", () => chatFileInput.click());

chatFileInput.addEventListener("change", () => {
  const files = Array.from(chatFileInput.files ?? []);
  chatFileInput.value = "";
  for (const file of files) sendChatFile(file);
});

// Images and file items supplied by the OS/WebView use exactly the same
// offer/accept/chunk pipeline as the attachment button. Plain text stays native.
inputChat.addEventListener("paste", (event: ClipboardEvent) => {
  if (!peerManager || !selfParticipant || !event.clipboardData) return;
  const files = pastedFiles(event.clipboardData);
  if (!files.length) {
    const owner = selfParticipant.id;
    void nativeClipboardFiles(owner).then((attachments) => {
      if (selfParticipant?.id !== owner) {
        void clearClipboardFiles(owner).catch(() => undefined);
        return;
      }
      for (const attachment of attachments) sendChatFile(attachment.file, attachment.url);
    }).catch(() => {
      if (selfParticipant?.id === owner) appendLocalSystemMessage(t("pasteFileFailed"), true);
    });
    return;
  }
  event.preventDefault();
  for (const file of files) sendChatFile(file);
  const text = event.clipboardData.getData("text/plain");
  if (text) {
    const start = inputChat.selectionStart ?? inputChat.value.length;
    const end = inputChat.selectionEnd ?? start;
    const available = Math.max(0, inputChat.maxLength - inputChat.value.length + end - start);
    inputChat.setRangeText(text.slice(0, available), start, end, "end");
    inputChat.dispatchEvent(new Event("input", { bubbles: true }));
  }
});

function sendChatFile(file: OutgoingFileSource, previewUrl?: string): void {
  if (!file || !peerManager || !selfParticipant) return;
  const url = previewUrl ?? URL.createObjectURL(file as File);
  if (!previewUrl) outgoingPreviewUrls.add(url);

  const fileId = crypto.randomUUID();
  peerManager.broadcastFile(file, fileId);
  recordFileHistory(selfParticipant.id, fileId, file.name, file.type, file.size);
  const card = appendFileMessageShell(
    selfParticipant.nickname,
    selfParticipant.avatarColor,
    t("sentFile", { name: file.name }),
  );
  renderCompletedFileCard(card, {
    fileId,
    name: file.name,
    mime: file.type || "application/octet-stream",
    size: file.size,
    url,
  });
  playEffect("message", "message");
}

function recordFileHistory(peerId: string, fileId: string, name: string, mime: string, size: number): void {
  const participant = participants.get(peerId);
  fileHistory.set(fileId, {
    message: {
      id: `file-history:${fileId}`, authorId: peerId, author: participant?.nickname ?? "Peer",
      avatarColor: participant?.avatarColor, kind: "normal", createdAt: Date.now(), time: formatTime(new Date()),
      text: `${t("sentFile", { name: name.slice(0, 255) })} (${mime || "application/octet-stream"}, ${formatFileSize(size)})`,
    },
    reactions: new Map(),
  });
}

document.addEventListener("keydown", (event) => {
  const dialog = !backendDialog.classList.contains("hidden") ? backendDialog
    : !joinDialog.classList.contains("hidden") ? joinDialog
    : !addFriendDialog.classList.contains("hidden") ? addFriendDialog : null;
  if (!dialog) return;
  if (event.key === "Escape") {
    if (dialog === backendDialog) closeBackendDialog();
    else if (dialog === joinDialog) leaveRoomSession(false);
    else if (!addFriendBusy) addFriendDialog.classList.add("hidden");
    event.preventDefault();
  } else if (event.key === "Tab") {
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)"))
      .filter((element) => !element.classList.contains("hidden"));
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && isScreenFullscreen()) {
    exitScreenFullscreen();
    event.preventDefault();
  }
});

/* ============================================================================
 * ESTADO INICIAL
 * ========================================================================== */

showScreen("home");
renderParticipantsList([]);

export {
  showScreen,
  renderParticipantsList,
  renderVideoGrid,
  createVideoTile,
  applyTileState,
  showCallStarted,
  showJoinedCall,
  leaveCallUI,
  showScreenShareView,
  hideScreenShareView,
  appendChatMessage,
  populateDeviceOptions,
};
