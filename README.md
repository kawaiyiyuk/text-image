# 图文生图 Demo

这是一个用于验证大模型图片 API 的最小可用项目：

- 网页 Demo：直接访问后端首页即可使用
- 后端：Node.js / Express
- 功能：输入文字描述、选择风格和尺寸、上传参考图、创建生成任务、查看结果和历史记录

## 目录结构

```text
.
├── web/                   # 网页前端（静态资源，由后端托管）
├── server/                # Node.js 后端服务
└── docs/                  # 接口和部署说明
```

## 本地运行

1. 安装后端依赖：

```bash
cd server
npm install
```

2. 创建后端环境变量：

```bash
cp .env.example .env
```

默认 `MODEL_MOCK=true`，不需要真实模型 Key，也能生成一张 mock 图片用于页面联调。

3. 启动后端：

```bash
npm run dev
```

4. 打开网页 Demo：

```text
http://127.0.0.1:3000
```

默认 `MODEL_MOCK=true`，会生成一张 mock 图片，适合先检查页面和接口流程。

## 接入真实模型

修改 `server/.env`：

```env
MODEL_MOCK=false
MODEL_API_KEY=你的模型 API Key
MODEL_API_BASE=https://proaiapi.tech/v1
MODEL_IMAGE_MODEL=gpt-image-2
# 可选：逗号分隔的允许切换的 model 列表；不设则默认可选 gpt-image-2、nano-banana（同一 KEY / BASE）
# MODEL_IMAGE_MODEL_OPTIONS=gpt-image-2,nano-banana
# 哪些模型走 Chat Completions 生图（不设则默认 nano-banana）；gpt-image-2 仍用 images 接口
# MODEL_IMAGE_VIA_CHAT_MODELS=nano-banana
MODEL_IMAGE_N=1
MODEL_RESPONSE_FORMAT=url
MODEL_TIMEOUT_MS=300000
```

当前后端按你提供的接口文档封装：

- 没有参考图时，调用 `POST /v1/images/generations`
- 上传参考图时，调用 `POST /v1/images/edits`，用 `multipart/form-data` 传一张或多张 `image` 文件和 `prompt`
- `response_format` 支持 `b64_json` 或 `url`
- `MODEL_API_BASE` 可以填根域名或带 `/v1` 的地址，后端会自动拼接正确接口路径。
- 外部模型接口只提交文档示例里的 `model`、`prompt`、`n`、`response_format`，网页里的尺寸选择只作为本地任务记录保留。

注意：当前后端参考图最多 4 张，单张 5MB，和文档里的上传限制保持一致。

如果要测试真实 API，请确认：

- `MODEL_MOCK=false`
- `MODEL_API_KEY` 已填写
- `MODEL_API_BASE` 和 `MODEL_IMAGE_MODEL` 与你的模型厂商一致
- 后端控制台没有模型接口报错

## 接入 DeepSeek 优化提示词

DeepSeek 官方 API 是文本/对话模型接口，端点是 `POST /chat/completions`，不提供图片生成接口。因此本项目把 DeepSeek 作为“提示词优化层”使用：

```text
用户输入 -> DeepSeek 优化提示词 -> 图片模型生成图片
```

修改 `server/.env`：

```env
DEEPSEEK_ENABLED=true
DEEPSEEK_API_BASE=https://api.deepseek.com
DEEPSEEK_API_KEY=你的 DeepSeek API Key
DEEPSEEK_MODEL=deepseek-v4-flash
DEEPSEEK_TIMEOUT_MS=60000
```

如果不想使用 DeepSeek，保持 `DEEPSEEK_ENABLED=false` 即可。
