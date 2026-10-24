import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { normalizeBackendUrl } from "../src/backendUrl.ts";
import { screenQualityParameters } from "../src/screenQuality.ts";
import { nativeClipboardFiles, clearClipboardFiles, pastedFiles } from "../src/clipboardFiles.ts";
import { DEFAULT_SETTINGS, loadAppSettings, saveAppSettings } from "../src/settingsService.ts";
import { RendezvousClient } from "../src/signaling.ts";

globalThis.window = globalThis as unknown as Window & typeof globalThis;
const runtime = window as unknown as { __TAURI_INTERNALS__?: Record<string, unknown> };

test("backend vazio seleciona padrão e URL personalizada preserva o endpoint completo", () => {
  assert.equal(normalizeBackendUrl("  "), "");
  assert.equal(normalizeBackendUrl(" https://SERVER.example/api/ "), "https://server.example/api/");
  assert.equal(normalizeBackendUrl("https://server.example/custom/endpoint"), "https://server.example/custom/endpoint");
  assert.equal(normalizeBackendUrl("http://127.0.0.1:3001/api/"), "http://127.0.0.1:3001/api/");
  assert.equal(normalizeBackendUrl("http://[::1]:3001/api/"), "http://[::1]:3001/api/");
});

test("backend recusa URLs inseguras, credenciais, parâmetros e entradas inválidas", () => {
  for (const url of ["server.example", "javascript:alert(1)", "file:///C:/secret", "ftp://host/api",
    "http://server.example/api/", "https://user:pass@server.example/", "https://server.example/?key=secret",
    "https://server.example/#fragment", "https://ser\nver.example", "https://example.com/" + "a".repeat(2048)]) {
    assert.throws(() => normalizeBackendUrl(url), url);
  }
});

test("configurações antigas ganham backend padrão e URLs inválidas não são carregadas", async () => {
  let stored: unknown = { lastNickname: "Joao", language: "en-US" };
  runtime.__TAURI_INTERNALS__ = { invoke: async () => stored };
  try {
    assert.equal((await loadAppSettings()).backendUrl, "");
    stored = { ...stored as object, backendUrl: "https://custom.example/api/" };
    assert.equal((await loadAppSettings()).backendUrl, "https://custom.example/api/");
    stored = { backendUrl: "http://untrusted.example/" };
    assert.equal((await loadAppSettings()).backendUrl, "");
  } finally { delete runtime.__TAURI_INTERNALS__; }
});

test("configurações são salvas em ordem e com snapshot imutável", async () => {
  const writes: unknown[] = [];
  runtime.__TAURI_INTERNALS__ = { invoke: async (_cmd: string, args: { settings: unknown }) => {
    await new Promise((resolve) => setTimeout(resolve, 2));
    writes.push(args.settings);
  } };
  try {
    const settings = { ...DEFAULT_SETTINGS, backendUrl: "https://first.example/api/" };
    const first = saveAppSettings(settings);
    settings.backendUrl = "https://second.example/api/";
    const second = saveAppSettings(settings);
    assert.deepEqual(await Promise.all([first, second]), [true, true]);
    assert.deepEqual(writes.map((value) => (value as typeof settings).backendUrl),
      ["https://first.example/api/", "https://second.example/api/"]);
  } finally { delete runtime.__TAURI_INTERNALS__; }
});

