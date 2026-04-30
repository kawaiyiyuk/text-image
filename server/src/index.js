import express from 'express';
import cors from 'cors';
import multer, { MulterError } from 'multer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { config } from './config.js';
import { createAuth } from './auth.js';
import { generateImage } from './services/modelService.js';
import { TaskStore } from './storage/taskStore.js';

const app = express();
// 置于 Nginx 等反向代理之后时，在 .env 设置 TRUST_PROXY=1，便于 Express 正确识别协议与连接信息
const trustProxyEnv = process.env.TRUST_PROXY;
if (trustProxyEnv === '1' || trustProxyEnv === 'true') {
  app.set('trust proxy', 1);
}
const auth = createAuth(config);
const taskStore = new TaskStore(config.dataDir);

const referenceDir = path.join(config.uploadDir, 'references');
async function localUploadExists(imageUrl) {
  if (!imageUrl || !imageUrl.startsWith('/uploads/')) {
    return true;
  }
  const filePath = path.join(config.uploadDir, imageUrl.replace(/^\/uploads\//, ''));
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function normalizeTaskForClient(task) {
  if (!task?.imageUrl || (await localUploadExists(task.imageUrl))) {
    return task;
  }
  return {
    ...task,
    imageUrl: '',
    error: task.error || '本地生成图片文件不存在，请重新生成'
  };
}

function getExtensionFromContentType(contentType = '') {
  if (contentType.includes('png')) {
    return '.png';
  }
  if (contentType.includes('webp')) {
    return '.webp';
  }
  return '.jpg';
}

function resolveImageModelForRequest(body, fallbackModel) {
  const raw = body?.imageModel;
  const trimmed = raw != null ? String(raw).trim() : '';
  const model = trimmed || fallbackModel;
  if (!config.model.imageModelOptions.includes(model)) {
    return {
      error: `图片模型无效，可选：${config.model.imageModelOptions.join('、')}`
    };
  }
  return { model };
}

async function materializeImageForEdit(imageUrl, taskId) {
  if (!imageUrl) {
    throw new Error('上一轮任务没有可用于继续调整的图片');
  }

  if (imageUrl.startsWith('/uploads/')) {
    if (!(await localUploadExists(imageUrl))) {
      throw new Error('上一轮本地图片文件不存在，无法继续调整');
    }
    return imageUrl;
  }

  if (!/^https?:\/\//.test(imageUrl)) {
    throw new Error('上一轮图片地址格式不支持');
  }

  const response = await fetch(imageUrl);
  if (!response.ok) {
    throw new Error(`下载上一轮图片失败：${response.status}`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.startsWith('image/')) {
    throw new Error('上一轮结果不是可用的图片文件');
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.mkdir(referenceDir, { recursive: true });
  const fileName = `refine-${taskId}${getExtensionFromContentType(contentType)}`;
  await fs.writeFile(path.join(referenceDir, fileName), buffer);
  return `/uploads/references/${fileName}`;
}

function runImageTask(task) {
  generateImage(task)
    .then((result) => {
      const imageUrl = typeof result === 'string' ? result : result.imageUrl;
      return taskStore.update(task.id, {
        status: 'succeeded',
        imageUrl,
        enhancedPrompt: result.enhancedPrompt || '',
        error: ''
      });
    })
    .catch((error) => {
      return taskStore.update(task.id, {
        status: 'failed',
        error: error.message || '图片生成失败'
      });
    });
}

const upload = multer({
  storage: multer.diskStorage({
    destination: async (req, file, callback) => {
      try {
        await fs.mkdir(referenceDir, { recursive: true });
        callback(null, referenceDir);
      } catch (error) {
        callback(error);
      }
    },
    filename: (req, file, callback) => {
      const ext = path.extname(file.originalname || '') || '.jpg';
      callback(null, `${Date.now()}-${uuidv4()}${ext}`);
    }
  }),
  limits: {
    fileSize: 5 * 1024 * 1024
  },
  fileFilter: (req, file, callback) => {
    if (!file.mimetype.startsWith('image/')) {
      callback(new Error('只支持上传图片文件'));
      return;
    }
    callback(null, true);
  }
});

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use('/uploads', express.static(config.uploadDir));
app.use(express.static(config.webDir, {
  setHeaders(res) {
    res.setHeader('Cache-Control', 'no-store');
  }
}));

app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    data: {
      status: 'ok',
      mock: config.model.mock,
      deepseekEnabled: config.deepseek.enabled,
      deepseekModel: config.deepseek.model,
      imageModelDefault: config.model.imageModel,
      imageModelOptions: config.model.imageModelOptions,
      imageModelsViaChat: config.model.imageModelsViaChat
    }
  });
});

app.get('/api/auth/status', (req, res) => {
  res.json({
    success: true,
    data: {
      authRequired: auth.enabled
    }
  });
});

app.post('/api/login', auth.loginHandler);

app.post('/api/upload', auth.middleware, upload.fields([
  { name: 'file', maxCount: 4 },
  { name: 'files', maxCount: 4 }
]), (req, res) => {
  const files = [
    ...(req.files?.file || []),
    ...(req.files?.files || [])
  ].slice(0, 4);

  if (files.length === 0) {
    res.status(400).json({
      success: false,
      message: '请选择要上传的图片'
    });
    return;
  }

  const uploadedFiles = files.map((file) => ({
    filename: file.filename,
    url: `/uploads/references/${file.filename}`
  }));

  res.json({
    success: true,
    data: {
      ...uploadedFiles[0],
      files: uploadedFiles
    }
  });
});

app.post('/api/generate', auth.middleware, async (req, res) => {
  const { prompt, style = 'realistic', size = '1024x1024', referenceImages = [] } = req.body || {};
  if (!prompt || !String(prompt).trim()) {
    res.status(400).json({
      success: false,
      message: '请填写图片描述'
    });
    return;
  }

  const resolved = resolveImageModelForRequest(req.body, config.model.imageModel);
  if (resolved.error) {
    res.status(400).json({
      success: false,
      message: resolved.error
    });
    return;
  }

  const now = new Date().toISOString();
  const task = await taskStore.create({
    id: uuidv4(),
    prompt: String(prompt).trim(),
    style,
    size,
    imageModel: resolved.model,
    referenceImages: Array.isArray(referenceImages) ? referenceImages : [],
    status: 'processing',
    imageUrl: '',
    enhancedPrompt: '',
    error: '',
    createdAt: now,
    updatedAt: now
  });

  res.status(202).json({
    success: true,
    data: task
  });

  runImageTask(task);
});

app.post('/api/refine', auth.middleware, async (req, res) => {
  const { taskId, feedback } = req.body || {};
  if (!taskId || !String(feedback || '').trim()) {
    res.status(400).json({
      success: false,
      message: '请提供上一轮任务 ID 和调整意见'
    });
    return;
  }

  const previousTask = await taskStore.get(taskId);
  if (!previousTask) {
    res.status(404).json({
      success: false,
      message: '上一轮任务不存在'
    });
    return;
  }

  if (previousTask.status !== 'succeeded' || !previousTask.imageUrl) {
    res.status(400).json({
      success: false,
      message: '只有生成成功的任务才能继续调整'
    });
    return;
  }

  const fallbackModel = previousTask.imageModel || config.model.imageModel;
  const resolved = resolveImageModelForRequest(req.body, fallbackModel);
  if (resolved.error) {
    res.status(400).json({
      success: false,
      message: resolved.error
    });
    return;
  }

  const id = uuidv4();
  const previousResultImage = await materializeImageForEdit(previousTask.imageUrl, id);
  const faceReferenceImages = Array.isArray(previousTask.referenceImages)
    ? previousTask.referenceImages.slice(1)
    : [];
  const now = new Date().toISOString();
  const task = await taskStore.create({
    id,
    conversationId: previousTask.conversationId || previousTask.id,
    parentTaskId: previousTask.id,
    prompt: [
      previousTask.prompt,
      `继续调整意见：${String(feedback).trim()}`,
      '这是基于上一轮结果的继续微调，请尽量保留上一轮结果的构图、人物姿态、服装、背景和整体风格，只根据调整意见做局部修正。'
    ].join('\n'),
    feedback: String(feedback).trim(),
    style: previousTask.style || 'realistic',
    size: previousTask.size || '1024x1024',
    imageModel: resolved.model,
    referenceImages: [previousResultImage, ...faceReferenceImages].slice(0, 4),
    status: 'processing',
    imageUrl: '',
    enhancedPrompt: '',
    error: '',
    createdAt: now,
    updatedAt: now
  });

  res.status(202).json({
    success: true,
    data: task
  });

  runImageTask(task);
});

app.get('/api/tasks/:id', auth.middleware, async (req, res) => {
  const task = await taskStore.get(req.params.id);
  if (!task) {
    res.status(404).json({
      success: false,
      message: '任务不存在'
    });
    return;
  }

  res.json({
    success: true,
    data: await normalizeTaskForClient(task)
  });
});

app.get('/api/history', auth.middleware, async (req, res) => {
  const tasks = await taskStore.list();
  res.json({
    success: true,
    data: await Promise.all(tasks.map((task) => normalizeTaskForClient(task)))
  });
});

app.use((error, req, res, next) => {
  console.error(error);
  if (error instanceof MulterError && error.code === 'LIMIT_FILE_SIZE') {
    res.status(413).json({
      success: false,
      message: '参考图单张不能超过 5MB，请压缩后再上传'
    });
    return;
  }

  res.status(500).json({
    success: false,
    message: error.message || '服务器内部错误'
  });
});

async function start() {
  await fs.mkdir(path.join(config.uploadDir, 'generated'), { recursive: true });
  await fs.mkdir(referenceDir, { recursive: true });
  app.listen(config.port, () => {
    console.log(`Server running at ${config.publicBaseUrl}`);
    console.log(`Web demo: ${config.publicBaseUrl}`);
    console.log(`Model mock mode: ${config.model.mock}`);
  });
}

start();
