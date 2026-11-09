/** A local OpenAI Responses endpoint: every request is recorded and answered with one streamed text reply,
 * the same one or the one chosen for its request body. */
import { createServer, type IncomingHttpHeaders } from "node:http";

export async function mockResponses(answer: string | ((body: any) => string)) {
  const requests: Array<{ method: string; url: string; headers: IncomingHttpHeaders; body: any }> = [];
  const server = createServer((request, response) => {
    let text = "";
    request.on("data", chunk => { text += chunk; });
    request.on("end", () => {
      const body = text ? JSON.parse(text) : null;
      requests.push({ method: request.method!, url: request.url!, headers: request.headers, body });
      if (request.method !== "POST" || !/\/responses(\?|$)/.test(request.url!)) { response.writeHead(404, { "content-type": "application/json" }).end('{"error":{"message":"not found"}}'); return; }
      const id = "resp_" + requests.length, model = body?.model, reply = typeof answer === "string" ? answer : answer(body);
      const item = { type: "message", id: "msg_" + requests.length, role: "assistant", status: "completed", content: [{ type: "output_text", text: reply, annotations: [] }] };
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      for (const [type, data] of [
        ["response.created", { response: { id, object: "response", model, status: "in_progress", output: [] } }],
        ["response.output_item.added", { output_index: 0, item: { ...item, content: [] } }],
        ["response.output_text.delta", { output_index: 0, content_index: 0, item_id: item.id, delta: reply }],
        ["response.output_item.done", { output_index: 0, item }],
        ["response.completed", { response: { id, object: "response", model, status: "completed", output: [item],
          usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 15 } } }],
      ] as const) response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      response.end();
    });
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, requests, close: () => new Promise<void>(done => server.close(() => done())) };
}
