import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { config } from '../config.js';
import { enhanceImagePrompt } from './deepseekService.js';

/** 参考图写入 JSON（chat）或 multipart（images/edits）时过大易触发上游网关 413 */
const CHAT_REF_MAX_RAW_BYTES = Number(process.env.MODEL_CHAT_REF_MAX_RAW_BYTES || 512000);
const CHAT_REF_MAX_EDGE = Number(process.env.MODEL_CHAT_REF_MAX_EDGE || 1536);
const CHAT_REF_JPEG_QUALITY = Number(process.env.MODEL_CHAT_REF_JPEG_QUALITY || 82);

const STYLE_PROMPTS = {
  realistic: '写实摄影风格，真实光影，高细节',
  illustration: '精致商业插画风格，色彩协调，画面干净',
  chinese: '国风美学，东方构图，细腻笔触',
  anime: '高质量动漫风格，角色鲜明，色彩明亮',
  product: '专业产品摄影，棚拍灯光，背景简洁'
};

function buildPrompt({ prompt, style, referenceImages = [] }) {
  const stylePrompt = STYLE_PROMPTS[style] || STYLE_PROMPTS.realistic;
  const references = referenceImages.length
    ? '\n'
    : '';
  return `${prompt}\n风格要求：${stylePrompt}。${references}`;
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function createMockImage(task, outputDir) {
  await fs.mkdir(outputDir, { recursive: true });
  const fileName = `${task.id}.svg`;
  const filePath = path.join(outputDir, fileName);
  const shortPrompt = escapeXml(task.prompt).slice(0, 120);
  const style = escapeXml(STYLE_PROMPTS[task.style] || STYLE_PROMPTS.realistic);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#2563eb"/>
      <stop offset="50%" stop-color="#7c3aed"/>
      <stop offset="100%" stop-color="#ec4899"/>
    </linearGradient>
  </defs>
  <rect width="1024" height="1024" rx="64" fill="url(#bg)"/>
  <circle cx="810" cy="190" r="130" fill="rgba(255,255,255,0.16)"/>
  <circle cx="190" cy="790" r="180" fill="rgba(255,255,255,0.12)"/>
  <text x="72" y="142" fill="#ffffff" font-size="44" font-family="Arial, sans-serif" font-weight="700">Mock AI Image</text>
  <text x="72" y="230" fill="#e0e7ff" font-size="28" font-family="Arial, sans-serif">${style}</text>
  <foreignObject x="72" y="330" width="880" height="360">
    <div xmlns="http://www.w3.org/1999/xhtml" style="color:white;font-size:42px;line-height:1.45;font-family:Arial,sans-serif;font-weight:700;">
      ${shortPrompt}
    </div>
  </foreignObject>
  <text x="72" y="910" fill="#f8fafc" font-size="24" font-family="Arial, sans-serif">配置真实 MODEL_API_KEY 后将调用图片生成模型</text>
</svg>`;
  await fs.writeFile(filePath, svg);
  return `/uploads/generated/${fileName}`;
}

function createAbortSignal() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.model.timeoutMs);
  return { controller, timeout };
}

function createImagePayload(task) {
  const imageCount = Number.isFinite(config.model.imageCount) ? config.model.imageCount : 1;
  return {
    model: task.imageModel || config.model.imageModel,
    prompt: buildPrompt(task),
    n: Math.min(Math.max(imageCount, 1), 4),
    response_format: config.model.responseFormat
  };
}

function parseLocalUploadPath(imageUrl) {
  if (!imageUrl.startsWith('/uploads/')) {
    throw new Error('参考图必须先通过本服务上传，不能直接传外部图片 URL');
  }
  const relativePath = imageUrl.replace(/^\/uploads\//, '');
  return path.join(config.uploadDir, relativePath);
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp'
  };
  return map[ext] || 'application/octet-stream';
}

async function prepareReferenceImageForModelApi(imageUrl) {
  const filePath = parseLocalUploadPath(imageUrl);
  const input = await fs.readFile(filePath);
  const originalName = path.basename(filePath);
  let mime = getMimeType(filePath);
  let buf = input;
  let didCompress = false;

  let needCompress = input.length > CHAT_REF_MAX_RAW_BYTES;
  if (!needCompress) {
    try {
      const meta = await sharp(input).metadata();
      const w = meta.width || 0;
      const h = meta.height || 0;
      if (w > CHAT_REF_MAX_EDGE || h > CHAT_REF_MAX_EDGE) {
        needCompress = true;
      }
    } catch {
      /* 无法解析则保持原图 */
    }
  }

  if (needCompress) {
    try {
      const meta = await sharp(input).rotate().metadata();
      const w = meta.width || 0;
      const h = meta.height || 0;
      const pipeline =
        w > CHAT_REF_MAX_EDGE || h > CHAT_REF_MAX_EDGE
          ? sharp(input)
              .rotate()
              .resize(CHAT_REF_MAX_EDGE, CHAT_REF_MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
          : sharp(input).rotate();
      buf = await pipeline.jpeg({ quality: CHAT_REF_JPEG_QUALITY, mozjpeg: true }).toBuffer();
      mime = 'image/jpeg';
      didCompress = true;
      console.log(
        `[Image] 参考图已压缩（chat / images/edits 共用，减轻体积）：${originalName} ${input.length} → ${buf.length} 字节`
      );
    } catch (e) {
      console.warn(`[Image] 参考图压缩失败，使用原图：${e.message}`);
      buf = input;
      mime = getMimeType(filePath);
    }
  }

  const filename = didCompress
    ? `${path.basename(filePath, path.extname(filePath)) || 'ref'}-model.jpg`
    : originalName;

  return { buffer: buf, mime, filename };
}

/** @returns {Promise<number>} 参考图文件字节合计（压缩后） */
async function appendReferenceImages(formData, referenceImages) {
  let totalBytes = 0;
  for (const imageUrl of referenceImages) {
    const { buffer, mime, filename } = await prepareReferenceImageForModelApi(imageUrl);
    totalBytes += buffer.length;
    formData.append('image', new Blob([buffer], { type: mime }), filename);
  }
  return totalBytes;
}

async function saveImageResult(task, first) {
  if (first.b64_json) {
    const outputDir = path.join(config.uploadDir, 'generated');
    await fs.mkdir(outputDir, { recursive: true });
    const fileName = `${task.id}.png`;
    await fs.writeFile(path.join(outputDir, fileName), Buffer.from(first.b64_json, 'base64'));
    return `/uploads/generated/${fileName}`;
  }

  if (first.url) {
    return first.url;
  }

  throw new Error('模型接口返回格式无法识别');
}

function modelApiErrorMessage(status, data, rawText) {
  if (data?.error?.message || data?.message) {
    return data.error?.message || data.message;
  }
  const t = String(rawText || '').trim();
  if (/<html[\s>]/i.test(t)) {
    return `模型接口失败：${status}（响应为 HTML，多为网关/Nginx 限流或限体积，非 OpenAI 式 JSON 业务错误）`;
  }
  return t ? t.slice(0, 280) : `模型接口失败：${status}`;
}

function logModelApiFailure(label, res, rawText) {
  const url = res.url || '(fetch 未提供 url)';
  const snippet = String(rawText || '')
    .replace(/\s+/g, ' ')
    .slice(0, 600);
  console.error(`[Model API] ${label} 失败 | HTTP ${res.status} | 响应 URL: ${url}`);
  console.error(`[Model API] 响应片段: ${snippet}`);
}

async function parseImageResponse(res, label = 'images') {
  const rawText = await res.text();
  let data = {};
  try {
    data = JSON.parse(rawText);
  } catch {
    data = {};
  }
  if (!res.ok) {
    logModelApiFailure(label, res, rawText);
    throw new Error(modelApiErrorMessage(res.status, data, rawText));
  }

  const first = data.data?.[0];
  if (!first) {
    throw new Error('模型接口未返回图片数据');
  }

  return first;
}

function getModelApiUrl(endpoint) {
  const base = config.model.apiBase.replace(/\/$/, '');
  const normalizedEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  if (base.endsWith('/v1')) {
    return `${base}${normalizedEndpoint}`;
  }
  return `${base}/v1${normalizedEndpoint}`;
}

function usesChatCompletionsForImage(modelName) {
  const name = modelName || config.model.imageModel;
  return config.model.imageModelsViaChat.includes(name);
}

async function readLocalUploadAsDataUrlForChat(imageUrl) {
  const { buffer, mime } = await prepareReferenceImageForModelApi(imageUrl);
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

async function buildChatUserContent(task, promptText) {
  const refs = Array.isArray(task.referenceImages) ? task.referenceImages : [];
  if (refs.length === 0) {
    return promptText;
  }
  const parts = [{ type: 'text', text: promptText }];
  for (const url of refs) {
    const dataUrl = await readLocalUploadAsDataUrlForChat(url);
    parts.push({
      type: 'image_url',
      image_url: { url: dataUrl }
    });
  }
  return parts;
}

function pickNumericOption(value) {
  if (value == null || value === '') {
    return undefined;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function normalizeChatMessages(rawMessages) {
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    return null;
  }
  return rawMessages
    .filter((m) => m && typeof m === 'object' && typeof m.role === 'string' && m.content != null)
    .map((m) => ({
      role: m.role,
      content: m.content
    }));
}

function extractImageUrlFromString(text) {
  const s = String(text || '').trim();
  if (!s) {
    return null;
  }
  if (/^https?:\/\//i.test(s)) {
    return s.split(/\s/)[0];
  }
  const md = s.match(/!\[[^\]]*]\((https?:\/\/[^)\s]+)\)/i);
  if (md) {
    return md[1];
  }
  const bare = s.match(/(https?:\/\/[^\s"'<>]+)/i);
  if (bare) {
    return bare[1].replace(/[),.;]+$/, '');
  }
  const dataMatch = s.match(/data:image\/[a-z0-9+.-]+;base64,[A-Za-z0-9+/=]+/i);
  if (dataMatch) {
    return dataMatch[0];
  }
  try {
    const j = JSON.parse(s);
    if (j.url && /^https?:\/\//i.test(j.url)) {
      return j.url;
    }
    if (j.image_url && /^https?:\/\//i.test(j.image_url)) {
      return j.image_url;
    }
    if (j.b64_json && typeof j.b64_json === 'string') {
      return `data:image/png;base64,${j.b64_json}`;
    }
  } catch {
    /* not JSON */
  }
  return null;
}

function extractImageFromChatMessage(message) {
  if (!message) {
    return null;
  }
  const { content } = message;
  if (typeof content === 'string') {
    return extractImageUrlFromString(content);
  }
  if (Array.isArray(content)) {
    for (const part of content) {
      if (!part || typeof part !== 'object') {
        continue;
      }
      if (part.type === 'image_url' && part.image_url?.url) {
        return part.image_url.url;
      }
      if (part.type === 'text' && part.text) {
        const fromText = extractImageUrlFromString(part.text);
        if (fromText) {
          return fromText;
        }
      }
    }
  }
  return null;
}

async function persistChatImageResult(task, imageRef) {
  if (!imageRef) {
    throw new Error('对话接口未返回可识别的图片（链接或 base64）');
  }
  if (imageRef.startsWith('data:image') && imageRef.includes(';base64,')) {
    const [, b64] = imageRef.split(';base64,');
    const outputDir = path.join(config.uploadDir, 'generated');
    await fs.mkdir(outputDir, { recursive: true });
    const fileName = `${task.id}.png`;
    await fs.writeFile(path.join(outputDir, fileName), Buffer.from(b64, 'base64'));
    return `/uploads/generated/${fileName}`;
  }
  if (/^https?:\/\//i.test(imageRef)) {
    return imageRef;
  }
  throw new Error('对话接口返回的图片格式无法保存');
}

async function parseChatCompletionResponse(res) {
  const rawText = await res.text();
  let data = {};
  try {
    data = JSON.parse(rawText);
  } catch {
    data = {};
  }
  if (!res.ok) {
    logModelApiFailure('chat/completions', res, rawText);
    throw new Error(modelApiErrorMessage(res.status, data, rawText));
  }
  const message = data.choices?.[0]?.message;
  const imageRef = extractImageFromChatMessage(message);
  if (!imageRef) {
    const preview = typeof message?.content === 'string' ? message.content.slice(0, 500) : JSON.stringify(message?.content || '').slice(0, 500);
    throw new Error(`对话接口未解析到图片，返回片段：${preview}`);
  }
  return imageRef;
}

async function callImageViaChatCompletions(task, promptText) {
  const model = task.imageModel || config.model.imageModel;
  const customMessages = normalizeChatMessages(task.chatMessages);
  const userContent = customMessages ? null : await buildChatUserContent(task, promptText);
  const { controller, timeout } = createAbortSignal();
  try {
    const chatPayload = {
      model,
      messages: customMessages || [{ role: 'user', content: userContent }],
      max_tokens: pickNumericOption(task.chatOptions?.max_tokens) || 4096,
      stream: false
    };
    const temp = pickNumericOption(task.chatOptions?.temperature);
    const topP = pickNumericOption(task.chatOptions?.top_p);
    const freqPenalty = pickNumericOption(task.chatOptions?.frequency_penalty);
    const presencePenalty = pickNumericOption(task.chatOptions?.presence_penalty);
    if (temp != null) {
      chatPayload.temperature = temp;
    }
    if (topP != null) {
      chatPayload.top_p = topP;
    }
    if (freqPenalty != null) {
      chatPayload.frequency_penalty = freqPenalty;
    }
    if (presencePenalty != null) {
      chatPayload.presence_penalty = presencePenalty;
    }
    const group = (task.chatGroup || '').trim() || config.model.chatGroup;
    if (group) {
      chatPayload.group = group;
    }
    if (task.chatStreamRequested) {
      console.log('[Model API] 检测到 stream=true 请求，为兼容当前图片结果解析逻辑已强制改为 stream=false');
    }
    const body = JSON.stringify(chatPayload);
    console.log(`[Model API] POST .../chat/completions 请求体约 ${body.length} 字符`);
    const res = await fetch(getModelApiUrl('/chat/completions'), {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${config.model.apiKey}`,
        'Content-Type': 'application/json'
      },
      body
    });
    const imageRef = await parseChatCompletionResponse(res);
    return persistChatImageResult(task, imageRef);
  } finally {
    clearTimeout(timeout);
  }
}

