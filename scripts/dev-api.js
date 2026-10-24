import { createServer } from "node:http";
import handler from "../backend/api/index.js";

const port = 3001;

createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString("utf8");
  try {
    console.log(`[local] ${request.method} ${JSON.parse(body).action || "unknown"}`);
  } catch { /* OPTIONS has no body. */ }
  response.status = (code) => {
    response.statusCode = code;
    return response;
  };
  response.json = (value) => {
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(JSON.stringify(value));
    return response;
  };
  await handler({
    method: request.method,
    url: request.url,
    headers: request.headers,
    socket: request.socket,
    body,
  }, response);
}).listen(port, "127.0.0.1", () => {
  console.log(`API local do SilentHuddle: http://127.0.0.1:${port}`);
});
