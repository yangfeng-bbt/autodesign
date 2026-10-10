export const WORKFLOW_TEMPLATES = [
  { id: "k2_anything2real_v3", name: "K2 漫转真 V3", imageToImage: true }
];

function parseAspectRatio(value, fallbackWidth = 2, fallbackHeight = 3) {
  const text = String(value || "").trim().toLowerCase();
  const pair = text.match(/^(\d+(?:\.\d+)?)\s*[:/x×]\s*(\d+(?:\.\d+)?)$/i);
  if (pair) {
    const width = Number(pair[1]);
    const height = Number(pair[2]);
    if (width > 0 && height > 0) return { width, height };
  }
  const single = Number(text);
  if (Number.isFinite(single) && single > 0) return { width: single, height: 1 };
  return { width: fallbackWidth, height: fallbackHeight };
}

export class ComfyUIClient {
  constructor(baseUrl = "http://127.0.0.1:8188") {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.workflowTemplates = new Map();
    this.registeredWorkflowTemplates = [];
  }

  async request(path, options = {}) {
    const response = await fetch(`${this.baseUrl}${path}`, options);
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`ComfyUI ${response.status} ${options.method || "GET"} ${path}: ${detail.slice(0, 500)}`);
    }
    const contentType = response.headers.get("content-type") || "";
    return contentType.includes("application/json") ? response.json() : response;
  }

  async connect() {
    const stats = await this.request("/system_stats");
    if (!stats?.system) throw new Error("返回数据不是 ComfyUI system_stats");
    return stats;
  }

  async uploadImage(file, savedName) {
    const body = new FormData();
    body.append("image", file, savedName);
    body.append("overwrite", "true");
    body.append("type", "input");
    const result = await this.request("/upload/image", { method: "POST", body });
    if (!result?.name) throw new Error("ComfyUI 图片上传失败");
    return result;
  }

  getWorkflowTemplate(id) {
    const registered = this.registeredWorkflowTemplates.find(item => item.id === id);
    if (registered) return { ...registered };
    const template = WORKFLOW_TEMPLATES.find(item => item.id === id);
    if (!template) return null;
    return template.id === "k2_anything2real_v3"
      ? { ...template, url: "./workflows/k2-anything2real-v3.api.json" }
      : { ...template };
  }

  registerWorkflowTemplates(templates = []) {
    this.registeredWorkflowTemplates = templates
      .filter(item => item?.id && item?.file)
      .map(item => ({
        id: item.id,
        name: item.name,
        file: item.file,
        url: `./workflows/${encodeURIComponent(item.file)}`,
        imageToImage: Boolean(item.imageToImage)
      }));
  }

  async loadWorkflowTemplate(id) {
    const template = this.getWorkflowTemplate(id);
    if (!template) return null;
    if (this.workflowTemplates.has(id)) {
      return { definition: template, workflow: this.workflowTemplates.get(id) };
    }

    const response = await fetch(template.url);
    if (!response.ok) throw new Error(`工作流加载失败 ${response.status}`);
    const workflow = await response.json();
    if (!workflow || typeof workflow !== "object" || Array.isArray(workflow)) {
      throw new Error("工作流格式无效：必须是 ComfyUI API JSON");
    }
    if (Object.values(workflow).some(node => !node?.class_type || typeof node.inputs !== "object")) {
      throw new Error("工作流格式无效：缺少 class_type 或 inputs");
    }
    this.workflowTemplates.set(id, workflow);
    return { definition: template, workflow };
  }

  inferWorkflowNodes(workflow) {
    const nodes = Object.entries(workflow);
    return {
      imageNode: nodes.find(([, node]) => node.class_type === "LoadImage")?.[0] || "",
      promptNode: (nodes.find(([, node]) => "prompt" in node.inputs)
        || nodes.find(([, node]) => "text" in node.inputs))?.[0] || "",
      dimensionNode: nodes.find(([, node]) => "width" in node.inputs && "height" in node.inputs)?.[0] || "",
      pixelNode: nodes.find(([, node]) => "megapixels" in node.inputs || "resolution_steps" in node.inputs)?.[0] || "",
      samplerNode: nodes.filter(([, node]) => /sampler/i.test(node.class_type)).map(([id]) => id).join(",")
    };
  }

  parseNodeIds(value) {
    return String(value || "").split(/[,\s，、]+/).map(id => id.trim()).filter(Boolean);
  }

  applyImportedNodeParams(result, params = {}) {
    const autoNodes = this.inferWorkflowNodes(result);
    const dimensionIds = this.parseNodeIds(params.dimensionNode || autoNodes.dimensionNode);
    const pixelIds = this.parseNodeIds(params.pixelNode || autoNodes.pixelNode);
    const samplerIds = this.parseNodeIds(params.samplerNode || autoNodes.samplerNode);
    const ratio = parseAspectRatio(params.aspectRatio, 2, 3);
    const targetPixels = Math.min(16, Math.max(0.1, Number(params.targetPixels) || 1.5));
    const scale = Math.sqrt((targetPixels * 1000000) / (ratio.width * ratio.height));
    const width = Math.max(256, Math.min(4096, Math.round((ratio.width * scale) / 8) * 8));
    const height = Math.max(256, Math.min(4096, Math.round((ratio.height * scale) / 8) * 8));

    for (const [id, node] of Object.entries(result)) {
      if (dimensionIds.includes(id) && "width" in node.inputs && "height" in node.inputs) {
        node.inputs.width = width;
        node.inputs.height = height;
      }
      if (pixelIds.includes(id)) {
        if ("megapixels" in node.inputs) node.inputs.megapixels = targetPixels;
        if ("resolution_steps" in node.inputs) {
          node.inputs.resolution_steps = Math.min(16, Math.max(1, Number(params.resolutionSteps) || Math.round(targetPixels / 0.25)));
        }
      }
      if (samplerIds.includes(id) && /sampler/i.test(node.class_type)) {
        if ("denoise" in node.inputs) node.inputs.denoise = Math.min(1, Math.max(0, Number(params.denoise ?? node.inputs.denoise)));
      }
    }
  }

  applyImportedNodeValues(result, params = {}) {
    const values = params.nodeValues || {};
    for (const [nodeId, overrides] of Object.entries(values)) {
      const node = result[nodeId];
      if (!node || !overrides || typeof overrides !== "object") continue;
      for (const [name, value] of Object.entries(overrides)) {
        const original = node.inputs[name];
        if (name in node.inputs && !Array.isArray(original) && !(original && typeof original === "object")) {
          node.inputs[name] = value;
        }
      }
    }
  }

  buildImportedWorkflow(workflow, { positivePrompt, inputImage, seed, filenamePrefix, workflowParams = {}, connectImage = false }) {
    const result = structuredClone(workflow);
    let promptPatched = false;
    let imagePatched = false;
    const entries = Object.entries(result);
    const autoNodes = this.inferWorkflowNodes(result);
    const mappedNodeIds = workflowParams.nodeIds || [];
    const mappedImageIds = this.parseNodeIds(mappedNodeIds.filter(id => result[id]?.class_type === "LoadImage").join(","));
    const mappedPromptIds = this.parseNodeIds(mappedNodeIds.filter(id =>
      "prompt" in (result[id]?.inputs || {}) || "text" in (result[id]?.inputs || {})
    ).join(","));
    const imageIds = mappedImageIds.length ? mappedImageIds : (connectImage ? this.parseNodeIds(autoNodes.imageNode) : []);
    const promptIds = mappedPromptIds.length
      ? mappedPromptIds
      : (positivePrompt ? this.parseNodeIds(autoNodes.promptNode) : []);
    const hasImageInput = entries.some(([nodeId, node]) =>
      node.class_type === "LoadImage" && typeof node.inputs.image === "string" && (!imageIds.length || imageIds.includes(nodeId))
    );
    if (connectImage && !inputImage) throw new Error("图生图需要先选择素材图");

    for (const [nodeId, node] of entries) {
      if (typeof node.inputs.seed === "number") node.inputs.seed = seed;
      if (inputImage && node.class_type === "LoadImage" && typeof node.inputs.image === "string" && (!imageIds.length || imageIds.includes(nodeId))) {
        node.inputs.image = inputImage;
        imagePatched = true;
      }
      if ((typeof node.inputs.prompt === "string" || typeof node.inputs.text === "string") && promptIds.includes(nodeId)) {
        if (typeof node.inputs.prompt === "string") node.inputs.prompt = positivePrompt;
        if (typeof node.inputs.text === "string") node.inputs.text = positivePrompt;
        promptPatched = true;
      }
      if (node.class_type === "SaveImage") {
        node.inputs.filename_prefix = filenamePrefix;
      }
    }

    if (promptIds.length && !promptPatched) throw new Error("映射的提示词节点没有可注入的 prompt / text 参数");
    if ((imageIds.length || inputImage) && !imagePatched) throw new Error("工作流中没有可注入的 LoadImage 参考图节点");
    this.applyImportedNodeValues(result, workflowParams);
    return result;
  }

  async queue(workflow) {
    const result = await this.request("/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: workflow, client_id: crypto.randomUUID() })
    });

    if (result?.error) throw new Error(result.error.message || JSON.stringify(result));
    if (result?.node_errors && Object.keys(result.node_errors).length) {
      throw new Error(`ComfyUI 节点错误: ${JSON.stringify(result.node_errors)}`);
    }
    if (!result?.prompt_id) throw new Error("ComfyUI 没有返回 prompt_id");
    return result.prompt_id;
  }

  async waitForJob(promptId, onProgress = () => {}) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 30 * 60 * 1000) {
      await new Promise(resolve => setTimeout(resolve, 1200));
      const queue = await this.request("/queue");
      const running = (queue.queue_running || []).some(item => item[1] === promptId);
      if (running) {
        onProgress("执行中");
        continue;
      }

      const history = await this.request(`/history/${promptId}`);
      const job = history?.[promptId];
      if (!job) {
        onProgress("等待执行");
        continue;
      }

      const status = job.status?.status_str;
      if (status === "error") {
        const messages = job.status?.messages || [];
        throw new Error(`ComfyUI 执行失败: ${JSON.stringify(messages).slice(0, 700)}`);
      }

      const outputs = job.outputs || {};
      const images = [];
      for (const [nodeId, nodeOutput] of Object.entries(outputs)) {
        for (const image of nodeOutput.images || []) {
          if (image.type === "temp") continue;
          images.push({
            nodeId,
            ...image,
            url: this.viewUrl(image.filename, image.subfolder, image.type)
          });
        }
      }

      if (!images.length) throw new Error("ComfyUI 已完成，但没有保存图像输出");
      return images;
    }
    throw new Error("等待 ComfyUI 超时（30 分钟）");
  }

  async getJobImages(promptId) {
    const [queue, history] = await Promise.all([
      this.request("/queue"),
      this.request(`/history/${promptId}`)
    ]);
    const active = [...(queue.queue_running || []), ...(queue.queue_pending || [])]
      .some(item => item[1] === promptId);
    if (active) return { active: true, images: [] };

    const job = history?.[promptId];
    if (!job) return { active: false, images: [] };
    if (job.status?.status_str === "error") {
      throw new Error("生成结果所在任务在 ComfyUI 中执行失败");
    }

    const images = [];
    for (const [nodeId, nodeOutput] of Object.entries(job.outputs || {})) {
      for (const image of nodeOutput.images || []) {
        if (image.type === "temp") continue;
        images.push({
          nodeId,
          ...image,
          url: this.viewUrl(image.filename, image.subfolder, image.type)
        });
      }
    }
    return { active: false, images };
  }

  viewUrl(filename, subfolder = "", type = "output") {
    const params = new URLSearchParams({ filename, subfolder, type });
    return `${this.baseUrl}/view?${params}`;
  }
}

export function createSeed() {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  return values[0];
}
