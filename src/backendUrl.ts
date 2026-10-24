/** Empty means the bundled default. Custom servers must use TLS, except loopback development. */
export function normalizeBackendUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.length > 2_048 || /\s/.test(trimmed)) throw new Error("INVALID_BACKEND_URL");
  const url = new URL(trimmed);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    || url.username || url.password || url.hash || url.search) {
    throw new Error("INVALID_BACKEND_URL");
  }
  return url.href;
}
