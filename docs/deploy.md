# 部署说明

## 开发环境

后端：

```bash
cd server
npm install
cp .env.example .env
npm run dev
```

浏览器访问后端地址（默认 `http://127.0.0.1:3000`）即可打开网页 Demo。

## 生产环境注意事项

- 不要把 `server/.env` 提交到代码仓库。
- 将 `MODEL_MOCK` 设置为 `false`，并配置真实 `MODEL_API_KEY`。
- 网页登录账号密码在 `server/src/config.js` 的 `auth` 中配置；可按需修改并重新部署。
- `server/uploads` 和 `server/data` 当前是本地存储，生产环境建议替换为云存储和数据库。
- 图片生成接口可能耗时较长，生产环境建议使用队列或云函数异步任务。
