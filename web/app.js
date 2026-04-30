const form = document.querySelector('#generateForm');
const promptInput = document.querySelector('#prompt');
const styleInput = document.querySelector('#style');
const sizeInput = document.querySelector('#size');
const imageCountInput = document.querySelector('#imageCount');
const imageModelInput = document.querySelector('#imageModel');
const referenceInput = document.querySelector('#referenceImage');
const referencePreview = document.querySelector('#referencePreview');
const submitButton = document.querySelector('#submitButton');
const message = document.querySelector('#message');
const statusTitle = document.querySelector('#statusTitle');
const preview = document.querySelector('#preview');
const openImage = document.querySelector('#openImage');
const hdImage = document.querySelector('#hdImage');
const enhancedPromptText = document.querySelector('#enhancedPromptText');
const refineFeedback = document.querySelector('#refineFeedback');
const refineButton = document.querySelector('#refineButton');
const refineImageHint = document.querySelector('#refineImageHint');
const historyList = document.querySelector('#historyList');
const refreshHistory = document.querySelector('#refreshHistory');
const loginGate = document.querySelector('#loginGate');
const loginUsername = document.querySelector('#loginUsername');
const loginPassword = document.querySelector('#loginPassword');
const loginError = document.querySelector('#loginError');
const loginSubmit = document.querySelector('#loginSubmit');
const loginHint = document.querySelector('#loginHint');
const deepseekToggle = document.querySelector('#deepseekToggle');
const deepseekToggleHint = document.querySelector('#deepseekToggleHint');
const deepseekStatusChip = document.querySelector('#deepseekStatusChip');
const referenceField = referencePreview?.closest('.field') || null;

let pollingTimer = null;
let referencePreviewUrls = [];
let selectedFiles = [];
let currentTask = null;
let selectedRefineImageUrl = '';
let isPreviewZoomed = false;
const MAX_REFERENCE_FILE_SIZE = 5 * 1024 * 1024;
const MAX_REFERENCE_COUNT = 4;
const AUTH_STORAGE_KEY = 'textImagesAuthToken';
const AUTH_EXPIRES_IN_MS = 7 * 24 * 60 * 60 * 1000;
const IMAGE_COUNT_OPTIONS = new Set([1, 2, 4, 8]);
let selectedHistoryTaskId = '';

function getAuthToken() {
  const raw = localStorage.getItem(AUTH_STORAGE_KEY);
  if (!raw) {
    return '';
  }

  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.token === 'string') {
      if (parsed.expiresAt && Number(parsed.expiresAt) > Date.now()) {
        return parsed.token;
      }
      localStorage.removeItem(AUTH_STORAGE_KEY);
      return '';
    }
  } catch {
    // 兼容历史纯字符串 token 格式：迁移到新格式并设置 7 天有效期
    const legacyToken = raw.trim();
    if (legacyToken) {
      setAuthToken(legacyToken);
      return legacyToken;
    }
  }

  localStorage.removeItem(AUTH_STORAGE_KEY);
  return '';
}

function normalizeExpiresAt(expiresAt, tokenTtlMs) {
  const expiresAtNum = Number(expiresAt);
  if (Number.isFinite(expiresAtNum) && expiresAtNum > Date.now()) {
    return expiresAtNum;
  }
  const ttlNum = Number(tokenTtlMs);
  if (Number.isFinite(ttlNum) && ttlNum > 0) {
    return Date.now() + ttlNum;
  }
  return Date.now() + AUTH_EXPIRES_IN_MS;
}

function setAuthToken(token, options = {}) {
  if (token) {
    const expiresAt = normalizeExpiresAt(options.expiresAt, options.tokenTtlMs);
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({
      token,
      expiresAt
    }));
  } else {
    localStorage.removeItem(AUTH_STORAGE_KEY);
  }
}

