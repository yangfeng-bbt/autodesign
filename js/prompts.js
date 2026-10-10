export const DEFAULT_NEGATIVE = "low quality, blurry, deformed hands, extra fingers, bad anatomy, watermark, signature, text artifacts, jpeg artifacts, oversaturated";

export function createFallbackBlueprint({ brief, styleHint, projectMode, shotCount = 6, width, height, steps, cfg, denoise, workflow, negativePrompt }) {
  const cleanBrief = brief.trim().slice(0, 120) || "未命名项目";
  const title = `${projectMode === "mv" ? "MV" : "漫剧"} · ${cleanBrief}`;
  const style = styleHint.trim() || "cinematic illustration";
  const beatLabels = projectMode === "mv"
    ? ["Opening", "Verse", "Build-up", "Chorus", "Emotional peak", "Bridge", "Final chorus", "Ending"]
    : ["Establishing", "Meet", "Tension", "Turn", "Conflict", "Climax", "Reveal", "Resolution"];

  const shots = Array.from({ length: shotCount }, (_, index) => {
    const beat = beatLabels[index % beatLabels.length];
    const shotSize = index % 3 === 0 ? "wide establishing shot" : index % 3 === 1 ? "medium character shot" : "close-up emotional shot";
    return {
      id: `asset_${String(index + 1).padStart(2, "0")}`,
      title: `${String(index + 1).padStart(2, "0")} · ${beat}`,
      usecase: index === 0 ? "text_to_image" : "text_to_image",
      shot_size: shotSize,
      camera: index % 3 === 1 ? "slight low angle, gentle dolly-in" : "balanced cinematic framing",
      action: `${cleanBrief} — ${beat} beat, clear focal subject, readable silhouette`,
      positive_prompt: `${cleanBrief}, ${beat} scene, ${shotSize}, ${camera(index)}, ${style}, dramatic lighting, detailed background, high detail, professional composition`,
      negative_prompt: negativePrompt,
      width,
      height,
      steps,
      cfg,
      denoise,
      workflow: "k2_anything2real_v3",
      sequence: index + 1,
      workflowParams: {
        aspectRatio: `${width}:${height}`,
        targetPixels: Number(((width * height) / 1000000).toFixed(2)),
        dimensionNode: "",
        pixelNode: "",
        samplerNode: ""
      },
      reference: ""
    };
  });

  return {
    title,
    project_mode: projectMode,
    style,
    summary: cleanBrief,
    characters: "主角：未命名；保持发型、服装与配饰一致。",
    negative_prompt: negativePrompt,
    shots,
    source: "local_fallback"
  };

  function camera(index) {
    return ["soft depth of field", "rim light and atmospheric haze", "wide angle perspective"][index % 3];
  }
}

function extractJson(text) {
  if (!text) throw new Error("AI 返回为空");
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const content = fenced ? fenced[1] : text;
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("AI 返回中没有 JSON 对象");
  return JSON.parse(content.slice(start, end + 1));
}

function number(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed * 1000) / 1000));
}

export function normalizeBlueprint(raw, context) {
  const fallback = createFallbackBlueprint(context);
  if (!raw || typeof raw !== "object") return fallback;

  const rawShots = Array.isArray(raw.shots) && raw.shots.length ? raw.shots : Array.isArray(raw.assets) ? raw.assets : [];
  const shots = rawShots.slice(0, 40).map((shot, index) => {
    const usecase = String(shot.usecase || shot.type || "text_to_image").toLowerCase();
    return {
      id: String(shot.id || `asset_${String(index + 1).padStart(2, "0")}`).slice(0, 60),
      title: String(shot.title || `素材 ${index + 1}`).slice(0, 100),
      usecase: usecase.includes("img") || usecase.includes("image") ? "image_to_image" : "text_to_image",
      shot_size: String(shot.shot_size || shot.framing || "cinematic shot").slice(0, 120),
      camera: String(shot.camera || shot.camera_move || "stable framing").slice(0, 160),
      action: String(shot.action || shot.description || "").slice(0, 500),
      positive_prompt: String(shot.positive_prompt || shot.prompt || `${context.brief}, ${context.styleHint}`).slice(0, 1800),
      negative_prompt: String(shot.negative_prompt || raw.negative_prompt || context.negativePrompt).slice(0, 1000),
      width: number(shot.width, context.width, 256, 4096),
      height: number(shot.height, context.height, 256, 4096),
      steps: Math.round(number(shot.steps, context.steps, 1, 100)),
      cfg: number(shot.cfg, context.cfg, 1, 30),
      denoise: number(shot.denoise, context.denoise, 0, 1),
      workflow: "k2_anything2real_v3",
      sequence: Math.max(1, Number(shot.sequence) || index + 1),
      workflowParams: {
        ...(shot.workflowParams || {}),
        aspectRatio: shot.workflowParams?.aspectRatio || `${context.width}:${context.height}`,
        targetPixels: Number(shot.workflowParams?.targetPixels) || Number(((context.width * context.height) / 1000000).toFixed(2)),
        dimensionNode: shot.workflowParams?.dimensionNode || "",
        pixelNode: shot.workflowParams?.pixelNode || "",
        samplerNode: shot.workflowParams?.samplerNode || ""
      },
      reference: ""
    };
  });

  if (!shots.length) return fallback;

  return {
    title: String(raw.title || fallback.title).slice(0, 160),
    project_mode: raw.project_mode === "mv" ? "mv" : context.projectMode,
    style: String(raw.style || context.styleHint).slice(0, 300),
    summary: String(raw.summary || raw.synopsis || context.brief).slice(0, 1200),
    characters: String(raw.characters || raw.character_sheet || "保持角色形象一致。").slice(0, 1200),
    negative_prompt: String(raw.negative_prompt || context.negativePrompt).slice(0, 1000),
    shots,
    source: raw.source || "ai"
  };
}

