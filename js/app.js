import { WORKFLOW_TEMPLATES, ComfyUIClient, createSeed } from "./comfy.js";
import { DEFAULT_NEGATIVE, blueprintToMarkdown } from "./prompts.js";

const refs = {
  newProjectName: document.getElementById("newProjectName"),
  newProjectMode: document.getElementById("newProjectMode"),
  newActCount: document.getElementById("newActCount"),
  createProjectButton: document.getElementById("createProjectButton"),
  activeProject: document.getElementById("activeProject"),
  activeEpisode: document.getElementById("activeEpisode"),
  episodeDuration: document.getElementById("episodeDuration"),
  actCountInput: document.getElementById("actCountInput"),
  actPlanInput: document.getElementById("actPlanInput"),
  applyActPlanButton: document.getElementById("applyActPlanButton"),
  applyStructureButton: document.getElementById("applyStructureButton"),
  deleteProjectButton: document.getElementById("deleteProjectButton"),
  connectionPill: document.getElementById("connectionPill"),
  connectionText: document.getElementById("connectionText"),
  comfyUrl: document.getElementById("comfyUrl"),
  connectButton: document.getElementById("connectButton"),
  batchButton: document.getElementById("batchButton"),
  batchProjectButton: document.getElementById("batchProjectButton"),
  exportButton: document.getElementById("exportButton"),
  stopButton: document.getElementById("stopButton"),
  projectTitle: document.getElementById("projectTitle"),
  queueText: document.getElementById("queueText"),
  queueBar: document.getElementById("queueBar"),
  productionQueueText: document.getElementById("productionQueueText"),
  processQueueButton: document.getElementById("processQueueButton"),
  clearQueueButton: document.getElementById("clearQueueButton"),
  workspacePanel: document.getElementById("workspacePanel"),
  worksheetView: document.getElementById("worksheetView"),
  queueManagerView: document.getElementById("queueManagerView"),
  queueItems: document.getElementById("queueItems"),
  addCardButton: document.getElementById("addCardButton"),
  queuePageStartButton: document.getElementById("queuePageStartButton"),
  queuePageStopButton: document.getElementById("queuePageStopButton"),
  queuePageClearButton: document.getElementById("queuePageClearButton"),
  emptyState: document.getElementById("emptyState"),
  assetGrid: document.getElementById("assetGrid"),
  materialModule: document.getElementById("materialInputModule"),
  materialPath: document.getElementById("materialPath"),
  materialTextGrid: document.getElementById("materialTextGrid"),
  materialImageGrid: document.getElementById("materialImageGrid"),
  refreshMaterialButton: document.getElementById("refreshMaterialButton"),
  importImageButton: document.getElementById("importImageButton"),
  materialImageInput: document.getElementById("materialImageInput"),
  materialTextModal: document.getElementById("materialTextModal"),
  materialTextTitle: document.getElementById("materialTextTitle"),
  materialSaveState: document.getElementById("materialSaveState"),
  copyMaterialTextButton: document.getElementById("copyMaterialTextButton"),
  saveMaterialTextButton: document.getElementById("saveMaterialTextButton"),
  materialTextEditor: document.getElementById("materialTextEditor"),
  materialImageModal: document.getElementById("materialImageModal"),
  materialImageTitle: document.getElementById("materialImageTitle"),
  materialLargeImage: document.getElementById("materialLargeImage"),
  log: document.getElementById("log"),
  clearLogButton: document.getElementById("clearLogButton"),
  toast: document.getElementById("toast")
};

const state = {
  client: null,
  connected: false,
  blueprint: null,
  projects: [],
  activeProjectId: "",
  activeEpisodeId: "",
  running: false,
  stopRequested: false,
  completed: 0,
  total: 0,
  productionQueue: [],
  queueRunning: false,
  activeWorkspace: "worksheet",
  workflowCatalog: [...WORKFLOW_TEMPLATES],
  workflowNodeInfos: new Map(),
  materialMode: "text",
  materialTexts: [],
  materialImages: [],
  materialRequestId: 0,
  materialDocument: null
};

const referenceFiles = new Map();
const uploadedFiles = new Map();

const projectsStorageKey = "autodesign-projects";
const selectionStorageKey = "autodesign-project-selection";
const productionQueueStorageKey = "autodesign-production-queue";

function createId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function getActiveProject() {
  return state.projects.find(project => project.id === state.activeProjectId) || null;
}

function getActiveEpisode() {
  const project = getActiveProject();
  return project?.episodes.find(episode => episode.id === state.activeEpisodeId)
    || project?.episodes[0]
    || null;
}

function persistProjects() {
  localStorage.setItem(projectsStorageKey, JSON.stringify(state.projects));
  localStorage.setItem(selectionStorageKey, JSON.stringify({
    projectId: state.activeProjectId,
    episodeId: state.activeEpisodeId
  }));
}

function persistProductionQueue() {
  localStorage.setItem(productionQueueStorageKey, JSON.stringify(state.productionQueue));
}

function restoreProductionQueue() {
  try {
    const raw = localStorage.getItem(productionQueueStorageKey);
    const savedJobs = raw ? JSON.parse(raw) : [];
    state.productionQueue = Array.isArray(savedJobs)
      ? savedJobs.filter(job => job?.key && findQueueLocation(job).shot)
      : [];
  } catch {
    state.productionQueue = [];
  }

  const savedKeys = new Set(state.productionQueue.map(job => job.key));
  state.projects.forEach(project => project.episodes.forEach(episode => episode.shots.forEach(shot => {
    if (!["queued", "running"].includes(shot.queueState)) return;
    const key = shotQueueKey(project.id, episode.id, shot.id);
    if (!savedKeys.has(key)) {
      state.productionQueue.push({ key, projectId: project.id, episodeId: episode.id, shotId: shot.id });
      savedKeys.add(key);
    }
    if (shot.queueState === "running") shot.queueState = "queued";
  })));
  sortProductionQueue();
  persistProductionQueue();
}

function normalizeActDuration(value) {
  return Math.min(600, Math.max(1, Math.round(Number(value) || 8)));
}

function chineseActNumber(value) {
  const digits = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
  if (value === 100) return "一百";
  if (value < 10) return digits[value];
  const tens = Math.floor(value / 10);
  const ones = value % 10;
  return `${tens > 1 ? digits[tens] : ""}十${ones ? digits[ones] : ""}`;
}

function episodeTitle(episode) {
  return String(episode?.name || "")
    .replace(/^第[^幕\s·:：]+幕\s*[·:：]?\s*/u, "")
    .replace(/^第\s*\d+\s*幕\s*[·:：]?\s*/u, "")
    .trim() || "未命名幕";
}

function formatEpisodeName(index, title = "") {
  const cleanTitle = String(title || "").trim() || "未命名幕";
  return `${chineseActNumber(index + 1)}幕 · ${cleanTitle}`;
}

function episodeOptionLabel(episode, index) {
  const status = episode.shots.length ? `${episode.shots.length} 张` : "待生成规格";
  return `${formatEpisodeName(index, episodeTitle(episode))} · ${normalizeActDuration(episode.duration)}s · ${status}`;
}

function gcd(a, b) {
  return b ? gcd(b, a % b) : a;
}

function formatAspect(width, height) {
  const divisor = gcd(Math.max(1, Math.round(width)), Math.max(1, Math.round(height)));
  return `${Math.max(1, Math.round(width / divisor))}:${Math.max(1, Math.round(height / divisor))}`;
}

function normalizeShotWorkflowParams(params, shot) {
  const width = Math.max(256, Number(shot?.width) || 1024);
  const height = Math.max(256, Number(shot?.height) || 1280);
  const source = params && typeof params === "object" ? params : {};
  const nodeIds = Array.isArray(source.nodeIds)
    ? [...new Set(source.nodeIds.map(id => String(id).trim()).filter(Boolean))]
    : [];
  const nodeValues = source.nodeValues && typeof source.nodeValues === "object" ? source.nodeValues : {};
  return {
    aspectRatio: String(source.aspectRatio || formatAspect(width, height)),
    targetPixels: Number(source.targetPixels) || Number(((width * height) / 1000000).toFixed(2)),
    resolutionSteps: Math.min(16, Math.max(1, Number(source.resolutionSteps) || Math.max(1, Math.round((Number(source.targetPixels) || ((width * height) / 1000000)) / 0.25)))),
    denoise: Math.min(1, Math.max(0, Number(source.denoise ?? shot?.denoise ?? 0.58))),
    nodeIds,
    nodeValues
  };
}

function normalizeShot(shot, index) {
  const width = Math.min(4096, Math.max(256, Number(shot?.width) || 1024));
  const height = Math.min(4096, Math.max(256, Number(shot?.height) || 1280));
  return {
    ...shot,
    sequence: Math.max(1, Number(shot?.sequence) || index + 1),
    workflow: state.workflowCatalog.some(template => template.id === shot?.workflow)
      ? shot.workflow
      : (state.workflowCatalog[0]?.id || "k2_anything2real_v3"),
    width,
    height,
    workflowParams: normalizeShotWorkflowParams(shot?.workflowParams, { width, height })
  };
}

function parseAspect(value, fallbackWidth, fallbackHeight) {
  const text = String(value || "").trim().toLowerCase();
  const pair = text.match(/^(\d+(?:\.\d+)?)\s*[:/x×]\s*(\d+(?:\.\d+)?)$/i);
  if (pair) {
    const ratioWidth = Number(pair[1]);
    const ratioHeight = Number(pair[2]);
    if (ratioWidth > 0 && ratioHeight > 0) return { width: ratioWidth, height: ratioHeight };
  }
  const single = Number(text);
  if (Number.isFinite(single) && single > 0) return { width: single, height: 1 };
  return { width: fallbackWidth, height: fallbackHeight };
}

function roundImageSize(value) {
  return Math.min(4096, Math.max(256, Math.round(value / 8) * 8));
}

function applyAspectAndPixels(shot) {
  const params = shot.workflowParams || {};
  const ratio = parseAspect(params.aspectRatio, shot.width, shot.height);
  const targetPixels = Math.min(16, Math.max(0.1, Number(params.targetPixels) || 1.5));
  const scale = Math.sqrt((targetPixels * 1000000) / (ratio.width * ratio.height));
  shot.width = roundImageSize(ratio.width * scale);
  shot.height = roundImageSize(ratio.height * scale);
  shot.workflowParams.resolutionSteps = Math.max(1, Math.round(targetPixels / 0.25));
}