function setLoginGateVisible(visible, hintText) {
  if (!loginGate) {
    return;
  }
  if (visible) {
    loginGate.classList.remove('hidden');
    loginGate.setAttribute('aria-hidden', 'false');
    if (hintText && loginHint) {
      loginHint.textContent = hintText;
    }
    if (loginError) {
      loginError.textContent = '';
      loginError.hidden = true;
    }
    requestAnimationFrame(() => {
      if (loginUsername && !(loginUsername.value || '').trim()) {
        loginUsername.focus();
      } else {
        loginPassword?.focus();
      }
    });
  } else {
    loginGate.classList.add('hidden');
    loginGate.setAttribute('aria-hidden', 'true');
  }
}

function showLoginRequired(message) {
  setAuthToken('');
  setLoginGateVisible(true, message || '请重新登录。');
}

function setMessage(text, isError = false) {
  message.textContent = text;
  message.classList.toggle('error', isError);
}

function clearReferencePreviewUrls() {
  referencePreviewUrls.forEach((url) => URL.revokeObjectURL(url));
  referencePreviewUrls = [];
}

function updateRefCount() {
  const el = document.querySelector('#refCount');
  if (el) {
    el.textContent = selectedFiles.length > 0 ? `(${selectedFiles.length}/4)` : '(可选)';
  }
}

function removeFile(index) {
  selectedFiles = selectedFiles.filter((_, i) => i !== index);
  renderReferencePreview();
}

function addReferenceFiles(incomingFiles, sourceLabel = '选择') {
  const files = Array.from(incomingFiles || []);
  if (files.length === 0) {
    return;
  }

  const imageFiles = files.filter((file) => file && /^image\//.test(file.type || ''));
  if (imageFiles.length === 0) {
    setMessage('仅支持添加图片文件', true);
    return;
  }

  const remaining = MAX_REFERENCE_COUNT - selectedFiles.length;
  if (remaining <= 0) {
    setMessage(`最多只能添加 ${MAX_REFERENCE_COUNT} 张参考图`, true);
    return;
  }

  const acceptedFiles = imageFiles.slice(0, remaining);
  selectedFiles = [...selectedFiles, ...acceptedFiles];
  renderReferencePreview();

  if (imageFiles.length > remaining) {
    setMessage(`最多只能添加 ${MAX_REFERENCE_COUNT} 张参考图，已自动忽略超出部分`, true);
  } else if (sourceLabel === '粘贴') {
    setMessage(`已通过${sourceLabel}添加 ${acceptedFiles.length} 张参考图`);
  }
}

function shouldHandlePasteForReference(event) {
  if (!referenceField) {
    return false;
  }
  const target = event.target;
  if (target instanceof Element && referenceField.contains(target)) {
    return true;
  }
  if (document.activeElement instanceof Element && referenceField.contains(document.activeElement)) {
    return true;
  }
  return referenceField.matches(':hover');
}

function renderReferencePreview() {
  clearReferencePreviewUrls();

  const emptyHint = selectedFiles.length === 0 ? '<p class="hint">还没有选择参考图</p>' : '';
  const items = selectedFiles
    .map((file, index) => {
      const url = URL.createObjectURL(file);
      referencePreviewUrls.push(url);
      const sizeMb = (file.size / 1024 / 1024).toFixed(2);
      return `<figure class="reference-item">
        <img src="${url}" alt="参考图 ${index + 1}" />
        <button type="button" class="ref-delete" data-index="${index}" title="删除此图">&times;</button>
        <figcaption>${index + 1}. ${sizeMb}MB</figcaption>
      </figure>`;
    })
    .join('');

  const addBtn = selectedFiles.length < MAX_REFERENCE_COUNT
    ? `<button type="button" class="ref-add" id="refAddBtn"><span>+</span><span>${selectedFiles.length === 0 ? '添加参考图' : '继续添加'}</span></button>`
    : '';

  referencePreview.innerHTML = emptyHint + items + addBtn;

  // bind events
  referencePreview.querySelectorAll('.ref-delete').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      removeFile(Number(btn.dataset.index));
    });
  });

  const addBtnEl = referencePreview.querySelector('#refAddBtn');
  if (addBtnEl) {
    addBtnEl.addEventListener('click', (e) => {
      e.preventDefault();
      referenceInput.click();
    });
  }

  updateRefCount();
}

function formatImageUrl(url) {
  if (!url) {
    return '';
  }
  if (/^https?:\/\//.test(url)) {
    return url;
  }
  return url;
}

