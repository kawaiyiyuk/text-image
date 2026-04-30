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

export async function enhanceImagePrompt({ prompt, style, hasReferenceImages }) {
  if (!config.deepseek.enabled) {
    return prompt;
  }

  const { controller, timeout } = createAbortSignal();
  try {
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
          {
            role: 'system',
            content: [
              '你是专业的 AI 图片生成提示词优化助手。',
              '请把用户输入改写为更适合图片生成模型的中文提示词。',
              '只输出最终提示词，不要解释，不要使用 Markdown。',
              '必须严格遵守下面的固定业务规则，不要把任务改写成普通写真、普通人像生成或自由创作。',
              HEAD_SWAP_RULES,
              '保留用户的核心主体和要求，在固定规则范围内补充光影、肤色融合、边缘过渡、五官比例和真实感细节。',
              hasReferenceImages ? '用户上传了参考图，请明确第一张参考图是主体图，第二张参考图是脸部来源图。' : ''
            ].filter(Boolean).join('\n')
          },
          {
            role: 'user',
            content: `原始描述：${prompt}\n风格类型：${style || 'realistic'}`
          }
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
    return content || prompt;
  } finally {
    clearTimeout(timeout);
  }
}