function parseActPlan(text) {
  const acts = [];
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^[\s|:-]+$/.test(line)) continue;

    const cells = (line.includes("|")
      ? line.split("|")
      : line.split(/\t|，|,/)
    ).map(cell => cell.trim()).filter(Boolean);
    if (!cells.length) continue;

    if (cells[0] === "段" && cells.some(cell => cell === "内容")) continue;
    if (cells[0] && /^\d+$/.test(cells[0]) && cells.length > 1) cells.shift();

    const durationIndex = cells.findLastIndex(cell => /^\d+(?:\.\d+)?\s*(?:s|秒)?$/i.test(cell));
    let duration = 8;
    let nameParts = cells;
    if (durationIndex >= 0) {
      duration = normalizeActDuration(cells[durationIndex]);
      nameParts = cells.filter((_, index) => index !== durationIndex);
    }

    const name = nameParts.join(" ")
      .replace(/^第[^幕\s·:：]+幕\s*[·:：]?\s*/u, "")
      .replace(/^第\s*\d+\s*幕\s*[·:：]?\s*/u, "")
      .trim();
    if (!name || ["内容", "时长"].includes(name)) continue;
    acts.push({ name, duration });
  }
  return acts;
}

function buildPlannedEpisodes(project, plannedActs, targetCount, previousEpisodes = []) {
  return Array.from({ length: targetCount }, (_, index) => {
    const previous = previousEpisodes[index];
    const planned = plannedActs[index];
    return {
      id: previous?.id || createId("episode"),
      name: formatEpisodeName(index, planned?.name || episodeTitle(previous)),
      duration: normalizeActDuration(planned?.duration || previous?.duration || 8),
      brief: previous?.brief || project.brief,
      shots: Array.isArray(previous?.shots) ? previous.shots : [],
      specSource: previous?.specSource || ""
    };
  });
}

function normalizeProject(project) {
  if (!project || typeof project !== "object") return null;
  return {
    id: String(project.id || createId("project")),
    name: String(project.name || "未命名项目"),
    dataFolder: safeName(project.name || "未命名项目"),
    mode: project.mode === "mv" ? "mv" : "drama",
    brief: String(project.brief || ""),
    styleHint: String(project.styleHint || "cinematic, detailed illustration, clean composition"),
    width: Number(project.width) || 1024,
    height: Number(project.height) || 1280,
    steps: Number(project.steps) || 28,
    cfg: Number(project.cfg) || 6.5,
    denoise: Number(project.denoise) || 0.58,
    aiEndpoint: String(project.aiEndpoint || ""),
    aiModel: String(project.aiModel || ""),
    episodes: Array.isArray(project.episodes) ? project.episodes.map((episode, index) => ({
      id: String(episode.id || createId("episode")),
      name: String(episode.name || `第 ${String(index + 1).padStart(2, "0")} 幕`),
      brief: String(episode.brief || project.brief || ""),
      duration: normalizeActDuration(episode.duration),
      shots: Array.isArray(episode.shots) ? episode.shots.map(normalizeShot) : [],
      specSource: String(episode.specSource || "")
    })) : []
  };
}

function loadProjects() {
  try {
    const raw = localStorage.getItem(projectsStorageKey);
    state.projects = raw ? JSON.parse(raw).map(normalizeProject).filter(Boolean) : [];
    const selection = JSON.parse(localStorage.getItem(selectionStorageKey) || "{}");
    state.activeProjectId = selection.projectId || state.projects[0]?.id || "";
    const project = getActiveProject();
    state.activeEpisodeId = selection.episodeId || project?.episodes[0]?.id || "";
    if (project) loadProjectToControls();
    renderActiveEpisodeWorksheet();
  } catch (error) {
    state.projects = [];
    log(`读取项目失败：${error.message}`, "error");
  }
}

function buildEpisodeBlueprint(project, episode) {
  return {
    title: `${project.name} · ${episode.name}`,
    project_mode: project.mode,
    style: project.styleHint,
    summary: project.brief,
    characters: "保持角色形象一致。",
    negative_prompt: DEFAULT_NEGATIVE,
    shots: episode.shots,
    source: episode.specSource || "manual"
  };
}

function loadProjectToControls() {
  const project = getActiveProject();
  if (!project) return;
  const episode = getActiveEpisode();
  refs.episodeDuration.value = normalizeActDuration(episode?.duration || 8);
  renderProjectControls();
}

function workflowOptions(selected) {
  return state.workflowCatalog.map(template =>
    `<option value="${template.id}" ${template.id === selected ? "selected" : ""}>${template.name}</option>`
  ).join("");
}

async function loadWorkflowCatalog() {
  try {
    const response = await fetch("/api/workflows");
    if (!response.ok) throw new Error(`工作流目录加载失败 ${response.status}`);
    const savedWorkflows = await response.json();
    if (!Array.isArray(savedWorkflows)) throw new Error("工作流目录格式无效");
    const savedIds = new Set(savedWorkflows.map(item => item.id).filter(Boolean));
    state.workflowCatalog = [
      ...WORKFLOW_TEMPLATES.filter(template => !savedIds.has(template.id)),
      ...savedWorkflows.filter(item => item.id && item.file)
    ];
  } catch (error) {
    state.workflowCatalog = [...WORKFLOW_TEMPLATES];
    log(`读取工作流目录失败：${error.message}`, "error");
  }
  state.client?.registerWorkflowTemplates(state.workflowCatalog);
}

function nodeInputLabel(name) {
  return ({
    image: "素材图",
    prompt: "提示词 / 图生图指令",
    text: "提示词",
    upscale_method: "上采样方法",
    megapixels: "目标像素（MP）",
    resolution_steps: "分辨率档位",
    steps: "步数",
    cfg: "CFG",
    sampler_name: "采样器",
    scheduler: "调度器",
    denoise: "重绘幅度"
  })[name] || name;
}

function isWorkflowLink(value) {
  return Array.isArray(value) || (value && typeof value === "object");
}

function mappedWorkflowNodes(shot) {
  const workflowInfo = state.workflowNodeInfos.get(shot.workflow);
  if (!workflowInfo) return [];
  return (shot.workflowParams?.nodeIds || []).map(id => ({
    id,
    node: workflowInfo.workflow[id],
    values: shot.workflowParams?.nodeValues?.[id] || {}
  })).filter(item => item.node);
}

function workflowParamsHtml(shot, index, workflowInfo) {
  const nodeIds = shot.workflowParams?.nodeIds || [];
  const options = Object.entries(workflowInfo.workflow).map(([id, node]) =>
    `<option value="${escapeHtml(id)}">${escapeHtml(`${id} · ${node.class_type}`)}</option>`
  ).join("");
  const mappedHtml = mappedWorkflowNodes(shot).map(({ id, node, values }) => {
    const parameterFields = Object.entries(node.inputs || {}).filter(([name, value]) => {
      if (isWorkflowLink(value)) return false;
      if (name === "seed" || name === "filename_prefix") return false;
      if (node.class_type === "LoadImage" && name === "image") return false;
      return true;
    }).map(([name, value]) => {
      const label = nodeInputLabel(name);
      const currentValue = values[name] ?? value;
      if (name === "prompt" || name === "text") {
        return `
          <label class="field">
            <span>${escapeHtml(label)}</span>
            <textarea data-field="nodeValue:${escapeHtml(id)}:${escapeHtml(name)}" data-index="${index}">${escapeHtml(currentValue)}</textarea>
          </label>
        `;
      }
      const inputType = typeof value === "number" ? "number" : "text";
      const step = name === "megapixels" || name === "cfg" || name === "denoise" ? "0.01" : "1";
      return `
        <label class="field">
          <span>${escapeHtml(label)}</span>
          <input data-field="nodeValue:${escapeHtml(id)}:${escapeHtml(name)}" data-index="${index}" type="${inputType}" step="${step}" value="${escapeHtml(currentValue)}">
        </label>
      `;
    }).join("");

    const imageHint = node.class_type === "LoadImage"
      ? `<p class="node-hint">素材图：${escapeHtml(shot.sourceImageName || referenceFiles.get(assetKey(index))?.name || "未选择；图生图执行时自动上传并连接")}</p>`
      : "";
    return `
      <article class="node-mapping">
        <header>
          <strong>节点 ${escapeHtml(id)}</strong>
          <span>${escapeHtml(node.class_type)}</span>
          <button class="button ghost small" data-action="remove-node-param" data-index="${index}" data-node-id="${escapeHtml(id)}">移除</button>
        </header>
        ${imageHint}
        ${parameterFields || `<p class="node-hint">该节点没有可编辑的基础参数。</p>`}
      </article>
    `;
  }).join("");

  return `
    <label class="field">
      <span>按需调节节点编号</span>
      <input data-node-id-input data-index="${index}" list="workflow-node-options-${index}" placeholder="例如：349、351、345">
    </label>
    <datalist id="workflow-node-options-${index}">${options}</datalist>
    <button class="button secondary full" data-action="add-node-param" data-index="${index}">映射节点参数</button>
    ${nodeIds.length ? mappedHtml : `<p class="node-hint">未添加节点参数，执行时使用工作流默认值。</p>`}
  `;
}

function renderWorkflowParams(index) {
  const shot = state.blueprint?.shots[index];
  const workflowInfo = shot && state.workflowNodeInfos.get(shot.workflow);
  const container = cardByIndex(index)?.querySelector("[data-param-container]");
  if (!shot || !workflowInfo || !container) return;
  container.innerHTML = workflowParamsHtml(shot, index, workflowInfo);
}

function renderProjectControls() {
  refs.activeProject.innerHTML = state.projects.map(project =>
    `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)}</option>`
  ).join("") || "<option>暂无项目</option>";
  refs.activeProject.value = state.activeProjectId;

  const project = getActiveProject();
  refs.activeEpisode.innerHTML = project?.episodes.map((episode, index) =>
    `<option value="${escapeHtml(episode.id)}">${escapeHtml(episodeOptionLabel(episode, index))}</option>`
  ).join("") || "<option>暂无幕</option>";
  refs.activeEpisode.value = state.activeEpisodeId;
  refs.actCountInput.value = project?.episodes.length || 1;
}

function materialProject() {
  return getActiveProject();
}

function materialUrl(path, parameters = {}) {
  const query = new URLSearchParams({ project: materialProject()?.dataFolder || "", ...parameters });
  return `${path}?${query.toString()}`;
}

function clearMaterialInputs(message) {
  refs.materialPath.textContent = message || "项目本地素材文件";
  refs.materialTextGrid.innerHTML = `<div class="material-empty">暂无 Markdown 文本</div>`;
  refs.materialImageGrid.innerHTML = `<div class="material-empty">暂无图生图原图</div>`;
}

