# 后端接口说明

后端默认地址：`http://127.0.0.1:3000`

## 健康检查

`GET /api/health`

返回：

```json
{
  "success": true,
  "data": {
    "status": "ok",
    "mock": true,
    "imageModelDefault": "gpt-image-2",
    "imageModelOptions": ["gpt-image-2", "nano-banana"]
  }
}
```

## 上传参考图

`POST /api/upload`

表单字段：

- `file`：单张图片文件，兼容旧调用方式，最大 5MB
- `files`：多张图片文件，最多 4 张，每张最大 5MB

返回：

```json
{
  "success": true,
  "data": {
    "filename": "xxx.jpg",
    "url": "/uploads/references/xxx.jpg",
    "files": [
      {
        "filename": "xxx.jpg",
        "url": "/uploads/references/xxx.jpg"
      }
    ]
  }
}
```

## 创建生成任务

`POST /api/generate`

请求：

```json
{
  "prompt": "一只穿宇航服的橘猫站在月球上",
  "style": "realistic",
  "size": "1024x1024",
  "referenceImages": [
    "/uploads/references/xxx-1.jpg",
    "/uploads/references/xxx-2.jpg"
  ],
  "imageModel": "gpt-image-2"
}
```

`imageModel` 可选；不传则使用服务端配置的默认模型（`MODEL_IMAGE_MODEL`）。取值须在服务端允许列表内（见 `GET /api/health` 的 `imageModelOptions`）。

返回：

```json
{
  "success": true,
  "data": {
    "id": "task-id",
    "status": "processing",
    "imageUrl": ""
  }
}
```

## 查询任务

`GET /api/tasks/:id`

任务状态：

- `processing`：生成中
- `succeeded`：生成成功
- `failed`：生成失败

## 历史记录

`GET /api/history`

返回最近 30 条生成任务。
