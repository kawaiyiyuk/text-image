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

function buildPrompt({ prompt, style, size = '1024x1024', referenceImages = [] }) {
  const stylePrompt = STYLE_PROMPTS[style] || STYLE_PROMPTS.realistic;
  const references = referenceImages.length
    ? '\n'
    : '';
  return `${prompt}\n风格要求：${stylePrompt}。\n尺寸要求：${size}。${references}`;
}

function mapSizeToDashScope(size) {
  const s = String(size || '').trim();
  if (s === '2048x2048' || s === '1024x1536' || s === '1536x1024') return '2K';
  return '1K';
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
  const requestedCount = Number.isFinite(Number(task.imageCount)) ? Math.trunc(Number(task.imageCount)) : Math.trunc(Number(config.model.imageCount) || 1);
  const imageCount = [1, 2, 4, 8].includes(requestedCount) ? requestedCount : 4;
  return {
    model: task.imageModel || config.model.imageModel,
    prompt: buildPrompt(task),
    n: imageCount,
    size: task.size || '1024x1024',
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

async function saveImageResult(task, image, index = 0) {
  if (image.b64_json) {
    const outputDir = path.join(config.uploadDir, 'generated');
    await fs.mkdir(outputDir, { recursive: true });
    const suffix = index > 0 ? `-${index + 1}` : '';
    const fileName = `${task.id}${suffix}.png`;
    await fs.writeFile(path.join(outputDir, fileName), Buffer.from(image.b64_json, 'base64'));
    return `/uploads/generated/${fileName}`;
  }

  if (image.url) {
    return image.url;
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

  const images = Array.isArray(data.data) ? data.data : [];
  if (images.length === 0) {
    throw new Error('模型接口未返回图片数据');
  }

  return images;
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
  const sanitizeContent = (content) => {
    if (Array.isArray(content)) {
      const cleaned = content.filter((part) => {
        if (!part || typeof part !== 'object') {
          return false;
        }
        // 透传历史消息时禁止携带 thinking 块，避免 signature 校验失败
        if (part.type === 'thinking' || part.type === 'redacted_thinking') {
          return false;
        }
        return true;
      });
      return cleaned.length > 0 ? cleaned : null;
    }
    if (typeof content === 'string') {
      return content;
    }
    if (content && typeof content === 'object') {
      if (content.type === 'thinking' || content.type === 'redacted_thinking') {
        return null;
      }
      return content;
    }
    return null;
  };

  return rawMessages
    .filter((m) => m && typeof m === 'object' && typeof m.role === 'string' && m.content != null)
    .map((m) => {
      const cleanedContent = sanitizeContent(m.content);
      if (cleanedContent == null) {
        return null;
      }
      return {
        role: m.role,
        content: cleanedContent
      };
    })
    .filter(Boolean);
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

  // 记录完整响应结构以辅助排查
  console.log('[Model API] chat/completions 响应结构:', JSON.stringify({
    id: data.id,
    model: data.model,
    object: data.object,
    hasChoices: Array.isArray(data.choices),
    choicesLength: data.choices?.length,
    messageRole: message?.role,
    messageContentType: Array.isArray(message?.content) ? 'array' : typeof message?.content,
    topKeys: Object.keys(data)
  }));

  // 尝试多种方式提取图片
  let imageRef = extractImageFromChatMessage(message);

  // 部分网关在 message 层级放 images 数组
  if (!imageRef && Array.isArray(message?.images)) {
    for (const img of message.images) {
      if (img?.url || img?.b64_json || img?.image_url) {
        imageRef = img.url || img.image_url || (img.b64_json ? `data:image/png;base64,${img.b64_json}` : null);
        if (imageRef) break;
      }
    }
  }

  // 部分网关使用类似 /images/generations 的 data 数组
  if (!imageRef && Array.isArray(data.data)) {
    for (const img of data.data) {
      if (img?.url || img?.b64_json) {
        imageRef = img.url || (img.b64_json ? `data:image/png;base64,${img.b64_json}` : null);
        if (imageRef) break;
      }
    }
  }

  if (!imageRef) {
    const preview = typeof message?.content === 'string' ? message.content.slice(0, 500) : JSON.stringify(message?.content || '').slice(0, 500);
    console.error('[Model API] chat/completions 未解析到图片，响应全文前 2000 字符:', rawText.slice(0, 2000));
    throw new Error(`对话接口未解析到图片，返回片段：${preview}`);
  }
  return imageRef;
}

async function callImageViaChatCompletionsOnce(task, promptText, index = 0) {
  const model = task.imageModel || config.model.imageModel;
  const customMessages = normalizeChatMessages(task.chatMessages);
  const userContent = customMessages ? null : await buildChatUserContent(task, promptText);
  const { controller, timeout } = createAbortSignal();
  try {
    const systemMessage = { role: 'system', content: '你是一个图片生成模型。请根据用户的描述直接生成图片，只输出图片，不要返回文字建议、方案说明或提示词示例。如果无法生成图片，请返回包含 image_url 的响应。' };
    const chatPayload = {
      model,
      messages: customMessages
        ? [systemMessage, ...customMessages]
        : [systemMessage, { role: 'user', content: userContent }],
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
    const userContentPreview = typeof userContent === 'string' ? userContent.slice(0, 200) : '[array content]';
    console.log(`[Model API] POST .../chat/completions 请求体约 ${body.length} 字符，prompt 前 200 字符: ${userContentPreview}`);
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
    if (imageRef.startsWith('data:image') && imageRef.includes(';base64,')) {
      const [, b64] = imageRef.split(';base64,');
      const outputDir = path.join(config.uploadDir, 'generated');
      await fs.mkdir(outputDir, { recursive: true });
      const suffix = index > 0 ? `-${index + 1}` : '';
      const fileName = `${task.id}${suffix}.png`;
      await fs.writeFile(path.join(outputDir, fileName), Buffer.from(b64, 'base64'));
      return `/uploads/generated/${fileName}`;
    }
    return persistChatImageResult(task, imageRef);
  } finally {
    clearTimeout(timeout);
  }
}

async function callImageViaChatCompletions(task, promptText) {
  const requestedCount = Number.isFinite(Number(task.imageCount)) ? Math.trunc(Number(task.imageCount)) : Math.trunc(Number(config.model.imageCount) || 1);
  const count = [1, 2, 4, 8].includes(requestedCount) ? requestedCount : 4;
  const imageUrls = [];
  for (let i = 0; i < count; i += 1) {
    const imageUrl = await callImageViaChatCompletionsOnce(task, promptText, i);
    imageUrls.push(imageUrl);
  }
  return imageUrls;
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

    const images = await parseImageResponse(res, 'images/generations');
    return Promise.all(images.map((image, index) => saveImageResult(task, image, index)));
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

    const images = await parseImageResponse(res, 'images/edits');
    return Promise.all(images.map((image, index) => saveImageResult(task, image, index)));
  } finally {
    clearTimeout(timeout);
  }
}

// ---- DashScope (阿里云百炼) ----

function createDashScopeAbortSignal() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.dashscope.timeoutMs);
  return { controller, timeout };
}

async function buildDashScopePayload(task, promptText) {
  const content = [{ text: promptText }];

  const refs = Array.isArray(task.referenceImages) ? task.referenceImages : [];
  for (const imageUrl of refs) {
    const dataUrl = await readLocalUploadAsDataUrlForChat(imageUrl);
    content.push({ image: dataUrl });
  }

  const requestedN = Number.isFinite(Number(task.imageCount))
    ? Math.trunc(Number(task.imageCount))
    : 1;
  const effectiveN = config.dashscope.thinkingMode
    ? 1
    : Math.min(Math.max(requestedN, 1), 4);

  return {
    model: task.imageModel || config.model.imageModel,
    input: {
      messages: [
        { role: 'user', content }
      ]
    },
    parameters: {
      size: mapSizeToDashScope(task.size || '1024x1024'),
      n: effectiveN,
      watermark: false,
      thinking_mode: config.dashscope.thinkingMode
    }
  };
}

async function downloadDashScopeImage(imageUrl, taskId, index = 0) {
  const response = await fetch(imageUrl);
  if (!response.ok) {
    throw new Error(`下载 DashScope 图片失败：HTTP ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const outputDir = path.join(config.uploadDir, 'generated');
  await fs.mkdir(outputDir, { recursive: true });
  const suffix = index > 0 ? `-${index + 1}` : '';
  const fileName = `${taskId}${suffix}.png`;
  await fs.writeFile(path.join(outputDir, fileName), buffer);
  return `/uploads/generated/${fileName}`;
}

async function callDashScopeApi(task, promptText) {
  const payload = await buildDashScopePayload(task, promptText);
  const url = `${config.dashscope.apiBase.replace(/\/$/, '')}/generation`;
  const { controller, timeout } = createDashScopeAbortSignal();

  try {
    const body = JSON.stringify(payload);
    console.log(`[DashScope] POST ${url}, model=${payload.model}, size=${payload.parameters.size}, n=${payload.parameters.n}`);

    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${config.dashscope.apiKey}`,
        'Content-Type': 'application/json'
      },
      body
    });

    const rawText = await res.text();
    let data = {};
    try { data = JSON.parse(rawText); } catch { /* keep empty */ }

    if (!res.ok) {
      const errMsg = data?.message || data?.code
        ? `DashScope: ${data.message || data.code}`
        : `DashScope API 返回 HTTP ${res.status}`;
      console.error(`[DashScope] 请求失败 | HTTP ${res.status} | ${rawText.slice(0, 600)}`);
      throw new Error(errMsg);
    }

    const choices = data?.output?.choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      console.error('[DashScope] 响应中无 choices:', JSON.stringify(data).slice(0, 1000));
      throw new Error('DashScope 未返回图片数据');
    }

    const imageUrls = [];
    for (const choice of choices) {
      const msgContent = choice?.message?.content;
      if (!Array.isArray(msgContent)) continue;
      const imagePart = msgContent.find((c) => c && c.image);
      if (imagePart?.image) {
        imageUrls.push(imagePart.image);
      }
    }

    if (imageUrls.length === 0) {
      throw new Error('DashScope 响应中未找到图片 URL');
    }

    console.log(`[DashScope] 获取到 ${imageUrls.length} 张图片，开始下载到本地...`);

    const localUrls = await Promise.all(
      imageUrls.map((url, i) => downloadDashScopeImage(url, task.id, i))
    );

    return localUrls;
  } finally {
    clearTimeout(timeout);
  }
}