function renderMaterialInputs() {
  const project = materialProject();
  if (!project) return;
  refs.materialTextGrid.innerHTML = state.materialTexts.length ? state.materialTexts.map(item => `
    <article class="material-text-card" data-material-text="${escapeHtml(item.file)}" title="${escapeHtml(item.title)}" draggable="true">
      <span class="material-text-title">${escapeHtml(item.title)}</span>
      <small>双击打开 · ${new Date(item.updatedAt).toLocaleString("zh-CN")}</small>
    </article>
  `).join("") : `<div class="material-empty">暂无 Markdown 文本</div>`;

  refs.materialImageGrid.innerHTML = state.materialImages.length ? state.materialImages.map(item => `
    <figure class="material-image-card" data-material-image="${escapeHtml(item.file)}" draggable="true">
      <img src="${escapeHtml(item.url)}" alt="${escapeHtml(item.file)}" loading="lazy">
      <figcaption title="${escapeHtml(item.file)}">${escapeHtml(item.file)}</figcaption>
      <button class="button ghost small material-image-delete" data-material-delete="${escapeHtml(item.file)}">删除</button>
    </figure>
  `).join("") : `<div class="material-empty">暂无图生图原图</div>`;
}

async function refreshMaterialInputs() {
  const project = materialProject();
  const requestId = ++state.materialRequestId;
  if (!project) {
    state.materialTexts = [];
    state.materialImages = [];
    clearMaterialInputs("请先选择项目");
    return;
  }

  refs.materialPath.textContent = `project-data/${project.dataFolder}/text · project-data/${project.dataFolder}/images`;
  try {
    const [textResponse, imageResponse] = await Promise.all([
      fetch(materialUrl("/api/materials/text")),
      fetch(materialUrl("/api/materials/images"))
    ]);
    const textData = await textResponse.json();
    const imageData = await imageResponse.json();
    if (!textResponse.ok) throw new Error(textData.error || `读取文本失败 ${textResponse.status}`);
    if (!imageResponse.ok) throw new Error(imageData.error || `读取图片失败 ${imageResponse.status}`);
    if (requestId !== state.materialRequestId) return;
    state.materialTexts = textData.files || [];
    state.materialImages = imageData.files || [];
    renderMaterialInputs();
  } catch (error) {
    if (requestId === state.materialRequestId) {
      state.materialTexts = [];
      state.materialImages = [];
      clearMaterialInputs(`素材读取失败：${error.message}`);
      log(`读取素材输入区失败：${error.message}`, "error");
    }
  }
}

function setMaterialMode(mode) {
  state.materialMode = mode === "image" ? "image" : "text";
  document.querySelectorAll("[data-material-mode]").forEach(button => {
    button.classList.toggle("active", button.dataset.materialMode === state.materialMode);
  });
  refs.materialTextGrid.hidden = state.materialMode !== "text";
  refs.materialImageGrid.hidden = state.materialMode !== "image";
  refs.importImageButton.hidden = state.materialMode !== "image";
}

async function openMaterialText(fileName) {
  try {
    const response = await fetch(materialUrl("/api/materials/text/content", { file: fileName }));
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `打开文本失败 ${response.status}`);
    const known = state.materialTexts.find(item => item.file === fileName);
    state.materialDocument = { file: fileName, content: result.content || "", dirty: false };
    refs.materialTextTitle.textContent = known?.title || fileName.replace(/\.md$/i, "");
    refs.materialTextEditor.value = state.materialDocument.content;
    refs.materialSaveState.textContent = "";
    refs.saveMaterialTextButton.disabled = true;
    refs.materialTextModal.hidden = false;
  } catch (error) {
    toast(error.message, "error");
    log(`打开素材文本失败：${error.message}`, "error");
  }
}

async function copyMaterialText() {
  if (!state.materialDocument) return;
  try {
    await navigator.clipboard.writeText(refs.materialTextEditor.value);
    refs.materialSaveState.textContent = "已复制";
    toast("文本已复制");
  } catch (error) {
    toast(`复制失败：${error.message}`, "error");
  }
}

async function saveMaterialText() {
  const documentState = state.materialDocument;
  const project = materialProject();
  if (!project || !documentState) return;
  refs.saveMaterialTextButton.disabled = true;
  refs.materialSaveState.textContent = "保存中…";
  try {
    const response = await fetch("/api/materials/text/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: project.dataFolder,
        file: documentState.file,
        content: refs.materialTextEditor.value
      })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `保存失败 ${response.status}`);
    documentState.content = refs.materialTextEditor.value;
    documentState.dirty = false;
    refs.materialSaveState.textContent = `已保存 ${new Date().toLocaleTimeString("zh-CN")}`;
    toast("素材文本已保存");
    await refreshMaterialInputs();
  } catch (error) {
    refs.materialSaveState.textContent = error.message;
    toast(error.message, "error");
  } finally {
    refs.saveMaterialTextButton.disabled = !state.materialDocument?.dirty;
  }
}

function openMaterialImage(fileName) {
  const item = state.materialImages.find(image => image.file === fileName);
  if (!item) return;
  refs.materialImageTitle.textContent = item.file;
  refs.materialLargeImage.src = item.url;
  refs.materialImageModal.hidden = false;
}