function getTaskImageUrls(task) {
  const fromArray = Array.isArray(task?.imageUrls)
    ? task.imageUrls.map((url) => formatImageUrl(url)).filter(Boolean)
    : [];
  if (fromArray.length > 0) {
    return fromArray;
  }
  const single = formatImageUrl(task?.imageUrl);
  return single ? [single] : [];
}

function updateRefineImageHint(task, selectedUrl = '') {
  if (!refineImageHint) {
    return;
  }
  const urls = getTaskImageUrls(task);
  if (urls.length === 0) {
    refineImageHint.textContent = '当前无可用于继续调整的图片。';
    return;
  }
  if (urls.length === 1) {
    refineImageHint.textContent = '当前只有 1 张图片，将基于该图继续调整。';
    return;
  }
  const selectedIndex = urls.findIndex((url) => url === selectedUrl);
  if (selectedIndex >= 0) {
    refineImageHint.textContent = `已选择第 ${selectedIndex + 1} 张作为继续调整基准图。`;
  } else {
    refineImageHint.textContent = `当前有 ${urls.length} 张图片，请先点击选中一张再继续调整。`;
  }
}

function updateRefineButtonText(task, selectedUrl = '') {
  if (!refineButton) {
    return;
  }
  const urls = getTaskImageUrls(task);
  if (urls.length <= 1) {
    refineButton.textContent = '基于当前结果继续调整';
    return;
  }
  const selectedIndex = urls.findIndex((url) => url === selectedUrl);
  if (selectedIndex >= 0) {
    refineButton.textContent = `基于第 ${selectedIndex + 1} 张继续调整`;
    return;
  }
  refineButton.textContent = '请先选择一张图片再继续调整';
}

function selectPreviewImageByIndex(index) {
  if (!currentTask) {
    return false;
  }
  const urls = getTaskImageUrls(currentTask);
  if (urls.length <= 1) {
    return false;
  }
  if (index < 0 || index >= urls.length) {
    return false;
  }
  const targetUrl = urls[index];
  const targetImg = preview.querySelector(`img.selectable[data-image-url="${CSS.escape(targetUrl)}"]`);
  if (!targetImg) {
    return false;
  }
  selectedRefineImageUrl = targetUrl;
  preview.querySelectorAll('img.selectable').forEach((n) => n.classList.remove('selected'));
  targetImg.classList.add('selected');
  updateRefineImageHint(currentTask, selectedRefineImageUrl);
  updateRefineButtonText(currentTask, selectedRefineImageUrl);
  setMessage(`已通过快捷键选择第 ${index + 1} 张图片`);
  return true;
}

function selectPreviewImageByStep(step) {
  if (!currentTask) {
    return false;
  }
  const urls = getTaskImageUrls(currentTask);
  if (urls.length <= 1) {
    return false;
  }
  const currentIndex = Math.max(0, urls.findIndex((url) => url === selectedRefineImageUrl));
  const nextIndex = (currentIndex + step + urls.length) % urls.length;
  return selectPreviewImageByIndex(nextIndex);
}

function resolveTaskImageCount(task) {
  const n = Number(task?.imageCount);
  if (IMAGE_COUNT_OPTIONS.has(n)) {
    return n;
  }
  const fromUrls = getTaskImageUrls(task).length;
  if (IMAGE_COUNT_OPTIONS.has(fromUrls)) {
    return fromUrls;
  }
  return 1;
}

async function request(path, options = {}) {
  const { headers: optionHeaders, ...rest } = options;
  const token = getAuthToken();
  const res = await fetch(path, {
    ...rest,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(optionHeaders || {})
    }
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    showLoginRequired(data.message || '登录已失效，请重新登录。');
    throw new Error(data.message || '请重新登录');
  }
  if (!res.ok || data.success === false) {
    throw new Error(data.message || `请求失败：${res.status}`);
  }
  return data;
}

