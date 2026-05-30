import { config } from '../config.js';

const HEAD_SWAP_RULES = [

].join('\n');

function getDeepSeekApiUrl(endpoint) {
  const base = config.deepseek.apiBase.replace(/\/$/, '');
  const normalizedEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  if (base.endsWith('/v1')) {
    return `${base}${normalizedEndpoint}`;
  }
  return `${base}${normalizedEndpoint}`;
}

function createAbortSignal() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.deepseek.timeoutMs);
  return { controller, timeout };
}

let runtimeDeepSeekEnabled = Boolean(config.deepseek.enabled);

export function getDeepSeekRuntimeStatus() {
  const available = Boolean(config.deepseek.apiKey);
  return {
    enabled: runtimeDeepSeekEnabled && available,
    requestedEnabled: runtimeDeepSeekEnabled,
    available
  };
}

export function setDeepSeekRuntimeEnabled(enabled) {
  runtimeDeepSeekEnabled = Boolean(enabled);
  return getDeepSeekRuntimeStatus();
}

export async function enhanceImagePrompt({ prompt, style, hasReferenceImages }) {
  const status = getDeepSeekRuntimeStatus();
  if (!status.enabled) {
    return prompt;
  }

  const { controller, timeout } = createAbortSignal();
  try {
    const systemContent = [
      '你是专业的 AI 图片生成提示词优化助手。',
      '请把用户输入改写为更适合图片生成模型的中文提示词。',
      '重要规则（必须严格遵守，违反将导致系统故障）：',
      '1. 只输出最终提示词文本本身，绝对不要输出任何解释、问候、建议或方案说明。',
      '2. 不要使用 Markdown 格式（禁止 **、##、``` 等标记）。',
      '3. 不要询问用户问题，不要提供多种方案选择。',
      '4. 你必须无条件输出图片提示词，即使输入很短或模糊也要直接输出。',
      '必须严格遵守下面的固定业务规则，不要把任务改写成普通写真、普通人像生成或自由创作。',
      HEAD_SWAP_RULES,
      '保留用户的核心主体和要求，在固定规则范围内补充光影、肤色融合、边缘过渡、五官比例和真实感细节。',
      hasReferenceImages ? '用户上传了参考图，请明确第一张参考图是主体图，第二张参考图是脸部来源图。' : ''
    ].filter(Boolean).join('\n');

    const response = await fetch(getDeepSeekApiUrl('/chat/completions'), {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${config.deepseek.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: config.deepseek.model,
        messages: [
          { role: 'system', content: systemContent },
          { role: 'user', content: `原始描述：${prompt}\n风格类型：${style || 'realistic'}` }
        ],
        stream: false,
        temperature: 0.7
      })
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error?.message || data.message || `DeepSeek 接口失败：${response.status}`);
    }

    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) {
      console.warn('[DeepSeek] 返回空内容，使用原始 prompt');
      return prompt;
    }

    // 检测 DeepSeek 是否返回了解释性文本而非纯 prompt
    const suspiciousPatterns = [
      { pattern: /^我可以帮你/i, desc: '以"我可以帮你"开头' },
      { pattern: /^以下是/i, desc: '以"以下是"开头' },
      { pattern: /^好的[，,]/i, desc: '以"好的"开头' },
      { pattern: /\*\*[^*]+\*\*/, desc: '包含 Markdown 加粗 **' },
      { pattern: /^#{1,3}\s/m, desc: '包含 Markdown 标题' },
      { pattern: /你更想要|你更喜欢|你希望|你选择/, desc: '包含询问用户倾向' },
      { pattern: /方案[一二三]|选项[一二三]/, desc: '包含多方案选择' }
    ];

    const hit = suspiciousPatterns.find(({ pattern }) => pattern.test(content));
    if (hit) {
      console.warn(`[DeepSeek] 返回内容疑似解释性文本（${hit.desc}），已回退到原始 prompt。DeepSeek 原文前 300 字符:`, content.slice(0, 300));
      return prompt;
    }

    console.log(`[DeepSeek] 优化后 prompt 长度: ${content.length} 字符`);
    return content;
  } finally {
    clearTimeout(timeout);
  }
}
