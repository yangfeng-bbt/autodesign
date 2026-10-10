import { createServer } from "node:http";
import { createServer as createProbeServer } from "node:net";
import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const host = process.env.HOST || "127.0.0.1";
const explicitPort = Boolean(process.env.PORT);
let port = Number(process.env.PORT || 5173);
const comfyTarget = new URL(process.env.COMFY_TARGET || "http://127.0.0.1:8188");

function writeJson(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache" });
  response.end(JSON.stringify(payload));
}

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp"
};

function safeProjectSegment(value, fallback = "默认项目") {
  const segment = String(value || "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/^\.+/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return segment || fallback;
}

function materialDirectory(project, type) {
  return normalize(join(root, "project-data", safeProjectSegment(project), type));
}

function materialFilePath(project, type, fileName) {
  const directory = materialDirectory(project, type);
  const safeName = safeProjectSegment(fileName, "");
  if (!safeName) return null;
  const filePath = normalize(join(directory, safeName));
  return filePath.startsWith(directory) ? filePath : null;
}

function markdownTitle(fileName, content) {
  const heading = String(content || "").match(/^#\s+(.+)$/m);
  return (heading?.[1] || String(fileName || "").replace(/\.md$/i, "")).trim();
}

async function listMaterialFiles(project, type, extensions) {
  const directory = materialDirectory(project, type);
  await mkdir(directory, { recursive: true });
  const files = [];
  for (const entry of await readdir(directory)) {
    if (!extensions.some(extension => entry.toLowerCase().endsWith(extension))) continue;
    const filePath = join(directory, entry);
    const info = await stat(filePath).catch(() => null);
    if (!info?.isFile()) continue;
    const item = {
      file: entry,
      size: info.size,
      updatedAt: info.mtime.toISOString()
    };
    if (type === "text") {
      item.title = markdownTitle(entry, await readFile(filePath, "utf8"));
    }
    files.push(item);
  }
  return files.sort((left, right) => left.file.localeCompare(right.file, "zh-CN"));
}

async function writeMaterialResponse(response, filePath, contentType) {
  const content = await readFile(filePath);
  response.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "no-cache",
    "Content-Length": content.length
  });
  response.end(content);
}