async function callImageGenerationApi(task, prompt) {
  const { controller, timeout } = createAbortSignal();
  try {
    const res = await fetch(getModelApiUrl('/images/generations'), {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${config.model.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(createImagePayload({ ...task, prompt }))
    });

    const first = await parseImageResponse(res, 'images/generations');
    return saveImageResult(task, first);
  } finally {
    clearTimeout(timeout);
  }
}

async function callImageEditApi(task, prompt) {
  const { controller, timeout } = createAbortSignal();
  const payload = createImagePayload({ ...task, prompt });
  const formData = new FormData();

  formData.append('model', payload.model);
  formData.append('prompt', payload.prompt);
  formData.append('n', String(payload.n));
  formData.append('response_format', payload.response_format);
  const refBytes = await appendReferenceImages(formData, task.referenceImages);
  console.log(
    `[Model API] POST .../images/edits 参考图文件合计约 ${refBytes} 字节（multipart 总体会更大）；prompt 约 ${Buffer.byteLength(payload.prompt, 'utf8')} 字节`
  );

  try {
    const res = await fetch(getModelApiUrl('/images/edits'), {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${config.model.apiKey}`
      },
      body: formData
    });

    const first = await parseImageResponse(res, 'images/edits');
    return saveImageResult(task, first);
  } finally {
    clearTimeout(timeout);
  }
}

export async function generateImage(task) {
  if (config.model.mock) {
    return createMockImage(task, path.join(config.uploadDir, 'generated'));
  }

  if (config.model.provider !== 'openai') {
    throw new Error(`暂不支持的模型提供方：${config.model.provider}`);
  }

  const enhancedPrompt = await enhanceImagePrompt({
    prompt: task.prompt,
    style: task.style,
    hasReferenceImages: Boolean(task.referenceImages?.length)
  });
  console.log(`[Image] 任务 ${task.id} 使用模型：${task.imageModel || config.model.imageModel}`);
  console.log(`[DeepSeek] 任务 ${task.id}：${enhancedPrompt === task.prompt ? '未改写或未启用' : '已优化提示词'}`);
  console.log(`[DeepSeek] 参考图数量：${task.referenceImages?.length || 0}`);
  console.log(`[DeepSeek] 原始提示词：\n${task.prompt}`);
  console.log(`[DeepSeek] 优化后提示词：\n${enhancedPrompt}`);

  const modelName = task.imageModel || config.model.imageModel;
  if (usesChatCompletionsForImage(modelName)) {
    console.log(`[Image] 任务 ${task.id} 使用 Chat Completions 生图（${modelName}）`);
    const imageUrl = await callImageViaChatCompletions(task, enhancedPrompt);
    return { imageUrl, enhancedPrompt };
  }

  if (task.referenceImages?.length) {
    const imageUrl = await callImageEditApi(task, enhancedPrompt);
    return { imageUrl, enhancedPrompt };
  }

  const imageUrl = await callImageGenerationApi(task, enhancedPrompt);
  return { imageUrl, enhancedPrompt };
}