function buildPrompt(context) {
  return `你是影视级图像素材规划器。根据用户简报生成一个 JSON 对象，不要输出解释。
项目类型：${context.projectMode === "mv" ? "MV" : "漫剧"}
默认分辨率：${context.width}x${context.height}
画风补充：${context.styleHint}
默认反向提示词：${context.negativePrompt}
创意简报：
${context.brief}

要求：
1. 根据叙事节奏、场景变化和镜头需要规划素材数量；简报中明确数量时遵循该数量，总数必须在 1-40 之间。
2. 每个素材包含 id,title,usecase,shot_size,camera,action,positive_prompt,negative_prompt,width,height,steps,cfg,denoise。
3. usecase 只能是 text_to_image 或 image_to_image。不要假定已有参考图；如简报未要求角色一致性重绘，优先 text_to_image。
4. positive_prompt 用英文或中英混合的 ComfyUI Stable Diffusion 提示词，包含镜头、动作、光线、角色外观、环境与质量词。
5. width/height 必须符合漫剧或 MV 常见画幅，且在 256-4096。
6. 输出 JSON 结构：{"title":"","style":"","summary":"","characters":"","negative_prompt":"","shots":[]}`;
}

async function generateWithBrowserAI(context) {
  const provider = globalThis.LanguageModel || globalThis.ai?.languageModel;
  if (!provider) return null;
  const session = await provider.create({
    initialPrompts: [{ role: "system", content: "你只输出合法 JSON，不输出 Markdown 解释。" }]
  });
  const output = await session.prompt(buildPrompt(context));
  return extractJson(output);
}

async function generateWithEndpoint(context, endpoint, model, apiKey) {
  if (!endpoint) return null;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify({
      model: model || "local-model",
      temperature: 0.7,
      messages: [
        { role: "system", content: "你只输出合法 JSON，不输出 Markdown 解释。" },
        { role: "user", content: buildPrompt(context) }
      ]
    })
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`AI 端点 ${response.status}: ${detail.slice(0, 400)}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content
    || data?.choices?.[0]?.text
    || data?.message?.content
    || data?.response;
  return extractJson(content);
}

export async function generateBlueprint(context) {
  const errors = [];
  try {
    const raw = await generateWithBrowserAI(context);
    if (raw) return normalizeBlueprint(raw, { ...context, source: "browser_ai" });
    errors.push("浏览器内置 AI 不可用");
  } catch (error) {
    errors.push(`浏览器内置 AI: ${error.message}`);
  }

  try {
    const raw = await generateWithEndpoint(context, context.aiEndpoint, context.aiModel, context.aiKey);
    if (raw) return normalizeBlueprint(raw, { ...context, source: "ai_endpoint" });
    errors.push("AI 端点未配置");
  } catch (error) {
    errors.push(`AI 端点: ${error.message}`);
  }

  return {
    ...createFallbackBlueprint(context),
    source: "local_fallback",
    fallback_reason: errors.join("；")
  };
}

export function blueprintToMarkdown(blueprint) {
  const generatedAt = new Date().toLocaleString("zh-CN", { hour12: false });
  const lines = [
    `# ${blueprint.title}`,
    "",
    `- 生成日期：${generatedAt}`,
    `- 项目类型：${blueprint.project_mode === "mv" ? "MV" : "漫剧"}`,
    `- 规格来源：${blueprint.source}`,
    `- 画风：${blueprint.style}`,
    `- 默认反向提示词：${blueprint.negative_prompt}`,
    "",
    "## 项目概要",
    "",
    blueprint.summary,
    "",
    "## 角色一致性",
    "",
    blueprint.characters,
    "",
    "## 素材规格"
  ];

  blueprint.shots.forEach((shot, index) => {
    lines.push(
      "",
      `### ${index + 1}. ${shot.title}`,
      "",
      `- 用途：${shot.usecase}`,
      `- 画幅：${shot.width}x${shot.height}`,
      `- 镜头：${shot.shot_size}；${shot.camera}`,
      `- 动作：${shot.action || "—"}`,
      `- Steps / CFG / Denoise：${shot.steps} / ${shot.cfg} / ${shot.denoise}`,
      "- 正向提示词：",
      "",
      "```text",
      shot.positive_prompt,
      "```",
      "- 反向提示词：",
      "",
      "```text",
      shot.negative_prompt,
      "```"
    );
  });

  return lines.join("\n");
}
