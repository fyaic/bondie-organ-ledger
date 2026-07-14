import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { BoardFilters } from "./data.ts";
import { loadBoard } from "./data.ts";

export interface DashboardServerOptions {
  port?: number;
  theme?: "light" | "dark";
  ledgerHome?: string;
}

const PUBLIC_DIR = fileURLToPath(new URL("./public/", import.meta.url));
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

export async function startDashboardServer(options: DashboardServerOptions = {}): Promise<http.Server> {
  const port = options.port || 7377;
  const theme = options.theme || "light";

  const server = http.createServer(async (req, res) => {
    try {
      if (!req.url) return sendText(res, 400, "Bad Request");
      const url = new URL(req.url, `http://127.0.0.1:${port}`);

      if (req.method !== "GET") return sendText(res, 405, "Method Not Allowed");
      if (url.pathname === "/api/board") {
        const data = loadBoard(parseFilters(url), options.ledgerHome);
        return sendJson(res, 200, data);
      }
      if (url.pathname === "/" || url.pathname === "/index.html") {
        return sendStatic(res, "index.html", theme);
      }
      if (url.pathname === "/dashboard.css" || url.pathname === "/dashboard.js") {
        return sendStatic(res, url.pathname.slice(1), theme);
      }

      return sendText(res, 404, "Not Found");
    } catch (error) {
      return sendJson(res, 500, { error: error instanceof Error ? error.message : "Unknown error" });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      console.log(`看板已启动 -> http://localhost:${port}（只读）`);
      resolve();
    });
  });

  return server;
}

function parseFilters(url: URL): BoardFilters {
  return {
    date: url.searchParams.get("date") || "recent",
    system: (url.searchParams.get("system") || "all") as BoardFilters["system"],
    severity: (url.searchParams.get("severity") || "all") as BoardFilters["severity"],
    q: url.searchParams.get("q") || "",
  };
}

async function sendStatic(res: http.ServerResponse, fileName: string, theme: string): Promise<void> {
  const safeName = path.basename(fileName);
  const fullPath = path.join(PUBLIC_DIR, safeName);
  let body = await fs.readFile(fullPath, "utf8");
  if (safeName === "index.html") body = body.replace("__DEFAULT_THEME__", theme);
  res.writeHead(200, { "content-type": CONTENT_TYPES[path.extname(safeName)] || "text/plain; charset=utf-8" });
  res.end(body);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": CONTENT_TYPES[".json"] });
  res.end(JSON.stringify(body));
}

function sendText(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(body);
}
