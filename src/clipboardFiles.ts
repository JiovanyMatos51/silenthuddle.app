import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { OutgoingFileSource } from "./types";

interface NativeClipboardFile { sourceId: string; name: string; size: number; previewPath: string }

export function pastedFiles(data: DataTransfer): File[] {
  const files = Array.from(data.files);
  return files.length ? files : Array.from(data.items)
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile()).filter((file): file is File => file !== null);
}

function fileMime(name: string): string {
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  const types: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
    avif: "image/avif", bmp: "image/bmp", svg: "image/svg+xml", mp4: "video/mp4", webm: "video/webm",
    mov: "video/quicktime", ogv: "video/ogg", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg",
    m4a: "audio/mp4", flac: "audio/flac", pdf: "application/pdf", zip: "application/zip", txt: "text/plain",
  };
  return types[extension] || "application/octet-stream";
}

/** Called only on a user paste gesture; no background clipboard monitoring. */
export async function nativeClipboardFiles(owner: string): Promise<{ file: OutgoingFileSource; url: string }[]> {
  if (!("__TAURI_INTERNALS__" in window)) return [];
  const files = await invoke<NativeClipboardFile[]>("read_clipboard_files", { owner });
  return files.map((item) => ({
    url: convertFileSrc(item.previewPath),
    file: {
      name: item.name, type: fileMime(item.name), size: item.size,
      slice: (start, end) => ({
        arrayBuffer: async () => {
          const bytes = await invoke<number[]>("read_clipboard_file_chunk", {
            sourceId: item.sourceId, offset: start, length: Math.max(0, Math.min(end, item.size) - start),
          });
          return Uint8Array.from(bytes).buffer;
        },
      }),
    },
  }));
}

export async function clearClipboardFiles(owner: string): Promise<void> {
  if ("__TAURI_INTERNALS__" in window) await invoke("clear_clipboard_files", { owner });
}
