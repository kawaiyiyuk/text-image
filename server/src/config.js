import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const defaultImageModel = process.env.MODEL_IMAGE_MODEL || 'gpt-image-2';
const imageModelOptionsRaw = process.env.MODEL_IMAGE_MODEL_OPTIONS;
let imageModelOptions = imageModelOptionsRaw
  ? imageModelOptionsRaw.split(',').map((s) => s.trim()).filter(Boolean)
  : ['gpt-image-2', 'nano-banana'];
if (!imageModelOptions.includes(defaultImageModel)) {
  imageModelOptions = [defaultImageModel, ...imageModelOptions.filter((m) => m !== defaultImageModel)];
}

const imageViaChatRaw = process.env.MODEL_IMAGE_VIA_CHAT_MODELS;
const imageModelsViaChat = imageViaChatRaw
  ? imageViaChatRaw.split(',').map((s) => s.trim()).filter(Boolean)
  : ['nano-banana'];

export const config = {
  port: Number(process.env.PORT || 3000),
  publicBaseUrl: process.env.PUBLIC_BASE_URL || 'http://127.0.0.1:3000',
  rootDir,
  webDir: path.resolve(rootDir, '..', 'web'),
  uploadDir: path.join(rootDir, 'uploads'),
  dataDir: path.join(rootDir, 'data'),
  model: {
    mock: process.env.MODEL_MOCK !== 'false' || !process.env.MODEL_API_KEY,
    provider: process.env.MODEL_PROVIDER || 'openai',
    apiBase: process.env.MODEL_API_BASE || 'https://proaiapi.tech/v1',
    apiKey: process.env.MODEL_API_KEY || '',
    imageModel: defaultImageModel,
    imageModelOptions,
    /** 这些模型走 /v1/chat/completions（与 images/generations 不同） */
    imageModelsViaChat,
    imageCount: Number(process.env.MODEL_IMAGE_N || 1),
    responseFormat: process.env.MODEL_RESPONSE_FORMAT || 'url',
    timeoutMs: Number(process.env.MODEL_TIMEOUT_MS || 300000)
  },
  deepseek: {
    enabled: process.env.DEEPSEEK_ENABLED === 'true' && Boolean(process.env.DEEPSEEK_API_KEY),
    apiBase: process.env.DEEPSEEK_API_BASE || 'https://api.deepseek.com',
    apiKey: process.env.DEEPSEEK_API_KEY || '',
    model: process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash',
    timeoutMs: Number(process.env.DEEPSEEK_TIMEOUT_MS || 60000)
  },
  /** 网页登录固定账号（写死在配置中，生产环境请自行评估风险） */
  auth: {
    username: 'wanghaiou',
    password: 'wanghaiou891111',
    tokenTtlMs: Number(process.env.AUTH_TOKEN_TTL_MS || 7 * 24 * 60 * 60 * 1000)
  }
};
