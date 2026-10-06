import { request as httpsRequest, Agent } from "node:https";
import { request as httpRequest } from "node:http";
import { createHash, X509Certificate } from "node:crypto";
import { connect as tlsConnect } from "node:tls";
import { endpoint, HomeError, type Endpoint, type WireRequest, type WireResponse } from "./home.js";

export function publicKeyPin(cert: X509Certificate): string {
  return createHash("sha256").update(cert.publicKey.export({ type: "spki", format: "der" })).digest("hex");
}

/** No redirect following. A pin identifies the key, so renewing its certificate keeps trust. */
export async function homeRequest(target: Endpoint, path: string, token: string, request: Partial<WireRequest> = {}, timeout = 20_000, headers: Record<string, string> = {}): Promise<WireResponse> {
  const address = endpoint(target);
  if (!path.startsWith("/") || path.startsWith("//")) throw new HomeError("Некорректный путь запроса.");
  const url = new URL(path, address.url);
  const body = request.body ? Buffer.from(request.body, "base64") : undefined;
  return new Promise((resolve, reject) => {
    const secure = url.protocol === "https:";
    let agent: Agent | undefined;
    if (secure && address.pin) {
      agent = new Agent();
      // Do not hand the socket to HTTP until key verification is complete. Even
      // authorization headers must remain unsent when the endpoint was replaced.
      agent.createConnection = ((options: any, callback: any) => {
        const socket = tlsConnect({ ...options, rejectUnauthorized: false });
        let finished = false;
        const done = (error?: Error) => { if (finished) return; finished = true; if (error) socket.destroy(); callback(error ?? null, error ? undefined : socket); };
        socket.once("error", done);
        socket.setTimeout(timeout, () => done(new HomeError("Устройство пока не отвечает.", 504)));
        socket.once("secureConnect", () => {
          try {
            const cert = socket.getPeerX509Certificate();
            if (!cert || publicKeyPin(cert) !== address.pin || Date.now() > Date.parse(cert.validTo) || Date.now() < Date.parse(cert.validFrom)) throw new HomeError("Не удалось подтвердить устройство. Проверьте приглашение и сертификат.", 495);
            done();
          } catch (error) { done(error as Error); }
        });
        return undefined;
      }) as Agent["createConnection"];
    }
    const req = (secure ? httpsRequest : httpRequest)(url, {
      method: request.method ?? "GET", ...(agent ? { agent } : {}),
      headers: { ...(token ? { authorization: "Bearer " + token } : {}), ...(body ? { "content-type": request.contentType ?? "application/json", "content-length": body.length } : {}), ...headers },
    }, res => {
      const chunks: Buffer[] = []; let size = 0;
      res.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 200 * 1024 * 1024) req.destroy(new HomeError("Ответ устройства слишком большой.")); else chunks.push(chunk); });
      res.on("end", () => { agent?.destroy(); resolve({ status: res.statusCode ?? 502, contentType: String(res.headers["content-type"] ?? "application/json"), body: Buffer.concat(chunks).toString("base64") }); });
      res.on("error", reject);
    });
    req.setTimeout(timeout, () => req.destroy(new HomeError("Устройство пока не отвечает.", 504)));
    req.on("error", error => { agent?.destroy(); reject(error); });
    req.end(body);
  });
}
export const wireJSON = (value: unknown, status = 200): WireResponse => ({ status, contentType: "application/json; charset=utf-8", body: Buffer.from(JSON.stringify(value)).toString("base64") });
export const requestJSON = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64");
export function resultJSON(response: WireResponse): any {
  let value: any;
  try { value = JSON.parse(Buffer.from(response.body, "base64").toString()); } catch { throw new HomeError("Устройство вернуло непонятный ответ.", 502); }
  if (response.status < 200 || response.status >= 300) throw new HomeError(typeof value.error === "string" ? value.error : "Устройство отклонило запрос.", response.status);
  return value;
}