async function generateImageDashScope(task, promptText) {
  const localUrls = await callDashScopeApi(task, promptText);
  return {
    imageUrl: localUrls[0] || '',
    imageUrls: localUrls,
    enhancedPrompt: promptText
  };
}

// ---- generateImage ----

export async function generateImage(task) {
  if (config.model.mock) {
    return createMockImage(task, path.join(config.uploadDir, 'generated'));
  }

  if (config.model.provider !== 'openai' && config.model.provider !== 'dashscope') {
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

  if (config.model.provider === 'dashscope') {
    return generateImageDashScope(task, enhancedPrompt);
  }

  const modelName = task.imageModel || config.model.imageModel;
  if (usesChatCompletionsForImage(modelName)) {
    console.log(`[Image] 任务 ${task.id} 使用 Chat Completions 生图（${modelName}）`);
    const imageUrls = await callImageViaChatCompletions(task, enhancedPrompt);
    return { imageUrl: imageUrls[0] || '', imageUrls, enhancedPrompt };
  }

  if (task.referenceImages?.length) {
    const imageUrls = await callImageEditApi(task, enhancedPrompt);
    return { imageUrl: imageUrls[0] || '', imageUrls, enhancedPrompt };
  }

  const imageUrls = await callImageGenerationApi(task, enhancedPrompt);
  return { imageUrl: imageUrls[0] || '', imageUrls, enhancedPrompt };
}
