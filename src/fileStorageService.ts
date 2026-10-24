import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { FILE_CONFIRMATION_THRESHOLD } from "./config";

export interface StoredFile {
  fileId: string;
  name: string;
  mime: string;
  size: number;
  url: string;
  tempPath?: string;
}

interface BrowserFileBase {
  name: string;
  mime: string;
  size: number;
  receivedBytes: number;
}

interface BrowserDiskFile extends BrowserFileBase {
  kind: "disk";
  temporaryName: string;
  writer: FileSystemWritableFileStream;
}

interface BrowserMemoryFile extends BrowserFileBase {
  kind: "memory";
  chunks: Uint8Array[];
}

type BrowserIncomingFile = BrowserDiskFile | BrowserMemoryFile;

function isTauriRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

export class FileStorageService {
  private readonly browserIncoming = new Map<string, BrowserIncomingFile>();
  private readonly browserCompleted = new Map<string, { temporaryName?: string; url: string }>();
  private browserDirectory: FileSystemDirectoryHandle | null = null;

  async cleanup(): Promise<void> {
    if (isTauriRuntime()) {
      await invoke("cleanup_temp_files").catch(() => undefined);
      return;
    }
    if (this.browserIncoming.size === 0 && this.browserCompleted.size === 0) {
      await this.pruneOldBrowserFiles();
    }
    for (const fileId of Array.from(this.browserIncoming.keys())) await this.discard(fileId);
    for (const completed of this.browserCompleted.values()) {
      URL.revokeObjectURL(completed.url);
      if (completed.temporaryName) {
        await this.browserDirectory?.removeEntry(completed.temporaryName).catch(() => undefined);
      }
    }
    this.browserCompleted.clear();
  }

  async prepare(fileId: string, name: string, mime: string, size: number): Promise<void> {
    if (isTauriRuntime()) {
      await invoke("prepare_incoming_file", { fileId, fileName: name, size });
      return;
    }
    await this.discard(fileId);
    if (!navigator.storage?.getDirectory) {
      if (size > FILE_CONFIRMATION_THRESHOLD) {
        throw new Error("Este navegador não oferece armazenamento temporário em disco para arquivos grandes.");
      }
      this.browserIncoming.set(fileId, { kind: "memory", name, mime, size, receivedBytes: 0, chunks: [] });
      return;
    }
    this.browserDirectory ??= await (await navigator.storage.getDirectory()).getDirectoryHandle(
      "silent-huddle-temp", { create: true },
    );
    const extension = /\.[a-z0-9]{1,10}$/i.exec(name)?.[0] ?? "";
    const temporaryName = `${Date.now()}-${crypto.randomUUID()}${extension}`;
    const handle = await this.browserDirectory.getFileHandle(temporaryName, { create: true });
    try {
      const writer = await handle.createWritable();
      this.browserIncoming.set(fileId, {
        kind: "disk", name, mime, size, receivedBytes: 0, temporaryName, writer,
      });
    } catch (error) {
      await this.browserDirectory.removeEntry(temporaryName).catch(() => undefined);
      throw error;
    }
  }

  async append(fileId: string, base64Data: string): Promise<void> {
    if (isTauriRuntime()) {
      await invoke("append_incoming_file_chunk", { fileId, base64Data });
      return;
    }
    const incoming = this.browserIncoming.get(fileId);
    if (!incoming) throw new Error("Arquivo temporário não preparado");
    const bytes = base64ToBytes(base64Data);
    if (incoming.receivedBytes + bytes.byteLength > incoming.size) {
      throw new Error("O arquivo recebido excede o tamanho informado.");
    }
    if (incoming.kind === "disk") await incoming.writer.write(bytes as BufferSource);
    else incoming.chunks.push(bytes);
    incoming.receivedBytes += bytes.byteLength;
  }

  async finalize(fileId: string): Promise<StoredFile> {
    if (isTauriRuntime()) {
      const result = await invoke<{ path: string; name: string; size: number }>("finalize_incoming_file", { fileId });
      return {
        fileId,
        name: result.name,
        mime: "",
        size: result.size,
        tempPath: result.path,
        url: convertFileSrc(result.path),
      };
    }

    const incoming = this.browserIncoming.get(fileId);
    if (!incoming) throw new Error("Arquivo temporário não encontrado");
    if (incoming.receivedBytes !== incoming.size) {
      throw new Error("A transferência terminou antes de receber o arquivo completo.");
    }
    let blob: Blob;
    if (incoming.kind === "disk") {
      await incoming.writer.close();
      const handle = await this.browserDirectory!.getFileHandle(incoming.temporaryName);
      blob = await handle.getFile();
      if (blob.size !== incoming.size) throw new Error("O arquivo em disco não corresponde ao tamanho informado.");
    } else {
      blob = new Blob(incoming.chunks as BlobPart[], { type: incoming.mime || "application/octet-stream" });
    }
    this.browserIncoming.delete(fileId);
    const url = URL.createObjectURL(blob);
    this.browserCompleted.set(fileId, {
      ...(incoming.kind === "disk" ? { temporaryName: incoming.temporaryName } : {}),
      url,
    });
    return {
      fileId,
      name: incoming.name,
      mime: incoming.mime,
      size: incoming.size,
      url,
    };
  }

  async discard(fileId: string): Promise<void> {
    if (isTauriRuntime()) return;
    const incoming = this.browserIncoming.get(fileId);
    if (!incoming) return;
    this.browserIncoming.delete(fileId);
    if (incoming.kind === "disk") {
      await incoming.writer.abort().catch(() => undefined);
      await this.browserDirectory?.removeEntry(incoming.temporaryName).catch(() => undefined);
    }
  }

  private async pruneOldBrowserFiles(): Promise<void> {
    if (!navigator.storage?.getDirectory) return;
    try {
      this.browserDirectory ??= await (await navigator.storage.getDirectory()).getDirectoryHandle(
        "silent-huddle-temp", { create: true },
      );
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      for await (const [name] of this.browserDirectory as unknown as AsyncIterable<[string, FileSystemHandle]>) {
        const createdAt = Number(name.split("-", 1)[0]);
        if (Number.isFinite(createdAt) && createdAt > 0 && createdAt < cutoff) {
          await this.browserDirectory.removeEntry(name).catch(() => undefined);
        }
      }
    } catch (error) {
      console.warn("Não foi possível limpar arquivos temporários antigos do navegador", error);
    }
  }

  async saveToDownloads(file: StoredFile): Promise<string> {
    if (isTauriRuntime() && file.tempPath) {
      return invoke<string>("save_received_file", { sourcePath: file.tempPath, fileName: file.name });
    }

    const link = document.createElement("a");
    link.href = file.url;
    link.download = file.name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    return file.name;
  }
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