const server = createServer(async (request, response) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);
  const readRequestBody = async () => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    return Buffer.concat(chunks);
  };
  if (requestUrl.pathname === "/comfy" || requestUrl.pathname.startsWith("/comfy/")) {
    try {
      const upstreamPath = `${requestUrl.pathname.slice("/comfy".length) || "/"}${requestUrl.search}`;
      const upstreamUrl = new URL(upstreamPath, comfyTarget);
      const headers = new Headers(request.headers);
      headers.delete("host");
      headers.delete("origin");
      headers.delete("referer");
      const body = ["GET", "HEAD"].includes(request.method) ? null : await readRequestBody();
      const upstream = await fetch(upstreamUrl, {
        method: request.method,
        headers,
        body,
        redirect: "manual"
      });
      const responseHeaders = Object.fromEntries(upstream.headers);
      delete responseHeaders["content-encoding"];
      delete responseHeaders["content-length"];
      delete responseHeaders["transfer-encoding"];
      response.writeHead(upstream.status, responseHeaders);
      response.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (error) {
      console.error(`ComfyUI proxy failed: ${request.method} ${requestUrl.pathname}${requestUrl.search}\n${error.stack || error.message}`);
      response.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(`ComfyUI proxy failed: ${error.message}`);
    }
    return;
  }

  try {
    let pathname = decodeURIComponent(requestUrl.pathname);

    if (pathname === "/api/workflows") {
      const files = (await readdir(join(root, "workflows")))
        .filter(file => file.toLowerCase().endsWith(".json"));
      const workflows = [];
      for (const file of files) {
        try {
          const workflow = JSON.parse(await readFile(join(root, "workflows", file), "utf8"));
          if (!workflow || typeof workflow !== "object" || Array.isArray(workflow)) continue;
          const nodes = Object.values(workflow);
          if (!nodes.length || nodes.some(node => !node?.class_type || typeof node.inputs !== "object")) continue;
          const base = file.replace(/\.json$/i, "").replace(/\.api$/i, "");
          const id = base.replace(/[^a-z0-9_]+/gi, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "") || `workflow_${workflows.length + 1}`;
          workflows.push({
            id,
            name: base.replace(/_+/g, " "),
            file,
            imageToImage: nodes.some(node => node.class_type === "LoadImage")
          });
        } catch {
          // Ignore invalid workflow JSON files; they are not selectable.
        }
      }
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache" });
      response.end(JSON.stringify(workflows));
      return;
    }

    if (pathname === "/api/materials/text") {
      const project = requestUrl.searchParams.get("project") || "";
      writeJson(response, 200, {
        directory: `project-data/${safeProjectSegment(project)}/text`,
        files: await listMaterialFiles(project, "text", [".md"])
      });
      return;
    }

    if (pathname === "/api/materials/text/content") {
      const project = requestUrl.searchParams.get("project") || "";
      const fileName = requestUrl.searchParams.get("file") || "";
      const filePath = materialFilePath(project, "text", fileName);
      if (!filePath || !filePath.toLowerCase().endsWith(".md")) {
        writeJson(response, 400, { error: "文本文件无效" });
        return;
      }
      writeJson(response, 200, { file: fileName, content: await readFile(filePath, "utf8") });
      return;
    }

    if (pathname === "/api/materials/text/save") {
      if (request.method !== "POST") {
        writeJson(response, 405, { error: "Method not allowed" });
        return;
      }
      const payload = JSON.parse(Buffer.from(await readRequestBody()).toString("utf8"));
      const filePath = materialFilePath(payload.project, "text", payload.file);
      if (!filePath || !filePath.toLowerCase().endsWith(".md")) {
        writeJson(response, 400, { error: "文本文件无效" });
        return;
      }
      await mkdir(materialDirectory(payload.project, "text"), { recursive: true });
      await writeFile(filePath, String(payload.content || ""), "utf8");
      writeJson(response, 200, { file: payload.file, savedAt: new Date().toISOString() });
      return;
    }

    if (pathname === "/api/materials/image") {
      const project = requestUrl.searchParams.get("project") || "";
      const fileName = requestUrl.searchParams.get("file") || "";
      const filePath = materialFilePath(project, "images", fileName);
      if (!filePath) {
        response.writeHead(404).end("Not found");
        return;
      }
      await writeMaterialResponse(response, filePath, mimeTypes[extname(filePath).toLowerCase()] || "application/octet-stream");
      return;
    }

    if (pathname === "/api/materials/images") {
      const project = requestUrl.searchParams.get("project") || "";
      const files = await listMaterialFiles(project, "images", [".png", ".jpg", ".jpeg", ".webp"]);
      writeJson(response, 200, {
        directory: `project-data/${safeProjectSegment(project)}/images`,
        files: files.map(item => ({
          ...item,
          url: `/api/materials/image?project=${encodeURIComponent(project)}&file=${encodeURIComponent(item.file)}`
        }))
      });
      return;
    }

    if (pathname === "/api/materials/images/upload" && request.method === "POST") {
      const project = requestUrl.searchParams.get("project") || "";
      const requestedName = decodeURIComponent(request.headers["x-file-name"] || "image.png");
      const extension = extname(requestedName).toLowerCase() || ".png";
      if (![".png", ".jpg", ".jpeg", ".webp"].includes(extension)) {
        writeJson(response, 400, { error: "仅支持 PNG / JPG / WEBP 图片" });
        return;
      }
      const directory = materialDirectory(project, "images");
      await mkdir(directory, { recursive: true });
      const base = safeProjectSegment(requestedName.replace(/\.[^.]+$/, ""), "image");
      let fileName = `${base}${extension}`;
      let count = 1;
      while (await stat(join(directory, fileName)).then(() => true).catch(() => false)) {
        fileName = `${base}_${count}${extension}`;
        count += 1;
      }
      await writeFile(join(directory, fileName), Buffer.from(await readRequestBody()));
      writeJson(response, 200, { file: fileName });
      return;
    }

    if (pathname === "/api/materials/images/delete" && request.method === "POST") {
      const payload = JSON.parse(Buffer.from(await readRequestBody()).toString("utf8"));
      const filePath = materialFilePath(payload.project, "images", payload.file);
      if (!filePath) {
        writeJson(response, 400, { error: "图片文件无效" });
        return;
      }
      await unlink(filePath);
      writeJson(response, 200, { file: payload.file });
      return;
    }

    if (pathname === "/") pathname = "/index.html";

    const filePath = normalize(join(root, pathname));
    if (!filePath.startsWith(root)) {
      response.writeHead(403).end("Forbidden");
      return;
    }

    const content = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": mimeTypes[extname(filePath).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-cache"
    });
    response.end(content);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
});

function isPortFree(candidate) {
  return new Promise(resolve => {
    const probe = createProbeServer();
    probe.once("error", () => resolve(false));
    probe.listen(candidate, host, () => probe.close(() => resolve(true)));
  });
}

if (!explicitPort) {
  for (let candidate = 5173; candidate <= 5199; candidate += 1) {
    if (await isPortFree(candidate)) {
      port = candidate;
      break;
    }
  }
}

server.listen(port, host, () => {
  console.log(`AutoDesign: http://${host}:${port}`);
});

server.once("error", error => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${port} is in use. Stop the old AutoDesign process or set PORT to another value.`);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
