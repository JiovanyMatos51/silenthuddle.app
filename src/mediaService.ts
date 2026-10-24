/* ============================================================================
 * mediaService.ts — Módulo C: Mídia e Dispositivos
 *
 * Encapsula getUserMedia / getDisplayMedia e a troca de dispositivos. Não
 * conhece RTCPeerConnection nem DOM — apenas expõe tracks/streams para que
 * main.ts as repasse ao peerManager e aos elementos <video>/<audio>.
 * ========================================================================== */

export interface DeviceLists {
  mics: MediaDeviceInfo[];
  speakers: MediaDeviceInfo[];
  cameras: MediaDeviceInfo[];
}

export class MediaService {
  private micStream: MediaStream | null = null;
  private cameraStream: MediaStream | null = null;
  private screenStream: MediaStream | null = null;
  private audioProcessingEnabled = true;
  private speakingContext: AudioContext | null = null;
  private speakingSource: MediaStreamAudioSourceNode | null = null;
  private speakingTimer: number | null = null;
  private speaking = false;

  get micTrack(): MediaStreamTrack | null {
    return this.micStream?.getAudioTracks()[0] ?? null;
  }

  get cameraTrack(): MediaStreamTrack | null {
    return this.cameraStream?.getVideoTracks()[0] ?? null;
  }

  get screenTrack(): MediaStreamTrack | null {
    return this.screenStream?.getVideoTracks()[0] ?? null;
  }

  get screenAudioTrack(): MediaStreamTrack | null {
    return this.screenStream?.getAudioTracks()[0] ?? null;
  }

  get localMicStream(): MediaStream | null {
    return this.micStream;
  }

  get localCameraStream(): MediaStream | null {
    return this.cameraStream;
  }

  get localScreenStream(): MediaStream | null {
    return this.screenStream;
  }

  get isMicActive(): boolean {
    return Boolean(this.micTrack);
  }

  get isCameraActive(): boolean {
    return Boolean(this.cameraTrack);
  }

  get isScreenSharingActive(): boolean {
    return Boolean(this.screenTrack);
  }

  /* -- microfone -------------------------------------------------------------- */

  setAudioProcessing(enabled: boolean): void {
    this.audioProcessingEnabled = enabled;
  }

  async enableMic(deviceId?: string): Promise<MediaStreamTrack> {
    if (this.micStream) return this.micTrack!;
    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        noiseSuppression: this.audioProcessingEnabled,
        echoCancellation: this.audioProcessingEnabled,
        autoGainControl: this.audioProcessingEnabled,
      },
    });
    return this.micTrack!;
  }

  disableMic(): void {
    this.stopSpeakingDetection();
    this.micStream?.getTracks().forEach((track) => track.stop());
    this.micStream = null;
  }

  async switchMicDevice(deviceId: string): Promise<MediaStreamTrack> {
    this.disableMic();
    return this.enableMic(deviceId);
  }

  /** Detecta atividade de voz local por RMS, com histerese para evitar que o
   * contorno pisque entre sílabas. O áudio não é conectado à saída. */
  startSpeakingDetection(callback: (speaking: boolean) => void): void {
    this.stopSpeakingDetection();
    if (!this.micStream) return;

    const context = new AudioContext();
    const source = context.createMediaStreamSource(this.micStream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.45;
    source.connect(analyser);

    this.speakingContext = context;
    this.speakingSource = source;
    const samples = new Uint8Array(analyser.fftSize);
    let quietCycles = 0;

    const measure = () => {
      analyser.getByteTimeDomainData(samples);
      let energy = 0;
      for (const sample of samples) {
        const normalized = (sample - 128) / 128;
        energy += normalized * normalized;
      }
      const rms = Math.sqrt(energy / samples.length);
      const voiceDetected = rms >= 0.035;
      quietCycles = voiceDetected ? 0 : quietCycles + 1;
      const nextSpeaking = voiceDetected || (this.speaking && quietCycles < 5);
      if (nextSpeaking !== this.speaking) {
        this.speaking = nextSpeaking;
        callback(nextSpeaking);
      }
    };

    this.speakingTimer = window.setInterval(measure, 70);
  }

  stopSpeakingDetection(): void {
    if (this.speakingTimer !== null) window.clearInterval(this.speakingTimer);
    this.speakingTimer = null;
    this.speakingSource?.disconnect();
    this.speakingSource = null;
    if (this.speakingContext) void this.speakingContext.close().catch(() => undefined);
    this.speakingContext = null;
    this.speaking = false;
  }

  /* -- câmera ------------------------------------------------------------------ */

  async enableCamera(deviceId?: string): Promise<MediaStreamTrack> {
    if (this.cameraStream) return this.cameraTrack!;
    this.cameraStream = await navigator.mediaDevices.getUserMedia({
      video: deviceId ? { deviceId: { exact: deviceId } } : { width: 1280, height: 720 },
    });
    return this.cameraTrack!;
  }

  disableCamera(): void {
    this.cameraStream?.getTracks().forEach((track) => track.stop());
    this.cameraStream = null;
  }

  async switchCameraDevice(deviceId: string): Promise<MediaStreamTrack> {
    disableIfActive(this.cameraStream);
    this.cameraStream = null;
    return this.enableCamera(deviceId);
  }

  /* -- compartilhamento de tela -------------------------------------------------- */

  async startScreenShare(): Promise<MediaStreamTrack> {
    this.screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30, max: 30 } },
      // O navegador/SO pode devolver somente vídeo quando a fonte escolhida
      // não oferece áudio (por exemplo, algumas janelas e monitores).
      audio: true,
    });
    if (this.screenTrack) {
      this.screenTrack.contentHint = "detail";
      await this.screenTrack.applyConstraints({ frameRate: { ideal: 30, max: 30 } }).catch(() => undefined);
    }
    // se o usuário parar o compartilhamento pelo próprio diálogo do SO/navegador
    // (em vez de clicar no botão do app), ainda queremos saber.
    return this.screenTrack!;
  }

  onScreenShareEndedByUser(callback: () => void): void {
    this.screenTrack?.addEventListener("ended", callback, { once: true });
  }

  stopScreenShare(): void {
    this.screenStream?.getTracks().forEach((track) => track.stop());
    this.screenStream = null;
  }

  /* -- dispositivos --------------------------------------------------------------- */

  async listDevices(requestPermissions = true): Promise<DeviceLists> {
    if (requestPermissions) {
      try {
        // No Tauri, libera os rótulos dos dispositivos para os seletores.
        const tmp = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
        tmp.getTracks().forEach((track) => track.stop());
      } catch {
        /* permissão negada — enumeração ainda funciona, só sem labels legíveis */
      }
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    return {
      mics: devices.filter((device) => device.kind === "audioinput"),
      speakers: devices.filter((device) => device.kind === "audiooutput"),
      cameras: devices.filter((device) => device.kind === "videoinput"),
    };
  }

  /* -- encerramento total ---------------------------------------------------------- */

  stopAll(): void {
    this.disableMic();
    this.disableCamera();
    this.stopScreenShare();
  }
}

function disableIfActive(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}