test("signaling usa o backend escolhido para todas as ações, incluindo cancelamento", async (t) => {
  let url = "https://custom.example/api/";
  const calls: { url: string; action: string; version: string }[] = [];
  t.mock.method(globalThis, "fetch", async (input: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    calls.push({ url: input, action: body.action, version: body.clientVersion });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  const client = new RendezvousClient(() => url);
  const ticket = { code: "ABCDE", token: "private", expiresAt: Date.now() + 120_000 };
  await client.register("peer", { type: "offer", sdp: "offer" });
  await client.claim("ABCDE", "peer");
  await client.answer("ABCDE", "peer", "private", { type: "answer", sdp: "answer" });
  await client.poll(ticket);
  await client.cancel(ticket);
  assert.equal(calls.length, 5);
  assert.ok(calls.every((call) => call.url === url && call.version === "v1.4.1"));
  url = "https://another.example/api/";
  await client.register("peer", { type: "offer", sdp: "offer" });
  assert.equal(calls.at(-1)?.url, url);
});

test("tela cheia solicita resolução nativa sem alterar os IDs das codificações", () => {
  const original = { transactionId: "negotiated", codecs: [], headerExtensions: [], rtcp: {},
    encodings: [{ rid: "screen", active: true, scaleResolutionDownBy: 2 }] } as RTCRtpSendParameters;
  const high = screenQualityParameters(original, true)!;
  assert.equal(high.degradationPreference, "maintain-resolution");
  assert.equal(high.transactionId, original.transactionId);
  assert.equal(high.encodings[0].rid, "screen");
  assert.equal(high.encodings[0].scaleResolutionDownBy, 1);
  assert.equal(high.encodings[0].maxFramerate, 30);
  assert.equal(high.encodings[0].maxBitrate, 8_000_000);
  assert.equal(original.encodings[0].scaleResolutionDownBy, 2);
  const normal = screenQualityParameters(high, false)!;
  assert.equal(normal.degradationPreference, "balanced");
  assert.equal(normal.encodings[0].maxBitrate, undefined);
  assert.equal(screenQualityParameters({ ...original, encodings: [] }, true), null);
});

test("colar imagens e múltiplos arquivos usa FileList e fallback de DataTransferItem", () => {
  const image = new File(["pixels"], "image.png", { type: "image/png" });
  const zip = new File(["compressed"], "archive.zip", { type: "application/zip" });
  const data = { files: [image, zip], items: [] } as unknown as DataTransfer;
  assert.deepEqual(pastedFiles(data), [image, zip]);
  const fallback = { files: [], items: [{ kind: "file", getAsFile: () => image },
    { kind: "string", getAsFile: () => null }] } as unknown as DataTransfer;
  assert.deepEqual(pastedFiles(fallback), [image]);
  assert.deepEqual(pastedFiles({ files: [], items: [] } as unknown as DataTransfer), []);
});

test("arquivo nativo colado só lê bytes quando um bloco é solicitado", async () => {
  const calls: { command: string; args: any }[] = [];
  runtime.__TAURI_INTERNALS__ = {
    convertFileSrc: () => "asset://clipboard-preview",
    invoke: async (command: string, args: any) => {
      calls.push({ command, args });
      if (command === "read_clipboard_files") return [{ sourceId: "clipboard-1", name: "movie.mp4",
        size: 100_000_000, previewPath: "C:\\files\\movie.mp4" }];
      if (command === "read_clipboard_file_chunk") return [1, 2, 3];
    },
  };
  try {
    const [{ file, url }] = await nativeClipboardFiles("owner");
    assert.equal(file.type, "video/mp4");
    assert.equal(file.size, 100_000_000);
    assert.equal(url, "asset://clipboard-preview");
    assert.equal(calls.length, 1); // No preload of a large File/Blob.
    assert.deepEqual(Array.from(new Uint8Array(await file.slice(16_384, 32_768).arrayBuffer())), [1, 2, 3]);
    assert.deepEqual(calls[1].args, { sourceId: "clipboard-1", offset: 16_384, length: 16_384 });
    await clearClipboardFiles("owner");
    assert.equal(calls[2].command, "clear_clipboard_files");
  } finally { delete runtime.__TAURI_INTERNALS__; }
});

test("referências DOM existem e pop-ups usam a paleta do aplicativo", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  for (const match of main.matchAll(/\bel<[^>]+>\("([^"]+)"\)/g)) {
    assert.ok(html.includes(`id="${match[1]}"`), `Missing DOM ID ${match[1]}`);
  }
  const card = css.match(/\.rendezvous-card \{([^}]+)\}/)![1];
  assert.match(card, /background: var\(--panel\)/);
  assert.doesNotMatch(card, /#1e293b|#475569/);
  assert.ok(!html.includes("p2p-chat-test.vercel.app"));
});

test("versões e rotas de publicação apontam para os arquivos atuais", () => {
  const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  assert.equal(JSON.parse(read("package.json")).version, "1.4.1");
  assert.equal(JSON.parse(read("package-lock.json")).packages[""].version, "1.4.1");
  assert.equal(JSON.parse(read("src-tauri/tauri.conf.json")).version, "1.4.1");
  assert.match(read("src-tauri/Cargo.toml"), /version = "1\.4\.1"/);
  assert.match(read("src/config.ts"), /CLIENT_VERSION = "v1\.4\.1"/);
  assert.match(read("backendvercel/api/index.js"), /VERSION = "v1\.4\.1"/);
  assert.match(read("src-tauri/gen/android/app/tauri.properties"), /versionCode=1004001/);
  for (const [root, path] of [["", "vercel.json"], ["backendvercel/", "backendvercel/vercel.json"]]) {
    const config = JSON.parse(read(path));
    for (const build of config.builds) {
      assert.ok(existsSync(new URL(`../${root}${build.src}`, import.meta.url)), `${path}: missing build source`);
    }
    for (const route of config.routes) {
      assert.ok(existsSync(new URL(`../${root}${route.dest.replace(/^\//, "")}`, import.meta.url)), `${path}: missing route destination`);
    }
  }
});
