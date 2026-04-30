const form = document.querySelector('#generateForm');
const promptInput = document.querySelector('#prompt');
const styleInput = document.querySelector('#style');
const sizeInput = document.querySelector('#size');
const imageModelInput = document.querySelector('#imageModel');
const referenceInput = document.querySelector('#referenceImage');
const referencePreview = document.querySelector('#referencePreview');
const submitButton = document.querySelector('#submitButton');
const message = document.querySelector('#message');
const statusTitle = document.querySelector('#statusTitle');
const preview = document.querySelector('#preview');
const openImage = document.querySelector('#openImage');
const enhancedPromptText = document.querySelector('#enhancedPromptText');
const refineFeedback = document.querySelector('#refineFeedback');
const refineButton = document.querySelector('#refineButton');
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
const MAX_REFERENCE_FILE_SIZE = 5 * 1024 * 1024;
const MAX_REFERENCE_COUNT = 4;
const AUTH_STORAGE_KEY = 'textImagesAuthToken';
const AUTH_EXPIRES_IN_MS = 7 * 24 * 60 * 60 * 1000;

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
  const imageUrl = formatImageUrl(task.imageUrl);
  if (!imageUrl) {
    preview.innerHTML = '<span>图片生成中，请稍候</span>';
    openImage.href = '#';
    openImage.classList.add('disabled');
    return;
  }
  preview.innerHTML = `<img src="${imageUrl}" alt="生成图片" />`;
  openImage.href = imageUrl;
  openImage.classList.remove('disabled');
}

async function createRefineTask(taskId, feedback) {
  return request('/api/refine', {
    method: 'POST',
    body: JSON.stringify({
      taskId,
      feedback,
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
        const imageUrl = formatImageUrl(task.imageUrl);
        const thumb = imageUrl ? `<img src="${imageUrl}" alt="历史图片" />` : '<span>无图片</span>';
        return `<article class="history-item">
          <div class="history-thumb">${thumb}</div>
          <p class="history-prompt">${task.prompt}</p>
          <p class="history-meta">${getStatusText(task.status)} · ${task.imageModel || '默认模型'} · ${task.style || '默认'} · ${task.size || '1024x1024'}</p>
        </article>`;
      })
      .join('');
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
        ...(imageModelInput?.value ? { imageModel: imageModelInput.value } : {}),
        referenceImages
      })
    });

    statusTitle.textContent = getStatusText(res.data.status);
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

  refineButton.disabled = true;
  setMessage('正在创建继续调整任务');
  statusTitle.textContent = '继续调整中';
  preview.innerHTML = '<span>正在基于上一轮结果继续调整</span>';
  enhancedPromptText.textContent = '正在等待 DeepSeek 根据调整意见优化提示词';

  try {
    const res = await createRefineTask(currentTask.id, feedback);
    currentTask = res.data;
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

renderReferencePreview();

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