async function uploadMaterialImages(files) {
  const project = materialProject();
  if (!project || !files?.length) return;
  refs.importImageButton.disabled = true;
  try {
    for (const file of Array.from(files)) {
      const response = await fetch(materialUrl("/api/materials/images/upload"), {
        method: "POST",
        headers: { "X-File-Name": encodeURIComponent(file.name) },
        body: file
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `导入 ${file.name} 失败`);
      log(`原图已导入：${result.file}`);
    }
    await refreshMaterialInputs();
    toast("原图导入完成");
  } catch (error) {
    toast(error.message, "error");
    log(`原图导入失败：${error.message}`, "error");
  } finally {
    refs.importImageButton.disabled = false;
  }
}

async function deleteMaterialImage(fileName) {
  const project = materialProject();
  if (!project || !confirm(`确定删除原图 ${fileName} 吗？`)) return;
  try {
    const response = await fetch("/api/materials/images/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: project.dataFolder, file: fileName })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "删除失败");
    await refreshMaterialInputs();
    toast("原图已删除");
  } catch (error) {
    toast(error.message, "error");
  }
}

function setMaterialDragData(event, material) {
  event.dataTransfer.setData("text/plain", JSON.stringify(material));
  event.dataTransfer.effectAllowed = "copy";
}

function assetCardIndex(card) {
  return Number(card?.querySelector("[data-index]")?.dataset.index);
}

async function applyTextMaterialToCard(index, material) {
  const shot = state.blueprint?.shots[index];
  if (!shot) return;
  const response = await fetch(materialUrl("/api/materials/text/content", { file: material.file }));
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "读取拖拽文本失败");
  shot.positive_prompt = String(result.content || "");
  syncPromptNodeValues(shot);
  renderBlueprint();
  persistProjects();
  toast(`提示词已导入到素材 ${shot.sequence || index + 1}`);
}

async function applyImageMaterialToCard(index, material) {
  const shot = state.blueprint?.shots[index];
  if (!shot) return;
  const response = await fetch(material.url || materialUrl("/api/materials/image", { file: material.file }));
  if (!response.ok) throw new Error(`读取拖拽图片失败 ${response.status}`);
  const blob = await response.blob();
  const file = new File([blob], material.file || "reference.png", { type: blob.type || "image/png" });
  shot.usecase = "image_to_image";
  shot.sourceImageName = file.name;
  referenceFiles.set(assetKey(index), file);
  renderBlueprint();
  persistProjects();
  await connectReferenceToWorkflow(index);
  toast(`原图已导入到素材 ${shot.sequence || index + 1}`);
}

async function dropMaterialOnCard(event, card) {
  const payload = event.dataTransfer.getData("text/plain");
  const material = payload ? JSON.parse(payload) : null;
  if (!material?.type) return;
  const index = assetCardIndex(card);
  if (!Number.isInteger(index)) return;
  if (material.type === "text") {
    await applyTextMaterialToCard(index, material);
  } else if (material.type === "image") {
    await applyImageMaterialToCard(index, material);
  }
}

function createProject() {
  const name = refs.newProjectName.value.trim();
  if (!name) {
    toast("请输入项目名称", "error");
    return;
  }

  const project = normalizeProject({
    id: createId("project"),
    name,
    mode: refs.newProjectMode.value,
    episodes: []
  });

  const plannedActs = parseActPlan(refs.actPlanInput.value);
  const episodeCount = plannedActs.length || Math.min(100, Math.max(1, Number(refs.newActCount.value) || 1));
  project.episodes = Array.from({ length: episodeCount }, (_, index) => ({
    id: createId("episode"),
    name: formatEpisodeName(index, plannedActs[index]?.name),
    duration: normalizeActDuration(plannedActs[index]?.duration || 8),
    brief: project.brief,
    shots: [],
    specSource: ""
  }));

  state.projects.unshift(project);
  state.activeProjectId = project.id;
  state.activeEpisodeId = project.episodes[0].id;
  loadProjectToControls();
  persistProjects();
  const totalDuration = project.episodes.reduce((sum, episode) => sum + episode.duration, 0);
  log(`项目「${project.name}」已创建，包含 ${project.episodes.length} 幕，总计 ${totalDuration} 秒。`, "success");
  toast(`项目「${project.name}」已创建`);
}

function log(message, level = "info") {
  const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  const prefix = level === "error" ? "ERROR" : level === "success" ? "DONE" : "INFO";
  refs.log.textContent += `[${time}] ${prefix} ${message}\n`;
  refs.log.scrollTop = refs.log.scrollHeight;
}

let toastTimer;
function toast(message, type = "info") {
  refs.toast.textContent = message;
  refs.toast.classList.add("show");
  refs.toast.classList.toggle("error", type === "error");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => refs.toast.classList.remove("show"), 4200);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function connectionState(online, text) {
  refs.connectionText.textContent = text;
  refs.connectionPill.querySelector(".status-dot").classList.toggle("online", online);
  refs.connectionPill.querySelector(".status-dot").classList.toggle("offline", !online);
}

function saveSettings() {
  const episode = getActiveEpisode();
  if (episode) {
    episode.duration = normalizeActDuration(refs.episodeDuration.value);
  }
  if (episode) persistProjects();
  const settings = { comfyUrl: refs.comfyUrl.value };
  localStorage.setItem("autodesign-settings", JSON.stringify(settings));
}

function loadSettings() {
  try {
    const raw = localStorage.getItem("autodesign-settings");
    if (!raw) return;
    const settings = JSON.parse(raw);
    for (const [key, value] of Object.entries(settings)) {
      if (key === "comfyUrl" && /^https?:\/\/(127\.0\.0\.1|localhost):8188/i.test(value)) {
        refs.comfyUrl.value = "/comfy";
        continue;
      }
      if (refs[key] && value) refs[key].value = value;
    }
  } catch (error) {
    log(`读取本地设置失败：${error.message}`, "error");
  }
}

async function connectComfy() {
  refs.connectButton.disabled = true;
  connectionState(false, "连接中");
  try {
    saveSettings();
    state.client = new ComfyUIClient(refs.comfyUrl.value);
    state.client.registerWorkflowTemplates(state.workflowCatalog);
    await state.client.connect();
    state.connected = true;
    connectionState(true, "已连接");
    log(`ComfyUI 已连接；基础工作流已自动选择默认采样配置。`, "success");
    toast("ComfyUI 连接成功");
    saveSettings();
  } catch (error) {
    state.connected = false;
    connectionState(false, "未连接");
    log(error.message, "error");
    toast(error.message, "error");
  } finally {
    refs.connectButton.disabled = false;
  }
}

function applyStructure() {
  const project = getActiveProject();
  if (!project) {
    toast("请先创建或选择项目", "error");
    return;
  }

  const targetActCount = Math.min(100, Math.max(1, Number(refs.actCountInput.value) || 1));
  while (project.episodes.length < targetActCount) {
    project.episodes.push({
      id: createId("episode"),
      name: formatEpisodeName(project.episodes.length),
      duration: 8,
      brief: project.brief,
      shots: [],
      specSource: ""
    });
  }
  while (project.episodes.length > targetActCount) {
    project.episodes.pop();
  }

  const episode = getActiveEpisode();
  state.activeEpisodeId = episode?.id || project.episodes[0]?.id || "";
  loadProjectToControls();
  if (episode?.shots.length) {
    state.blueprint = buildEpisodeBlueprint(project, episode);
    renderBlueprint();
    updateProgress();
  } else {
    state.blueprint = null;
    refs.assetGrid.innerHTML = "";
    refs.emptyState.hidden = false;
  }
  persistProjects();
  log(`「${project.name}」结构已同步：${project.episodes.length} 幕。`, "success");
}

function applyActPlan() {
  const project = getActiveProject();
  if (!project) {
    toast("请先创建或选择项目", "error");
    return;
  }

  const plannedActs = parseActPlan(refs.actPlanInput.value);
  if (!plannedActs.length) {
    toast("幕表为空", "error");
    return;
  }

  const activeEpisodeId = state.activeEpisodeId;
  refs.actCountInput.value = plannedActs.length;
  project.episodes = buildPlannedEpisodes(project, plannedActs, plannedActs.length, project.episodes);
  const activeEpisode = project.episodes.find(episode => episode.id === activeEpisodeId) || project.episodes[0];
  state.activeEpisodeId = activeEpisode.id;
  loadProjectToControls();
  renderActiveEpisodeWorksheet();
  persistProjects();

  const totalDuration = project.episodes.reduce((sum, episode) => sum + episode.duration, 0);
  log(`幕表已同步：${project.episodes.map(episode => `${episode.name} ${episode.duration}s`).join("；")}。总计 ${totalDuration} 秒。`, "success");
  toast(`已同步 ${project.episodes.length} 幕，总计 ${totalDuration} 秒`);
}

function createBlankWorksheetShot(project, episode) {
  const sequence = episode.shots.reduce((max, shot) => Math.max(max, Number(shot.sequence) || 0), 0) + 1;
  const promptParts = [episode.brief, project.styleHint].filter(Boolean);
  return normalizeShot({
    id: createId("asset"),
    title: `${episode.name} · 素材 ${String(sequence).padStart(2, "0")}`,
    sequence,
    usecase: "text_to_image",
    shot_size: "cinematic shot",
    camera: "balanced cinematic framing",
    action: episode.brief || "保持主体清晰，构图稳定",
    positive_prompt: `${promptParts.join(", ")}, cinematic lighting, detailed background, high detail, clean composition`,
    negative_prompt: DEFAULT_NEGATIVE,
    width: project.width,
    height: project.height,
    steps: project.steps,
    cfg: project.cfg,
    denoise: project.denoise,
    workflow: "k2_anything2real_v3",
    workflowParams: {
      nodeIds: [],
      nodeValues: {}
    }
  }, episode.shots.length);
}

function addImageCard() {
  const project = getActiveProject();
  const episode = getActiveEpisode();
  if (!project || !episode) {
    toast("请先创建或选择项目", "error");
    return;
  }
  episode.shots.push(createBlankWorksheetShot(project, episode));
  if (!episode.specSource) episode.specSource = "manual";
  state.blueprint = buildEpisodeBlueprint(project, episode);
  state.activeWorkspace = "worksheet";
  renderWorkspace();
  renderBlueprint();
  updateProgress();
  persistProjects();
  toast("已添加图片生成卡片");
}

function deleteImageCard(index) {
  const project = getActiveProject();
  const episode = getActiveEpisode();
  const shot = state.blueprint?.shots[index];
  if (!project || !episode || !shot) return;
  if (shot.queueState === "running") {
    toast("当前素材正在生产，不能删除", "error");
    return;
  }
  if (!confirm(`确定删除序号 ${shot.sequence || index + 1} 的图片生成卡片吗？`)) return;

  const jobKey = shotQueueKey(project.id, episode.id, shot.id);
  state.productionQueue = state.productionQueue.filter(job => {
    if (job.key !== jobKey) return true;
    return job.projectId !== project.id || job.episodeId !== episode.id || job.shotId !== shot.id;
  });
  episode.shots = episode.shots.filter(item => item.id !== shot.id);
  if (episode.shots.length) {
    state.blueprint = buildEpisodeBlueprint(project, episode);
    renderBlueprint();
    updateProgress();
  } else {
    state.blueprint = null;
    renderActiveEpisodeWorksheet();
  }
  renderProductionQueue();
  persistProjects();
  toast("图片生成卡片已删除");
}

async function addNodeParam(index) {
  const shot = state.blueprint?.shots[index];
  const input = cardByIndex(index)?.querySelector("[data-node-id-input]");
  const nodeId = String(input?.value || "").trim();
  if (!shot || !nodeId) {
    toast("请输入节点编号", "error");
    return;
  }
  if (!state.client) state.client = new ComfyUIClient(refs.comfyUrl.value);
  const template = await state.client.loadWorkflowTemplate(shot.workflow);
  const node = template.workflow[nodeId];
  if (!node) {
    toast(`工作流中没有节点 ${nodeId}`, "error");
    return;
  }
  shot.workflowParams = shot.workflowParams || {};
  shot.workflowParams.nodeIds = shot.workflowParams.nodeIds || [];
  if (shot.workflowParams.nodeIds.includes(nodeId)) {
    toast("该节点已映射", "error");
    return;
  }
  shot.workflowParams.nodeIds.push(nodeId);
  shot.workflowParams.nodeValues = shot.workflowParams.nodeValues || {};
  const promptName = "prompt" in node.inputs ? "prompt" : "text" in node.inputs ? "text" : "";
  if (promptName && !shot.positive_prompt) shot.positive_prompt = String(node.inputs[promptName] || "");
  if (promptName) shot.workflowParams.nodeValues[nodeId] = { [promptName]: shot.positive_prompt };
  renderBlueprint();
  refreshWorkflowNodeMapping(index);
  persistProjects();
  toast(`已映射节点 ${nodeId} 的参数`);
}

function removeNodeParam(index, nodeId) {
  const shot = state.blueprint?.shots[index];
  if (!shot) return;
  shot.workflowParams.nodeIds = (shot.workflowParams.nodeIds || []).filter(id => id !== nodeId);
  delete shot.workflowParams.nodeValues?.[nodeId];
  renderBlueprint();
  refreshWorkflowNodeMapping(index);
  persistProjects();
  toast(`已移除节点 ${nodeId} 参数`);
}

function renderActiveEpisodeWorksheet(options = {}) {
  const project = getActiveProject();
  const episode = getActiveEpisode();
  if (!project || !episode) {
    refs.projectTitle.textContent = "尚未选择幕";
    refs.assetGrid.innerHTML = "";
    refs.emptyState.hidden = false;
    return;
  }

  if (episode.shots.length) {
    state.blueprint = buildEpisodeBlueprint(project, episode);
    renderBlueprint();
    updateProgress();
  } else {
    state.blueprint = null;
    refs.emptyState.hidden = true;
    state.completed = 0;
    state.total = 0;
    updateProgress();
    refs.projectTitle.textContent = `${project.name} · ${episode.name} · ${episode.duration}s`;
    refs.assetGrid.innerHTML = `
      <article class="episode-empty">
        <div>
          <h3>${escapeHtml(episode.name)}</h3>
          <p>时长：${episode.duration} 秒 · 当前幕还没有素材规格。</p>
          <p>本幕简报：${escapeHtml(episode.brief || project.brief || "未填写")}</p>
        </div>
        <button class="button primary" data-action="create-worksheet">新建本幕空白素材工作表</button>
      </article>
    `;
  }

  if (options.scroll) {
    refs.workspacePanel.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  if (options.notify) {
    toast(`已切换：${episode.name}`);
  }
}

function deleteActiveProject() {
  const project = getActiveProject();
  if (!project) return;
  if (!confirm(`确定删除项目「${project.name}」及其全部幕与本地规格吗？`)) return;
  state.projects = state.projects.filter(item => item.id !== project.id);
  state.activeProjectId = state.projects[0]?.id || "";
  state.activeEpisodeId = getActiveProject()?.episodes[0]?.id || "";
  state.blueprint = null;
  refs.assetGrid.innerHTML = "";
  refs.emptyState.hidden = true;
  if (getActiveProject()) loadProjectToControls();
  if (getActiveEpisode()?.shots.length) {
    state.blueprint = buildEpisodeBlueprint(getActiveProject(), getActiveEpisode());
    renderBlueprint();
  }
  renderProjectControls();
  persistProjects();
  log(`项目「${project.name}」已删除。`);
}

function renderBlueprint() {
  const blueprint = state.blueprint;
  if (!blueprint) return;

  refs.emptyState.hidden = true;
  refs.projectTitle.textContent = `${blueprint.title} · ${blueprint.shots.length} 张`;
  state.total = blueprint.shots.length;
  state.completed = blueprint.shots.filter(shot => shot.queueState === "done").length;
  refs.assetGrid.innerHTML = blueprint.shots.map((shot, index) => {
    const sequence = shot.sequence || index + 1;
    const needsReference = shot.usecase === "image_to_image";
    return `
      <article class="asset-card" data-card-id="${escapeHtml(shot.id)}" data-material-drop-target>
        <div class="asset-head">
          <h3>${escapeHtml(sequence)} · ${escapeHtml(shot.title)}</h3>
          <button class="button ghost small" data-action="delete-card" data-index="${index}" ${shot.queueState === "running" ? "disabled" : ""}>删除</button>
        </div>
        <div class="asset-meta">
          <span>${shot.width}×${shot.height}</span>
          <span>${escapeHtml(shot.queueState || "未加入队列")}</span>
        </div>
        <div class="asset-body">
          <div class="field-row">
            <label class="field">
              <span>序号</span>
              <input data-field="sequence" data-index="${index}" type="number" min="1" value="${escapeHtml(sequence)}">
            </label>
            <label class="field">
              <span>生图类型</span>
              <select data-field="usecase" data-index="${index}">
                <option value="text_to_image" ${shot.usecase === "text_to_image" ? "selected" : ""}>文生图</option>
                <option value="image_to_image" ${shot.usecase === "image_to_image" ? "selected" : ""}>图生图</option>
              </select>
            </label>
          </div>
          <label class="field">
            <span>调用工作流</span>
            <select data-field="workflow" data-index="${index}">${workflowOptions(shot.workflow || "k2_anything2real_v3")}</select>
          </label>
          ${needsReference ? "" : `
          <label class="field">
            <span>生图提示词</span>
            <textarea data-field="positive_prompt" data-index="${index}" rows="4" spellcheck="false">${escapeHtml(shot.positive_prompt || "")}</textarea>
          </label>
          `}
          <p class="asset-ref" data-ref-label>${needsReference ? "素材图：未选择" : "文生图：无需素材图"}</p>
          ${needsReference ? `
          <label class="button secondary full">
            选择图生图素材图
            <input type="file" accept="image/*" data-ref-input data-index="${index}" hidden>
          </label>
          ` : ""}
          <div class="field" style="margin-top: 12px;">
            <span>工作流必要参数</span>
          </div>
          <div data-param-container>
            ${state.workflowNodeInfos.has(shot.workflow)
              ? workflowParamsHtml(shot, index, state.workflowNodeInfos.get(shot.workflow))
              : `<p class="hint">正在读取工作流节点参数…</p>`}
          </div>
          <div class="field" data-node-details>选择节点编号后，这里会显示自动映射的参数。</div>
          <div class="asset-actions">
            <button class="button primary" data-action="enqueue" data-index="${index}" ${shot.queueState === "queued" || shot.queueState === "running" ? "disabled" : ""}>
              ${shot.queueState === "queued" ? "已在生产队列" : shot.queueState === "running" ? "生产中" : "加入待生产队列"}
            </button>
            <a class="button ghost" data-output-link target="_blank" rel="noreferrer" hidden>查看</a>
          </div>
          <div class="asset-status" data-status>等待执行</div>
          <div class="field"><span>生图结果</span></div>
          <div data-preview></div>
          <div data-regenerate-panel></div>
        </div>
      </article>
    `;
  }).join("");

  state.blueprint.shots.forEach((shot, index) => {
    const card = cardByIndex(index);
    updateReferenceLabel(index);
    if (shot.output?.url) showOutput(index, shot.output);
    renderRegeneratePanel(index);
    refreshWorkflowNodeMapping(index);
  });
}

function cardByIndex(index) {
  return refs.assetGrid.querySelector(`[data-card-id="${CSS.escape(state.blueprint.shots[index].id)}"]`);
}

function assetKey(index) {
  const shot = state.blueprint.shots[index];
  return `${state.activeProjectId}:${state.activeEpisodeId}:${shot.id}`;
}

function syncPromptNodeValues(shot) {
  if (!shot?.workflowParams) return;
  shot.workflowParams.nodeValues = shot.workflowParams.nodeValues || {};
  const workflowInfo = state.workflowNodeInfos.get(shot.workflow)?.workflow || {};
  for (const nodeId of shot.workflowParams.nodeIds || []) {
    const inputs = workflowInfo[nodeId]?.inputs || {};
    const promptName = "prompt" in inputs ? "prompt" : "text" in inputs ? "text" : "";
    if (promptName) {
      shot.workflowParams.nodeValues[nodeId] = shot.workflowParams.nodeValues[nodeId] || {};
      shot.workflowParams.nodeValues[nodeId][promptName] = shot.positive_prompt || "";
    }
  }
}

function updateReferenceLabel(index) {
  const shot = state.blueprint.shots[index];
  const file = referenceFiles.get(assetKey(index));
  const label = cardByIndex(index)?.querySelector("[data-ref-label]");
  if (!label) return;
  if (shot.usecase === "image_to_image") {
    const sourceName = shot.sourceImageName || file?.name;
    label.textContent = `素材图：${sourceName || "未选择"}`;
  } else {
    label.textContent = "文生图：无需素材图";
  }
}

async function connectReferenceToWorkflow(index) {
  const shot = state.blueprint?.shots[index];
  if (!shot || shot.usecase !== "image_to_image") return;
  if (!state.client) state.client = new ComfyUIClient(refs.comfyUrl.value);
  await state.client.loadWorkflowTemplate(shot.workflow);
  await refreshWorkflowNodeMapping(index);
}

function showOutput(index, output) {
  const card = cardByIndex(index);
  if (!card) return;
  const preview = card.querySelector("[data-preview]");
  const link = card.querySelector("[data-output-link]");
  preview.innerHTML = `<img class="asset-preview" src="${escapeHtml(output.url)}" alt="${escapeHtml(state.blueprint.shots[index].title)}">`;
  link.href = output.url;
  link.hidden = false;
  renderRegeneratePanel(index);
}

function renderRegeneratePanel(index) {
  const shot = state.blueprint?.shots[index];
  const panel = cardByIndex(index)?.querySelector("[data-regenerate-panel]");
  if (!shot || !panel) return;
  if (!shot.output) {
    panel.innerHTML = "";
    return;
  }
  const episode = getActiveEpisode();
  const nextSequence = Math.max(
    Number(shot.sequence) || index + 1,
    (episode?.shots || []).reduce((max, item) => Math.max(max, Number(item.sequence) || 0), 0) + 1
  );
  panel.innerHTML = `
    <div class="regenerate-panel">
      <div class="field-row">
        <label class="field">
          <span>再生成序号</span>
          <input data-regenerate-sequence data-index="${index}" type="number" min="1" value="${escapeHtml(nextSequence)}">
        </label>
        <label class="field">
          <span>再生成标题</span>
          <input data-regenerate-title data-index="${index}" value="${escapeHtml(`${shot.title} · 再生成`)}">
        </label>
      </div>
      <label class="field">
        <span>再生成工作流</span>
        <select data-regenerate-workflow data-index="${index}">${workflowOptions(shot.workflow)}</select>
      </label>
      <button class="button secondary full" data-action="regenerate" data-index="${index}" ${state.queueRunning ? "disabled" : ""}>
        使用此结果再生成
      </button>
      <p class="hint">结果图会自动上传为 LoadImage 素材；目标序号决定生产队列顺序。</p>
    </div>
  `;
}

async function regenerateFromOutput(index) {
  if (state.queueRunning) {
    toast("生产队列运行中，暂不能再生成", "error");
    return;
  }
  const project = getActiveProject();
  const episode = getActiveEpisode();
  const shot = state.blueprint?.shots[index];
  const card = cardByIndex(index);
  if (!project || !episode || !shot?.output) return;
  if (!state.connected) {
    toast("请先连接 ComfyUI", "error");
    return;
  }

  const sequence = Math.max(1, Number(card?.querySelector("[data-regenerate-sequence]")?.value) || (episode.shots.length + 1));
  const title = String(card?.querySelector("[data-regenerate-title]")?.value || `${shot.title} · 再生成`).trim();
  const targetWorkflowId = String(card?.querySelector("[data-regenerate-workflow]")?.value || shot.workflow);
  const targetWorkflow = state.workflowCatalog.find(item => item.id === targetWorkflowId);
  if (!targetWorkflow) {
    toast("再生成工作流不存在，请刷新页面", "error");
    return;
  }
  if (!targetWorkflow.imageToImage) {
    toast("所选工作流没有 LoadImage 节点，不能使用结果图再生成", "error");
    return;
  }
  if (episode.shots.some(item => (Number(item.sequence) || 0) === sequence)) {
    toast(`再生成序号 ${sequence} 已存在`, "error");
    return;
  }
  if (!Number.isInteger(sequence)) {
    toast("再生成序号必须是整数", "error");
    return;
  }
  const button = card?.querySelector("[data-action='regenerate']");
  const originalText = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = "正在准备素材图…";
  }
  setAssetStatus(index, "复制生成结果为素材图");
  log(`再生成已选择工作流：${targetWorkflow.name}（${targetWorkflow.id}）。`);
  try {
    if (!shot.prompt_id) throw new Error("当前结果缺少 ComfyUI 任务 ID，不能安全再生成");
    const sourceJob = await state.client.getJobImages(shot.prompt_id);
    if (sourceJob.active) throw new Error("源图仍在 ComfyUI 中执行，请完成后再生成");
    const currentOutput = sourceJob.images.find(image =>
      image.filename === shot.output.filename
      && (image.subfolder || "") === (shot.output.subfolder || "")
      && image.type === shot.output.type
    );
    if (!currentOutput) throw new Error("卡片里的生成结果已过期，请刷新或重新生成后再使用");
    shot.output = currentOutput;

    const response = await fetch(shot.output.url);
    if (!response.ok) throw new Error(`生成结果读取失败 ${response.status}`);
    const blob = await response.blob();
    const extension = shot.output.filename?.match(/\.[a-z0-9]+$/i)?.[0] || ".png";
    const sourceBase = shot.output.filename.replace(/\.[^.]+$/, "");
    const sourceImageName = await uploadReference(
      new File([blob], `autodesign_regen_${safeName(sourceBase)}${extension}`, { type: blob.type || "image/png" })
    );

    const regenerated = normalizeShot({
      ...structuredClone(shot),
      id: createId("asset"),
      sequence,
      title,
      usecase: "image_to_image",
      output: null,
      prompt_id: null,
      queueState: "",
      workflow: targetWorkflowId,
      workflowParams: targetWorkflowId === shot.workflow
        ? structuredClone(shot.workflowParams || { nodeIds: [], nodeValues: {} })
        : { nodeIds: [], nodeValues: {} }
    }, episode.shots.length);
    regenerated.sourceImageName = sourceImageName;

    episode.shots.push(regenerated);
    episode.shots.sort((a, b) => (Number(a.sequence) || 0) - (Number(b.sequence) || 0));
    episode.specSource = episode.specSource || "manual";
    state.blueprint = buildEpisodeBlueprint(project, episode);
    renderBlueprint();
    updateProgress();
    persistProjects();

    const newIndex = state.blueprint.shots.findIndex(item => item.id === regenerated.id);
    if (newIndex >= 0) enqueueShot(newIndex);
    const expectedKey = shotQueueKey(project.id, episode.id, regenerated.id);
    if (!state.productionQueue.some(job => job.key === expectedKey)) {
      throw new Error("再生成任务未成功加入生产队列");
    }
    toast(`已创建序号 ${sequence} 的再生成卡片`);
    log(`再生成任务已加入生产队列：${episode.name} · 序号 ${sequence}。`, "success");
  } catch (error) {
    setAssetStatus(index, error.message, true);
    log(`再生成失败：${error.message}`, "error");
    toast(error.message, "error");
  } finally {
    if (button) {
      button.disabled = state.queueRunning;
      button.textContent = originalText || "使用此结果再生成";
    }
  }
}

function updateProgress() {
  const total = state.blueprint?.shots.length || 0;
  refs.queueText.textContent = `${state.completed} / ${total}`;
  refs.queueBar.style.width = total ? `${(state.completed / total) * 100}%` : "0%";
}

function setAssetStatus(index, text, isError = false) {
  const element = cardByIndex(index)?.querySelector("[data-status]");
  if (!element) return;
  element.textContent = text;
  element.style.color = isError ? "var(--danger)" : text.startsWith("完成") ? "var(--success)" : "var(--muted)";
}

function updateShotFromInput(index, field, value) {
  const shot = state.blueprint.shots[index];
  if (field.startsWith("nodeValue:")) {
    const [, nodeId, name] = field.split(":");
    shot.workflowParams = shot.workflowParams || {};
    shot.workflowParams.nodeValues = shot.workflowParams.nodeValues || {};
    shot.workflowParams.nodeValues[nodeId] = shot.workflowParams.nodeValues[nodeId] || {};
    const original = state.workflowNodeInfos.get(shot.workflow)?.workflow?.[nodeId]?.inputs?.[name];
    shot.workflowParams.nodeValues[nodeId][name] = typeof original === "number"
      ? Number(value) || 0
      : value;
    if (name === "prompt" || name === "text") shot.positive_prompt = value;
    persistProjects();
    return;
  }
  if (["width", "height", "steps"].includes(field)) {
    shot[field] = Math.max(1, Number(value) || shot[field]);
    if (field === "width") shot.width = Math.min(4096, shot.width);
    if (field === "height") shot.height = Math.min(4096, shot.height);
    if (field === "steps") shot.steps = Math.min(100, shot.steps);
  } else if (field === "cfg") {
    shot.cfg = Math.min(30, Math.max(1, Number(value) || shot.cfg));
  } else if (field === "denoise") {
    shot.denoise = Math.min(1, Math.max(0, Number(value) || 0));
  } else if (field === "positive_prompt") {
    shot.positive_prompt = value;
    syncPromptNodeValues(shot);
    persistProjects();
  } else if (field === "usecase") {
    shot.usecase = value;
    updateReferenceLabel(index);
  } else if (field === "workflow") {
    shot.workflow = value;
    persistProjects();
  } else if (field === "sequence") {
    shot.sequence = Math.max(1, Number(value) || shot.sequence || index + 1);
    persistProjects();
  } else {
    shot[field] = value;
  }
}

function safeName(value) {
  return String(value)
    .replace(/[\\/:*?"<>|\x00-\x1f]+/g, "_")
    .replace(/\.{2,}/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || "asset";
}

function episodeOutputFolder(project, episode) {
  const episodeNumber = Math.max(1, project.episodes.findIndex(item => item.id === episode.id) + 1);
  const episodeTitleText = safeName(episodeTitle(episode)) || `第${episodeNumber}幕`;
  return `第${String(episodeNumber).padStart(2, "0")}幕_${episodeTitleText}`;
}

function shotOutputPrefix(project, episode, shot) {
  const sequence = Math.max(1, Number(shot.sequence) || 1);
  return `autodesign/${safeName(project.name)}/${episodeOutputFolder(project, episode)}/seq_${String(sequence).padStart(3, "0")}_${safeName(shot.id)}`;
}

function formatNodeSummary(id, node) {
  const inputs = Object.keys(node?.inputs || {}).filter(key => {
    const value = node.inputs[key];
    return typeof value !== "object";
  });
  return `${id} · ${node?.class_type || "Unknown"} · ${inputs.join(", ") || "无基础参数"}`;
}

async function refreshWorkflowNodeMapping(index) {
  const shot = state.blueprint?.shots[index];
  if (!shot) return;
  if (!state.client) {
    state.client = new ComfyUIClient(refs.comfyUrl.value);
    state.client.registerWorkflowTemplates(state.workflowCatalog);
  }

  try {
    const template = await state.client.loadWorkflowTemplate(shot.workflow);
    const workflowInfo = { definition: template.definition, workflow: template.workflow };
    state.workflowNodeInfos.set(shot.workflow, workflowInfo);
    renderWorkflowParams(index);
    const mapped = mappedWorkflowNodes(shot);
    const lines = mapped.length
      ? mapped.map(({ id, node }) => `${formatNodeSummary(id, node)}`).join("<br>")
      : "使用工作流默认参数";

    const detail = cardByIndex(index)?.querySelector("[data-node-details]");
    if (detail) detail.innerHTML = lines;
  } catch (error) {
    const detail = cardByIndex(index)?.querySelector("[data-node-details]");
    if (detail) detail.textContent = `节点映射失败：${error.message}`;
  }
}

async function uploadReference(file, savedName = "") {
  if (!state.connected) throw new Error("请先连接 ComfyUI");
  if (uploadedFiles.has(file)) return uploadedFiles.get(file);
  const extension = (file.name.match(/\.[a-z0-9]+$/i)?.[0] || ".png").toLowerCase();
  const uploadName = savedName || `autodesign_${Date.now()}_${safeName(file.name.replace(/\.[^.]+$/, ""))}${extension}`;
  const result = await state.client.uploadImage(file, uploadName);
  const filename = result.subfolder ? `${result.subfolder}/${result.name}` : result.name;
  uploadedFiles.set(file, filename);
  return filename;
}

async function generateAsset(index) {
  const shot = state.blueprint.shots[index];
  if (!state.connected) throw new Error("ComfyUI 未连接");
  const workflowTemplateId = shot.workflow || "k2_anything2real_v3";
  const template = await state.client.loadWorkflowTemplate(workflowTemplateId);
  const workflowName = state.workflowCatalog.find(item => item.id === workflowTemplateId)?.name || workflowTemplateId;
  log(`提交 ComfyUI 工作流：${workflowName}（${workflowTemplateId}）；素材：${shot.usecase === "image_to_image" ? "图生图" : "文生图"}。`);

  let inputImage = "";
  if (shot.usecase === "image_to_image") {
    const referenceFile = referenceFiles.get(assetKey(index));
    if (referenceFile) {
      setAssetStatus(index, "上传参考图");
      inputImage = await uploadReference(referenceFile);
    } else if (shot.sourceImageName) {
      inputImage = shot.sourceImageName;
    } else {
      throw new Error("图生图需要先手动导入参考图");
    }
  }

  setAssetStatus(index, "排队中");
  const filenamePrefix = shotOutputPrefix(getActiveProject(), getActiveEpisode(), shot);
  const workflow = state.client.buildImportedWorkflow(template.workflow, {
    positivePrompt: shot.positive_prompt,
    inputImage,
    seed: createSeed(),
    filenamePrefix,
    workflowParams: shot.workflowParams || {},
    connectImage: shot.usecase === "image_to_image"
  });

  const promptId = await state.client.queue(workflow);
  setAssetStatus(index, `执行中 · ${promptId.slice(0, 8)}`);
  const images = await state.client.waitForJob(promptId, message => setAssetStatus(index, message));
  const output = images[0];
  shot.output = output;
  shot.prompt_id = promptId;
  showOutput(index, output);
  setAssetStatus(index, `完成 · ${output.filename}`, false);
  return output;
}

function ensureQueueReferences(project, episodes) {
  const missing = [];
  for (const episode of episodes) {
    for (const shot of episode.shots) {
      if (shot.usecase !== "image_to_image") continue;
      const reference = referenceFiles.get(`${project.id}:${episode.id}:${shot.id}`) || shot.sourceImageName;
      if (!reference) missing.push(`${episode.name} · 序号 ${shot.sequence || ""}：缺少素材图`);
    }
  }
  if (missing.length) {
    log("无人值守图片队列已阻止：存在缺少素材图的任务。", "error");
    missing.forEach(message => log(message, "error"));
    toast("存在缺少素材图的任务", "error");
    return false;
  }
  return true;
}

function findQueueLocation(job) {
  const project = state.projects.find(item => item.id === job.projectId);
  const episode = project?.episodes.find(item => item.id === job.episodeId);
  const shot = episode?.shots.find(item => item.id === job.shotId);
  return { project, episode, shot };
}

function shotQueueKey(projectId, episodeId, shotId) {
  return `${projectId}:${episodeId}:${shotId}`;
}

function sortProductionQueue() {
  const projectOrder = new Map(state.projects.map((project, index) => [project.id, index]));
  const episodeOrders = new Map(state.projects.map(project => [
    project.id,
    new Map(project.episodes.map((episode, index) => [episode.id, index]))
  ]));
  const shotOrders = new Map(state.projects.map(project => [
    project.id,
    new Map(project.episodes.map(episode => [
      episode.id,
      new Map(episode.shots.map((shot, index) => [shot.id, { index, sequence: Number(shot.sequence) || index + 1 }]))
    ]))
  ]));

  state.productionQueue.sort((a, b) => {
    const projectDiff = (projectOrder.get(a.projectId) ?? 9999) - (projectOrder.get(b.projectId) ?? 9999);
    if (projectDiff) return projectDiff;
    const episodeDiff = (episodeOrders.get(a.projectId)?.get(a.episodeId) ?? 9999)
      - (episodeOrders.get(b.projectId)?.get(b.episodeId) ?? 9999);
    if (episodeDiff) return episodeDiff;
    const aShot = shotOrders.get(a.projectId)?.get(a.episodeId)?.get(a.shotId);
    const bShot = shotOrders.get(b.projectId)?.get(b.episodeId)?.get(b.shotId);
    const sequenceDiff = (aShot?.sequence ?? 9999) - (bShot?.sequence ?? 9999);
    if (sequenceDiff) return sequenceDiff;
    return (aShot?.index ?? 9999) - (bShot?.index ?? 9999);
  });
}

function renderProductionQueue() {
  persistProductionQueue();
  const total = state.productionQueue.length;
  const summary = state.queueRunning
    ? `生产队列运行中：剩余 ${total} 项（严格按幕、序号排序）`
    : `待生产队列：${total} 项（严格按幕、序号排序）`;
  refs.productionQueueText.textContent = summary;
  refs.processQueueButton.disabled = state.queueRunning || !total;
  refs.clearQueueButton.disabled = state.queueRunning || !total;
  refs.queuePageStartButton.disabled = state.queueRunning || !total;
  refs.queuePageClearButton.disabled = state.queueRunning || !total;
  refs.queuePageStopButton.disabled = !state.queueRunning;

  refs.queueItems.innerHTML = total ? state.productionQueue.map((job, position) => {
    const { project, episode, shot } = findQueueLocation(job);
    if (!project || !episode || !shot) return "";
    const status = shot.queueState || "queued";
    const statusText = status === "queued" ? "等待生产"
      : status === "running" ? "生产中"
      : status === "done" ? "已完成"
      : status === "failed" ? "失败" : status;
    return `
      <article class="queue-item ${escapeHtml(status)}">
        <div class="queue-position">${position + 1}</div>
        <div class="queue-info">
          <strong>${escapeHtml(shot.title)}</strong>
          <span>${escapeHtml(project.name)} · ${escapeHtml(episode.name)} · 序号 ${escapeHtml(shot.sequence || position + 1)} · ${escapeHtml(shot.usecase === "image_to_image" ? "图生图" : "文生图")}</span>
          <span>工作流：${escapeHtml(state.workflowCatalog.find(item => item.id === shot.workflow)?.name || shot.workflow || "未指定")}</span>
        </div>
        <span class="queue-status">${escapeHtml(statusText)}</span>
        <button class="button ghost small" data-action="remove-queue-job" data-job-key="${escapeHtml(job.key)}" ${state.queueRunning ? "disabled" : ""}>移除</button>
      </article>
    `;
  }).join("") : `<p class="empty-queue">当前没有待生产任务。在素材工作台点击“加入待生产队列”即可添加。</p>`;
}

function renderWorkspace() {
  const worksheetActive = state.activeWorkspace === "worksheet";
  refs.worksheetView.hidden = !worksheetActive;
  refs.queueManagerView.hidden = worksheetActive;
  document.querySelectorAll("[data-workspace-tab]").forEach(button => {
    button.classList.toggle("active", button.dataset.workspaceTab === state.activeWorkspace);
  });
  if (worksheetActive) refreshMaterialInputs();
}

function switchWorkspace(view) {
  state.activeWorkspace = view === "queue" ? "queue" : "worksheet";
  renderWorkspace();
  if (state.activeWorkspace === "queue") renderProductionQueue();
}

function removeQueueJob(jobKey) {
  const index = state.productionQueue.findIndex(job => job.key === jobKey);
  if (index < 0) return;
  if (state.queueRunning && index === 0) {
    toast("当前任务生产中，请使用停止队列", "error");
    return;
  }
  const job = state.productionQueue.splice(index, 1)[0];
  const { shot } = findQueueLocation(job);
  if (shot && shot.queueState === "queued") shot.queueState = "";
  renderProductionQueue();
  renderBlueprint();
  persistProjects();
  toast("已从生产队列移除");
}

function setShotQueueState(job, queueState) {
  const { shot } = findQueueLocation(job);
  if (shot) {
    shot.queueState = queueState;
    persistProjects();
    if (job.projectId === state.activeProjectId && job.episodeId === state.activeEpisodeId) {
      const index = state.blueprint?.shots.findIndex(item => item.id === shot.id);
      if (index >= 0) {
        const meta = cardByIndex(index)?.querySelector(".asset-meta");
        if (meta) meta.children[meta.children.length - 1].textContent = queueState === "queued" ? "已排队"
          : queueState === "running" ? "生产中"
          : queueState === "done" ? "已完成"
          : queueState === "failed" ? "失败"
          : "未加入队列";
        const action = cardByIndex(index)?.querySelector("[data-action='enqueue']");
        if (action) {
          action.disabled = ["queued", "running"].includes(queueState);
          action.textContent = queueState === "queued" ? "已在生产队列"
            : queueState === "running" ? "生产中"
            : queueState === "done" ? "已完成"
            : queueState === "failed" ? "加入待生产队列"
            : "加入待生产队列";
        }
      }
    }
  }
  renderProductionQueue();
}

function enqueueShot(index) {
  const project = getActiveProject();
  const episode = getActiveEpisode();
  const shot = state.blueprint?.shots[index];
  if (!project || !episode || !shot) return;
  if (shot.usecase === "image_to_image" && !(referenceFiles.get(assetKey(index)) || shot.sourceImageName)) {
    toast("图生图需要先导入素材图", "error");
    return;
  }

  const key = shotQueueKey(project.id, episode.id, shot.id);
  if (state.productionQueue.some(job => job.key === key) || shot.queueState === "running") {
    toast("该序号已在生产队列中", "error");
    return;
  }

  const job = { key, projectId: project.id, episodeId: episode.id, shotId: shot.id };
  shot.queueState = "queued";
  state.productionQueue.push(job);
  sortProductionQueue();
  renderProductionQueue();
  renderBlueprint();
  persistProjects();
  toast(`序号 ${shot.sequence || index + 1} 已加入待生产队列`);
}

function enqueueEpisodeShots(project, episode) {
  for (const shot of [...episode.shots].sort((a, b) => (a.sequence || 0) - (b.sequence || 0))) {
    const key = shotQueueKey(project.id, episode.id, shot.id);
    if (!state.productionQueue.some(job => job.key === key) && shot.queueState !== "running") {
      shot.queueState = "queued";
      state.productionQueue.push({ key, projectId: project.id, episodeId: episode.id, shotId: shot.id });
    }
  }
  sortProductionQueue();
  renderProductionQueue();
  renderBlueprint();
  persistProjects();
}

function clearProductionQueue() {
  if (state.queueRunning) return;
  const queuedIds = new Set(state.productionQueue.map(job => job.shotId));
  state.productionQueue = [];
  state.projects.forEach(project => project.episodes.forEach(episode => episode.shots.forEach(shot => {
    if (queuedIds.has(shot.id) && shot.queueState === "queued") shot.queueState = "";
  })));
  renderProductionQueue();
  renderBlueprint();
  persistProjects();
  log("待生产队列已清空。");
}

async function runBatch() {
  const project = getActiveProject();
  const episode = getActiveEpisode();
  if (!project || !episode) {
    toast("请先创建或选择项目", "error");
    return;
  }
  if (!state.connected) {
    toast("请先连接 ComfyUI", "error");
    return;
  }

  if (!episode.shots.length) {
    toast("当前幕没有图片生成卡片，请先添加", "error");
    return;
  }
  if (!ensureQueueReferences(project, [episode])) return;
  enqueueEpisodeShots(project, episode);
  startProductionQueue();
}

async function runBatchProject() {
  const project = getActiveProject();
  if (!project?.episodes.length) {
    toast("请先创建或选择项目", "error");
    return;
  }
  if (!state.connected) {
    toast("请先连接 ComfyUI", "error");
    return;
  }

  if (!ensureQueueReferences(project, project.episodes)) return;

  enqueueEpisodeShots(project, project.episodes[0]);
  for (const episode of project.episodes.slice(1)) enqueueEpisodeShots(project, episode);
  startProductionQueue();
}

async function startProductionQueue() {
  if (state.queueRunning) return;
  if (!state.connected) {
    toast("请先连接 ComfyUI，生产队列将等待启动", "error");
    renderProductionQueue();
    return;
  }
  if (!state.productionQueue.length) {
    renderProductionQueue();
    return;
  }

  sortProductionQueue();
  state.queueRunning = true;
  state.running = true;
  state.stopRequested = false;
  refs.stopButton.disabled = false;
  refs.batchButton.disabled = true;
  refs.batchProjectButton.disabled = true;
  renderProductionQueue();
  log(`生产队列开始，剩余 ${state.productionQueue.length} 项，严格按幕、序号执行。`, "success");

  let completed = 0;
  let failed = 0;
  const stoppedByUser = () => state.stopRequested;
  while (state.productionQueue.length && !state.stopRequested) {
    sortProductionQueue();
    const job = state.productionQueue[0];
    const { project, episode, shot } = findQueueLocation(job);
    if (!project || !episode || !shot) {
      state.productionQueue.shift();
      continue;
    }

    state.activeProjectId = project.id;
    state.activeEpisodeId = episode.id;
    loadProjectToControls();
    state.blueprint = buildEpisodeBlueprint(project, episode);
    renderBlueprint();
    updateProgress();
    shot.queueState = "running";
    setShotQueueState(job, "running");

    const index = state.blueprint.shots.findIndex(item => item.id === shot.id);
    try {
      if (index < 0) throw new Error("素材规格不存在");
      await generateAsset(index);
      shot.queueState = "done";
      setShotQueueState(job, "done");
      completed += 1;
      log(`生产队列完成：${project.name} · ${episode.name} · 序号 ${shot.sequence}。`, "success");
    } catch (error) {
      shot.queueState = "failed";
      setShotQueueState(job, "failed");
      failed += 1;
      if (index >= 0) setAssetStatus(index, error.message, true);
      log(`生产队列失败：${project.name} · ${episode.name} · 序号 ${shot.sequence}：${error.message}`, "error");
    } finally {
      state.productionQueue.shift();
      if (shot.queueState === "done") state.completed += 1;
      updateProgress();
      renderProductionQueue();
      persistProjects();
    }
  }

  const stopped = stoppedByUser();
  state.queueRunning = false;
  state.running = false;
  state.stopRequested = false;
  refs.batchButton.disabled = false;
  refs.batchProjectButton.disabled = false;
  refs.stopButton.disabled = true;
  renderProductionQueue();
  const message = stopped
    ? `生产队列已停止：成功 ${completed} 张，失败 ${failed} 张，剩余 ${state.productionQueue.length} 项。`
    : `生产队列结束：成功 ${completed} 张，失败 ${failed} 张。`;
  log(message, stopped || failed ? "error" : "success");
  toast(stopped ? "生产队列已停止" : failed ? "生产队列结束，存在失败项" : "生产队列完成", stopped || failed ? "error" : "info");
}

function exportMarkdown() {
  if (!state.blueprint) {
    toast("暂无可导出的规格", "error");
    return;
  }
  const markdown = blueprintToMarkdown(state.blueprint);
  const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${safeName(state.blueprint.title)}_规格.md`;
  link.click();
  URL.revokeObjectURL(link.href);
  log("规格 Markdown 已导出。", "success");
}

function registerEvents() {
  refs.connectButton.addEventListener("click", connectComfy);
  document.querySelectorAll("[data-workspace-tab]").forEach(button => {
    button.addEventListener("click", () => switchWorkspace(button.dataset.workspaceTab));
  });
  refs.addCardButton.addEventListener("click", addImageCard);
  refs.queuePageStartButton.addEventListener("click", startProductionQueue);
  refs.queuePageStopButton.addEventListener("click", () => {
    state.stopRequested = true;
    log("已请求在当前素材完成后停止队列。", "error");
  });
  refs.queuePageClearButton.addEventListener("click", clearProductionQueue);
  refs.createProjectButton.addEventListener("click", createProject);
  refs.activeProject.addEventListener("change", () => {
    state.activeProjectId = refs.activeProject.value;
    state.activeEpisodeId = getActiveProject()?.episodes[0]?.id || "";
    loadProjectToControls();
    renderActiveEpisodeWorksheet({ scroll: true, notify: true });
    persistProjects();
  });
  refs.activeEpisode.addEventListener("change", () => {
    state.activeEpisodeId = refs.activeEpisode.value;
    loadProjectToControls();
    renderActiveEpisodeWorksheet({ scroll: true, notify: true });
    persistProjects();
  });
  refs.applyStructureButton.addEventListener("click", applyStructure);
  refs.applyActPlanButton.addEventListener("click", applyActPlan);
  refs.deleteProjectButton.addEventListener("click", deleteActiveProject);
  refs.episodeDuration.addEventListener("change", saveSettings);
  refs.batchButton.addEventListener("click", runBatch);
  refs.batchProjectButton.addEventListener("click", runBatchProject);
  refs.processQueueButton.addEventListener("click", startProductionQueue);
  refs.clearQueueButton.addEventListener("click", clearProductionQueue);
  refs.exportButton.addEventListener("click", exportMarkdown);
  refs.stopButton.addEventListener("click", () => {
    state.stopRequested = true;
    log("已请求在当前素材完成后停止队列。", "error");
  });
  refs.clearLogButton.addEventListener("click", () => { refs.log.textContent = ""; });

  document.querySelectorAll("[data-material-mode]").forEach(button => {
    button.addEventListener("click", () => setMaterialMode(button.dataset.materialMode));
  });
  refs.refreshMaterialButton.addEventListener("click", refreshMaterialInputs);
  refs.importImageButton.addEventListener("click", () => refs.materialImageInput.click());
  refs.materialImageInput.addEventListener("change", async event => {
    await uploadMaterialImages(event.target.files);
    event.target.value = "";
  });
  refs.materialTextGrid.addEventListener("dblclick", event => {
    const card = event.target.closest("[data-material-text]");
    if (card) openMaterialText(card.dataset.materialText);
  });
  refs.materialImageGrid.addEventListener("dblclick", event => {
    const card = event.target.closest("[data-material-image]");
    if (card) openMaterialImage(card.dataset.materialImage);
  });
  refs.materialTextGrid.addEventListener("dragstart", event => {
    const card = event.target.closest("[data-material-text]");
    const material = state.materialTexts.find(item => item.file === card?.dataset.materialText);
    if (material) setMaterialDragData(event, { type: "text", ...material });
  });
  refs.materialImageGrid.addEventListener("dragstart", event => {
    const card = event.target.closest("[data-material-image]");
    const material = state.materialImages.find(item => item.file === card?.dataset.materialImage);
    if (material) setMaterialDragData(event, { type: "image", ...material });
  });
  refs.assetGrid.addEventListener("dragover", event => {
    const card = event.target.closest("[data-material-drop-target]");
    if (!card || !event.dataTransfer.types.includes("text/plain")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    refs.assetGrid.querySelectorAll(".material-drop-target").forEach(item => item.classList.remove("material-drop-target"));
    card.classList.add("material-drop-target");
  });
  refs.assetGrid.addEventListener("dragleave", () => {
    refs.assetGrid.querySelectorAll(".material-drop-target").forEach(item => item.classList.remove("material-drop-target"));
  });
  refs.assetGrid.addEventListener("drop", async event => {
    const card = event.target.closest("[data-material-drop-target]");
    if (!card) return;
    event.preventDefault();
    card.classList.remove("material-drop-target");
    try {
      await dropMaterialOnCard(event, card);
    } catch (error) {
      toast(error.message, "error");
      log(`拖拽导入失败：${error.message}`, "error");
    }
  });
  refs.assetGrid.addEventListener("dragend", () => {
    refs.assetGrid.querySelectorAll(".material-drop-target").forEach(item => item.classList.remove("material-drop-target"));
  });
  refs.materialImageGrid.addEventListener("click", event => {
    const button = event.target.closest("[data-material-delete]");
    if (!button) return;
    event.stopPropagation();
    deleteMaterialImage(button.dataset.materialDelete);
  });
  refs.materialTextEditor.addEventListener("input", () => {
    if (!state.materialDocument) return;
    state.materialDocument.dirty = refs.materialTextEditor.value !== state.materialDocument.content;
    refs.saveMaterialTextButton.disabled = !state.materialDocument.dirty;
    refs.materialSaveState.textContent = state.materialDocument.dirty ? "未保存" : "";
  });
  refs.copyMaterialTextButton.addEventListener("click", copyMaterialText);
  refs.saveMaterialTextButton.addEventListener("click", saveMaterialText);
  document.querySelectorAll("[data-close-material-modal]").forEach(button => {
    button.addEventListener("click", () => {
      refs.materialTextModal.hidden = true;
      refs.materialImageModal.hidden = true;
      state.materialDocument = null;
    });
  });
  [refs.materialTextModal, refs.materialImageModal].forEach(modal => {
    modal.addEventListener("click", event => {
      if (event.target !== modal) return;
      modal.hidden = true;
      state.materialDocument = null;
    });
  });
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    refs.materialTextModal.hidden = true;
    refs.materialImageModal.hidden = true;
    state.materialDocument = null;
  });

  refs.assetGrid.addEventListener("input", event => {
    const field = event.target.dataset.field;
    if (!field) return;
    const index = Number(event.target.dataset.index);
    updateShotFromInput(index, field, event.target.value);
  });

  refs.assetGrid.addEventListener("change", async event => {
    const field = event.target.dataset.field;
    if (field === "usecase") {
      const index = Number(event.target.dataset.index);
      updateShotFromInput(index, field, event.target.value);
      renderBlueprint();
      return;
    }
    if (field === "workflow") {
      const index = Number(event.target.dataset.index);
      updateShotFromInput(index, field, event.target.value);
      const shot = state.blueprint.shots[index];
      shot.workflowParams.nodeIds = [];
      shot.workflowParams.nodeValues = {};
      renderBlueprint();
      refreshWorkflowNodeMapping(index);
      return;
    }
    if (field === "sequence") {
      const index = Number(event.target.dataset.index);
      updateShotFromInput(index, field, event.target.value);
      const episode = getActiveEpisode();
      episode.shots.sort((a, b) => (a.sequence || 0) - (b.sequence || 0));
      state.blueprint.shots = episode.shots;
      renderBlueprint();
      return;
    }

    const input = event.target.closest("[data-ref-input]");
    if (!input) return;
    const index = Number(input.dataset.index);
    const file = input.files[0];
    if (!file) return;
    referenceFiles.set(assetKey(index), file);
    updateReferenceLabel(index);
    log(`素材 ${index + 1} 已选择素材图：${file.name}`);
    try {
      await connectReferenceToWorkflow(index);
      log(`素材 ${index + 1} 已自动连接载入图片节点。`, "success");
    } catch (error) {
      setAssetStatus(index, error.message, true);
      log(`素材图连接失败：${error.message}`, "error");
    }
  });

  refs.assetGrid.addEventListener("click", async event => {
    const worksheetButton = event.target.closest("[data-action='create-worksheet']");
    if (worksheetButton) {
      const project = getActiveProject();
      const episode = getActiveEpisode();
      if (!project || !episode) return;
      episode.shots.push(createBlankWorksheetShot(project, episode));
      if (!episode.specSource) episode.specSource = "manual";
      state.blueprint = buildEpisodeBlueprint(project, episode);
      renderBlueprint();
      updateProgress();
      persistProjects();
      toast("已创建空白素材工作表");
      return;
    }

    const addNodeButton = event.target.closest("[data-action='add-node-param']");
    if (addNodeButton) {
      addNodeParam(Number(addNodeButton.dataset.index));
      return;
    }

    const removeNodeButton = event.target.closest("[data-action='remove-node-param']");
    if (removeNodeButton) {
      removeNodeParam(Number(removeNodeButton.dataset.index), removeNodeButton.dataset.nodeId);
      return;
    }

    const deleteButton = event.target.closest("[data-action='delete-card']");
    if (deleteButton) {
      deleteImageCard(Number(deleteButton.dataset.index));
      return;
    }

    const removeQueueButton = event.target.closest("[data-action='remove-queue-job']");
    if (removeQueueButton) {
      removeQueueJob(removeQueueButton.dataset.jobKey);
      return;
    }

    const regenerateButton = event.target.closest("[data-action='regenerate']");
    if (regenerateButton) {
      await regenerateFromOutput(Number(regenerateButton.dataset.index));
      return;
    }

    const button = event.target.closest("[data-action='enqueue']");
    if (!button || state.queueRunning) return;
    const index = Number(button.dataset.index);
    enqueueShot(index);
  });

  refs.queueItems.addEventListener("click", event => {
    const button = event.target.closest("[data-action='remove-queue-job']");
    if (!button) return;
    removeQueueJob(button.dataset.jobKey);
  });
}

async function initialize() {
  await loadWorkflowCatalog();
  loadProjects();
  setMaterialMode("text");
  restoreProductionQueue();
  renderProductionQueue();
  loadSettings();
  if (getActiveProject()) loadProjectToControls();
  registerEvents();
  renderWorkspace();
  connectionState(false, "未连接");
  log("AutoDesign 已就绪。请先连接本地 ComfyUI。");
}

initialize();