async function uploadReferenceImages(files) {
  const oversizedFile = files.find((file) => file.size > MAX_REFERENCE_FILE_SIZE);
  if (oversizedFile) {
    const sizeMb = (oversizedFile.size / 1024 / 1024).toFixed(2);
    throw new Error(`参考图「${oversizedFile.name}」为 ${sizeMb}MB，单张不能超过 5MB`);
  }

  const formData = new FormData();
  files.forEach((file) => {
    formData.append('files', file);
  });
  const token = getAuthToken();
  const res = await fetch('/api/upload', {
    method: 'POST',
    body: formData,
    headers: token ? { Authorization: `Bearer ${token}` } : {}
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    showLoginRequired(data.message || '登录已失效，请重新登录。');
    throw new Error(data.message || '请重新登录');
  }
  if (!res.ok || data.success === false) {
    throw new Error(data.message || '参考图上传失败');
  }
  return (data.data.files || [data.data]).map((file) => file.url).filter(Boolean);
}

async function ensureWebAuth() {
  const statusRes = await fetch('/api/auth/status');
  const statusJson = await statusRes.json().catch(() => ({}));
  if (!statusRes.ok || !statusJson.success || !statusJson.data?.authRequired) {
    setLoginGateVisible(false);
    return { blocked: false };
  }
  if (getAuthToken()) {
    setLoginGateVisible(false);
    return { blocked: false };
  }
  setLoginGateVisible(true, '请先登录。');
  return { blocked: true };
}

async function submitWebLogin() {
  if (!loginError || !loginSubmit) {
    return;
  }
  loginError.textContent = '';
  loginError.hidden = true;
  const username = (loginUsername?.value || '').trim();
  const password = (loginPassword?.value || '').trim();
  if (!username) {
    loginError.textContent = '请输入账号';
    loginError.hidden = false;
    return;
  }
  if (!password) {
    loginError.textContent = '请输入密码';
    loginError.hidden = false;
    return;
  }
  loginSubmit.disabled = true;
  try {
    const loginRes = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const loginData = await loginRes.json().catch(() => ({}));
    if (!loginRes.ok || loginData.success === false) {
      loginError.textContent = loginData.message || '登录失败';
      loginError.hidden = false;
      return;
    }
    if (loginData.data?.token) {
      setAuthToken(loginData.data.token, {
        expiresAt: loginData.data.expiresAt,
        tokenTtlMs: loginData.data.tokenTtlMs
      });
    }
    setLoginGateVisible(false);
    if (loginPassword) {
      loginPassword.value = '';
    }
    if (loginUsername) {
      loginUsername.value = '';
    }
    await loadDeepSeekStatus();
    loadHistory();
  } finally {
    loginSubmit.disabled = false;
  }
}

function renderPreview(task) {
  currentTask = task;
  enhancedPromptText.textContent = task.enhancedPrompt || '暂未返回优化后的提示词。';
  const targetCount = resolveTaskImageCount(task);
  preview.classList.remove('count-1', 'count-2', 'count-4', 'count-8');
  preview.classList.add(`count-${targetCount}`);
  const imageUrls = getTaskImageUrls(task);
  if (imageUrls.length === 0) {
    selectedRefineImageUrl = '';
    updateRefineImageHint(task);
    updateRefineButtonText(task, selectedRefineImageUrl);
    preview.classList.remove('zoomed');
    preview.classList.remove('multi', 'multi-many');
    preview.innerHTML = '<span>图片生成中，请稍候</span>';
    openImage.href = '#';
    openImage.classList.add('disabled');
    if (hdImage) {
      hdImage.disabled = true;
    }
    return;
  }
  if (imageUrls.length === 1) {
    selectedRefineImageUrl = imageUrls[0];
    updateRefineImageHint(task, selectedRefineImageUrl);
    updateRefineButtonText(task, selectedRefineImageUrl);
    preview.classList.remove('multi', 'multi-many');
    preview.classList.toggle('zoomed', isPreviewZoomed);
    preview.innerHTML = `<img class="selectable selected" data-image-url="${imageUrls[0]}" src="${imageUrls[0]}" alt="生成图片" />`;
  } else {
    if (!imageUrls.includes(selectedRefineImageUrl)) {
      selectedRefineImageUrl = imageUrls[0] || '';
    }
    updateRefineImageHint(task, selectedRefineImageUrl);
    updateRefineButtonText(task, selectedRefineImageUrl);
    const renderUrls = isPreviewZoomed ? [selectedRefineImageUrl] : imageUrls;
    preview.classList.toggle('zoomed', isPreviewZoomed);
    preview.classList.add('multi');
    preview.classList.toggle('multi-many', !isPreviewZoomed && targetCount === 8);
    preview.innerHTML = renderUrls
      .map((url, index) => {
        const badgeNumber = imageUrls.indexOf(url) + 1 || index + 1;
        return `<div class="preview-item"><img class="selectable ${url === selectedRefineImageUrl ? 'selected' : ''}" data-image-url="${url}" src="${url}" alt="生成图片 ${badgeNumber}" /><span class="preview-badge">#${badgeNumber}</span></div>`;
      })
      .join('');
  }
  preview.querySelectorAll('img.selectable').forEach((imgEl) => {
    imgEl.addEventListener('click', () => {
      const picked = imgEl.dataset.imageUrl || '';
      if (!picked) {
        return;
      }
      selectedRefineImageUrl = picked;
      preview.querySelectorAll('img.selectable').forEach((n) => n.classList.remove('selected'));
      imgEl.classList.add('selected');
      updateRefineImageHint(task, selectedRefineImageUrl);
      updateRefineButtonText(task, selectedRefineImageUrl);
    });
  });
  openImage.href = imageUrls[0];
  openImage.classList.remove('disabled');
  if (hdImage) {
    hdImage.disabled = false;
  }
}

function togglePreviewZoom() {
  const urls = currentTask ? getTaskImageUrls(currentTask) : [];
  if (urls.length === 0) {
    return false;
  }
  isPreviewZoomed = !isPreviewZoomed;
  renderPreview(currentTask);
  setMessage(isPreviewZoomed ? '已放大预览（按空格可还原）' : '已还原常规预览');
  return true;
}

function markSelectedHistoryItem() {
  historyList.querySelectorAll('.history-item').forEach((item) => {
    const isActive = item.dataset.taskId === selectedHistoryTaskId;
    item.classList.toggle('active', isActive);
    if (isActive) {
      item.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
    }
  });
}

async function createRefineTask(taskId, feedback, options = {}) {
  return request('/api/refine', {
    method: 'POST',
    body: JSON.stringify({
      taskId,
      feedback,
      baseImageUrl: options.baseImageUrl ?? selectedRefineImageUrl,
      imageCount: Number(options.imageCount ?? imageCountInput?.value ?? 1),
      size: options.size,
      ...(imageModelInput?.value ? { imageModel: imageModelInput.value } : {})
    })
  });
}

function getStatusText(status) {
  const map = {
    pending: '任务已创建',
    processing: '图片生成中',
    succeeded: '生成成功',
    failed: '生成失败'
  };
  return map[status] || '未知状态';
}

async function pollTask(taskId) {
  clearInterval(pollingTimer);
  pollingTimer = setInterval(async () => {
    try {
      const res = await request(`/api/tasks/${taskId}`);
      const task = res.data;
      statusTitle.textContent = getStatusText(task.status);
      renderPreview(task);

      if (task.status === 'succeeded' || task.status === 'failed') {
        clearInterval(pollingTimer);
        pollingTimer = null;
        setMessage(task.status === 'succeeded' ? '生成完成' : task.error || '生成失败', task.status === 'failed');
        loadHistory();
      }
    } catch (error) {
      clearInterval(pollingTimer);
      pollingTimer = null;
      setMessage(error.message, true);
    }
  }, 1800);
}

async function loadHistory() {
  try {
    const res = await request('/api/history');
    const tasks = res.data || [];
    if (tasks.length === 0) {
      historyList.innerHTML = '<p class="hint">暂无历史记录</p>';
      return;
    }
    historyList.innerHTML = tasks
      .map((task) => {
        const imageUrls = getTaskImageUrls(task);
        const thumb = imageUrls.length > 0
          ? `<div class="history-thumb-grid ${imageUrls.length === 1 ? 'single' : ''}">
              ${imageUrls.slice(0, 4).map((url, index) => `<img src="${url}" alt="历史图片 ${index + 1}" />`).join('')}
            </div>`
          : '<span>无图片</span>';
        const countText = imageUrls.length > 1 ? ` · ${imageUrls.length}张` : '';
        const requestedText = task.imageCount ? ` · 请求${task.imageCount}张` : '';
        return `<article class="history-item" data-task-id="${task.id}">
          <div class="history-thumb">${thumb}</div>
          <p class="history-prompt">${task.prompt}</p>
          <p class="history-meta">${getStatusText(task.status)} · ${task.imageModel || '默认模型'} · ${task.style || '默认'} · ${task.size || '1024x1024'}${requestedText}${countText}</p>
        </article>`;
      })
      .join('');

    historyList.querySelectorAll('.history-item').forEach((item, index) => {
      const task = tasks[index];
      if (!task) {
        return;
      }
      item.style.cursor = 'pointer';
      item.title = '点击加载此任务到右侧预览区';
      item.addEventListener('click', () => {
        selectedHistoryTaskId = task.id;
        markSelectedHistoryItem();
        statusTitle.textContent = getStatusText(task.status);
        renderPreview(task);
        window.scrollTo({ top: 0, behavior: 'smooth' });
        const count = getTaskImageUrls(task).length;
        if (task.status === 'failed') {
          setMessage(task.error || '该任务生成失败', true);
          return;
        }
        setMessage(count > 0 ? `已加载历史任务：${count} 张图片` : '已加载历史任务');
      });
    });
    markSelectedHistoryItem();
  } catch (error) {
    historyList.innerHTML = `<p class="hint">${error.message}</p>`;
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const prompt = promptInput.value.trim();
  if (!prompt) {
    setMessage('请先输入图片描述', true);
    return;
  }

  submitButton.disabled = true;
  submitButton.textContent = '正在创建任务';
  setMessage('正在提交生成任务');
  statusTitle.textContent = '创建任务中';
  preview.innerHTML = '<span>正在准备生成</span>';
  enhancedPromptText.textContent = '正在等待 DeepSeek 优化提示词';

  try {
    const referenceImages = [];
    if (selectedFiles.length) {
      setMessage(`正在上传 ${selectedFiles.length} 张参考图`);
      referenceImages.push(...(await uploadReferenceImages(selectedFiles)));
    }

    const res = await request('/api/generate', {
      method: 'POST',
      body: JSON.stringify({
        prompt,
        style: styleInput.value,
        size: sizeInput.value,
        imageCount: Number(imageCountInput?.value || 1),
        ...(imageModelInput?.value ? { imageModel: imageModelInput.value } : {}),
        referenceImages
      })
    });

    statusTitle.textContent = getStatusText(res.data.status);
    selectedHistoryTaskId = '';
    setMessage('任务已创建，正在等待模型返回图片');
    renderPreview(res.data);
    await pollTask(res.data.id);
  } catch (error) {
    statusTitle.textContent = '生成失败';
    setMessage(error.message, true);
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = '开始生成';
  }
});

refineButton.addEventListener('click', async () => {
  const feedback = refineFeedback.value.trim();
  if (!currentTask?.id || currentTask.status !== 'succeeded') {
    setMessage('请先等待当前图片生成成功，再继续调整', true);
    return;
  }
  if (!feedback) {
    setMessage('请填写继续调整意见', true);
    return;
  }
  const currentUrls = getTaskImageUrls(currentTask);
  if (currentUrls.length > 1 && !selectedRefineImageUrl) {
    setMessage('当前有多张图片，请先在右侧点击选中一张再继续调整', true);
    return;
  }

  refineButton.disabled = true;
  setMessage('正在创建继续调整任务');
  statusTitle.textContent = '继续调整中';
  preview.innerHTML = '<span>正在基于上一轮结果继续调整</span>';
  enhancedPromptText.textContent = '正在等待 DeepSeek 根据调整意见优化提示词';

  try {
    const res = await createRefineTask(currentTask.id, feedback);
    currentTask = res.data;
    selectedHistoryTaskId = '';
    refineFeedback.value = '';
    setMessage('继续调整任务已创建，正在等待模型返回图片');
    renderPreview(res.data);
    await pollTask(res.data.id);
  } catch (error) {
    statusTitle.textContent = '继续调整失败';
    setMessage(error.message, true);
  } finally {
    refineButton.disabled = false;
  }
});

hdImage?.addEventListener('click', async () => {
  if (!currentTask?.id || currentTask.status !== 'succeeded') {
    setMessage('请先等待当前图片生成成功，再生成高清图', true);
    return;
  }
  const urls = getTaskImageUrls(currentTask);
  if (urls.length === 0) {
    setMessage('当前任务没有可用于高清化的图片', true);
    return;
  }
  if (urls.length > 1 && !selectedRefineImageUrl) {
    setMessage('请先在右侧选择一张基准图，再生成高清图', true);
    return;
  }
  const baseImageUrl = selectedRefineImageUrl || urls[0];
  const hdFeedback = '请保持当前画面主体、构图和风格不变，仅提升分辨率与细节清晰度，输出 2K 高清版本。';
  hdImage.disabled = true;
  refineButton.disabled = true;
  setMessage('正在创建 2K 高清图任务');
  statusTitle.textContent = '高清图生成中';
  preview.innerHTML = '<span>正在生成 2K 高清图</span>';
  enhancedPromptText.textContent = '正在等待高清图任务返回结果';
  try {
    const res = await createRefineTask(currentTask.id, hdFeedback, {
      baseImageUrl,
      imageCount: 1,
      size: '2048x2048'
    });
    currentTask = res.data;
    selectedHistoryTaskId = '';
    setMessage('高清图任务已创建，正在等待模型返回图片');
    renderPreview(res.data);
    await pollTask(res.data.id);
  } catch (error) {
    statusTitle.textContent = '高清图生成失败';
    setMessage(error.message || '高清图生成失败', true);
  } finally {
    hdImage.disabled = false;
    refineButton.disabled = false;
  }
});

refreshHistory.addEventListener('click', loadHistory);

referenceInput.addEventListener('change', () => {
  const files = referenceInput.files || [];
  addReferenceFiles(files, '选择');
  referenceInput.value = '';
});

document.addEventListener('paste', (event) => {
  if (!shouldHandlePasteForReference(event)) {
    return;
  }

  const clipboardItems = Array.from(event.clipboardData?.items || []);
  if (clipboardItems.length === 0) {
    return;
  }

  const imageFiles = clipboardItems
    .filter((item) => item.kind === 'file' && /^image\//.test(item.type || ''))
    .map((item, index) => {
      const file = item.getAsFile();
      if (!file) {
        return null;
      }
      if (file.name) {
        return file;
      }
      const ext = (file.type || 'image/png').split('/')[1] || 'png';
      return new File([file], `pasted-image-${Date.now()}-${index}.${ext}`, { type: file.type || 'image/png' });
    })
    .filter(Boolean);

  if (imageFiles.length === 0) {
    setMessage('当前粘贴内容不是图片，请复制图片后再试', true);
    return;
  }

  event.preventDefault();
  addReferenceFiles(imageFiles, '粘贴');
});

document.addEventListener('keydown', (event) => {
  const active = document.activeElement;
  const inInput =
    active instanceof HTMLInputElement ||
    active instanceof HTMLTextAreaElement ||
    active instanceof HTMLSelectElement;
  const isRefineTextareaFocused = active === refineFeedback;

  if (inInput && !isRefineTextareaFocused) {
    return;
  }

  if (event.code === 'Space' && !inInput) {
    const ok = togglePreviewZoom();
    if (ok) {
      event.preventDefault();
    }
    return;
  }

  if (event.key === 'Enter') {
    const wantsSubmitFromTextarea = isRefineTextareaFocused && (event.metaKey || event.ctrlKey);
    const wantsSubmitDirectly = !inInput;
    if ((wantsSubmitFromTextarea || wantsSubmitDirectly) && !refineButton.disabled) {
      event.preventDefault();
      refineButton.click();
      return;
    }
  }

  const key = event.key;
  if (!/^[1-8]$/.test(key)) {
    if (key === 'ArrowLeft') {
      const ok = selectPreviewImageByStep(-1);
      if (ok) {
        event.preventDefault();
      }
    } else if (key === 'ArrowRight') {
      const ok = selectPreviewImageByStep(1);
      if (ok) {
        event.preventDefault();
      }
    }
    return;
  }
  const ok = selectPreviewImageByIndex(Number(key) - 1);
  if (ok) {
    event.preventDefault();
  }
});

preview.addEventListener('dblclick', () => {
  togglePreviewZoom();
});

renderReferencePreview();
updateRefineImageHint(null);
updateRefineButtonText(null);
if (hdImage) {
  hdImage.disabled = true;
}

loginSubmit?.addEventListener('click', () => {
  submitWebLogin();
});
loginUsername?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    submitWebLogin();
  }
});
loginPassword?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    submitWebLogin();
  }
});

