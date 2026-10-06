/** An optional store address; never reuse a Home or OpenAI credential there. */
export function hostingOrigin(value: string | undefined): string | undefined {
  if (!value) return;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) return;
    const local = url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !local) return;
    return url.origin;
  } catch { return; }
}
