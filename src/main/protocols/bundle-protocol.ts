import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";

const MIME = new Map([
  [".html", "text/html; charset=utf-8"], [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"], [".svg", "image/svg+xml"], [".png", "image/png"],
  [".woff2", "font/woff2"], [".json", "application/json; charset=utf-8"],
]);

export async function createBundleResponse(request: Request, root: string, scheme: "reader-app" | "reader-rendition") {
  try {
    const url = new URL(request.url);
    const expectedHost = scheme === "reader-app" ? "bundle" : "epub";
    if (url.protocol !== `${scheme}:` || url.hostname !== expectedHost) return new Response("Not found", { status: 404 });
    const relative = decodeURIComponent(url.pathname.slice(1) || (scheme === "reader-app" ? "index.html" : "epub-runner.html"));
    if (!/^[A-Za-z0-9._/-]+$/.test(relative) || relative.split("/").some((part) => part === "." || part === "..")) return new Response("Not found", { status: 404 });
    const base = resolve(root);
    const path = resolve(base, relative);
    if (path !== base && !path.startsWith(`${base}\\`) && !path.startsWith(`${base}/`)) return new Response("Not found", { status: 404 });
    const csp = scheme === "reader-app"
      ? "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' reader-resource: blob: data:; font-src 'self'; connect-src 'self'; frame-src reader-rendition:; child-src reader-rendition:"
      : "default-src 'none'; script-src 'self'; connect-src reader-resource:; style-src 'self' blob: 'unsafe-inline'; img-src 'self' reader-resource: blob: data:; font-src 'self' reader-resource: blob: data:; child-src blob:; frame-src blob:; worker-src blob:";
    return new Response(await readFile(path), { status: 200, headers: {
      "Content-Type": MIME.get(extname(path).toLowerCase()) ?? "application/octet-stream",
      "Content-Security-Policy": csp,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    } });
  } catch { return new Response("Not found", { status: 404 }); }
}