deepseekToggle?.addEventListener('change', async () => {
  const target = Boolean(deepseekToggle.checked);
  deepseekToggle.disabled = true;
  try {
    await toggleDeepSeekEnabled(target);
    setMessage(target ? '已开启 DeepSeek 提示词优化' : '已关闭 DeepSeek 提示词优化');
  } catch (error) {
    setMessage(error.message || '切换 DeepSeek 状态失败', true);
    await loadDeepSeekStatus();
  } finally {
    deepseekToggle.disabled = false;
  }
});

async function loadImageModelOptionsFromHealth() {
  if (!imageModelInput) {
    return;
  }
  try {
    const res = await fetch('/api/health');
    const json = await res.json().catch(() => ({}));
    const opts = json.data?.imageModelOptions;
    const def = json.data?.imageModelDefault;
    if (!Array.isArray(opts) || opts.length === 0) {
      return;
    }
    imageModelInput.innerHTML = opts
      .map((id) => `<option value="${id}">${id}</option>`)
      .join('');
    if (def && opts.includes(def)) {
      imageModelInput.value = def;
    }
  } catch {
    /* 保留 HTML 中的静态选项 */
  }
}

function renderDeepSeekStatus(status) {
  if (!deepseekToggle || !deepseekToggleHint) {
    return;
  }
  const enabled = Boolean(status?.enabled);
  const requestedEnabled = Boolean(status?.requestedEnabled);
  const available = status?.available !== false;
  deepseekToggle.checked = requestedEnabled;
  deepseekToggle.disabled = !available;
  if (!available) {
    deepseekToggleHint.textContent = '当前未配置 DeepSeek API Key，无法启用提示词优化。';
    return;
  }
  deepseekToggleHint.textContent = enabled
    ? '已开启：生成前会先用 DeepSeek 优化提示词。'
    : '已关闭：直接使用原始提示词进行生成。';

  if (deepseekStatusChip) {
    deepseekStatusChip.classList.remove('on', 'off');
    if (!available) {
      deepseekStatusChip.textContent = '提示词优化状态：不可用（未配置 API Key）';
      deepseekStatusChip.classList.add('off');
    } else if (enabled) {
      deepseekStatusChip.textContent = '提示词优化状态：已开启';
      deepseekStatusChip.classList.add('on');
    } else {
      deepseekStatusChip.textContent = '提示词优化状态：已关闭';
      deepseekStatusChip.classList.add('off');
    }
  }
}

async function loadDeepSeekStatus() {
  if (!deepseekToggle || !deepseekToggleHint) {
    return;
  }
  try {
    const res = await request('/api/deepseek/status');
    renderDeepSeekStatus(res.data || {});
  } catch (error) {
    deepseekToggleHint.textContent = error.message || '读取 DeepSeek 状态失败';
  }
}

async function toggleDeepSeekEnabled(enabled) {
  const res = await request('/api/deepseek/toggle', {
    method: 'POST',
    body: JSON.stringify({ enabled: Boolean(enabled) })
  });
  renderDeepSeekStatus(res.data || {});
}

(async () => {
  try {
    await loadImageModelOptionsFromHealth();
    const { blocked } = await ensureWebAuth();
    if (!blocked) {
      await loadDeepSeekStatus();
      loadHistory();
    }
  } catch (error) {
    setMessage(error.message || '初始化失败', true);
  }
})();
