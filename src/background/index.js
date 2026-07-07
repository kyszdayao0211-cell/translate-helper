chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'GET_TERMS') {
    chrome.storage.local.get(['terms'], (result) => {
      sendResponse(result.terms || []);
    });
    return true;
  }
  
  if (request.type === 'SAVE_TERM') {
    chrome.storage.local.get(['terms'], (result) => {
      const terms = result.terms || [];
      const existingIndex = terms.findIndex(t => t.source === request.term.source);
      
      if (existingIndex >= 0) {
        terms[existingIndex] = { 
          ...terms[existingIndex], 
          target: request.term.target,
          count: (terms[existingIndex].count || 1) + 1
        };
      } else {
        terms.push(request.term);
      }
      
      chrome.storage.local.set({ terms });
      sendResponse({ success: true });
    });
    return true;
  }

  if (request.type === 'GET_TERM_LIBRARIES') {
    chrome.storage.local.get(['termLibraries'], (result) => {
      sendResponse(result.termLibraries || []);
    });
    return true;
  }
  
  if (request.type === 'SAVE_TERM_LIBRARY') {
    chrome.storage.local.get(['termLibraries'], (result) => {
      const libs = result.termLibraries || [];
      const existingIndex = libs.findIndex(l => l.id === request.library.id);
      
      if (existingIndex >= 0) {
        libs[existingIndex] = { ...request.library, updatedAt: new Date().toISOString() };
      } else {
        libs.push({ ...request.library, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      }
      
      chrome.storage.local.set({ termLibraries: libs });
      sendResponse({ success: true });
    });
    return true;
  }

  if (request.type === 'SET_TABLE_BINDING') {
    chrome.storage.local.get(['sheetSettings'], (result) => {
      const settings = result.sheetSettings || {};
      settings.termLibraryBindingId = request.libraryId;
      chrome.storage.local.set({ sheetSettings: settings });
      sendResponse({ success: true });
    });
    return true;
  }
  
  if (request.type === 'GET_TABLE_BINDING') {
    chrome.storage.local.get(['sheetSettings'], (result) => {
      sendResponse(result.sheetSettings?.termLibraryBindingId || null);
    });
    return true;
  }

  if (request.type === 'GET_FILTERED_ROWS') {
    getFilteredVisibleRows(request.spreadsheetId, request.sheetTitle)
      .then(rows => sendResponse({ visibleRows: rows }))
      .catch(err => sendResponse({ error: err.message, visibleRows: [] }));
    return true;
  }

  if (request.type === 'ANTHROPIC_TRANSLATE') {
    translateWithAI(request.apiKey, request.apiType, request.endpoint, request.model, request.systemPrompt, request.texts)
      .then(translations => sendResponse({ translations }))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (request.type === 'READ_SHEET_TAB') {
    readSheetTab(request.spreadsheetId, request.tabName, request.token)
      .then(data => sendResponse({ data }))
      .catch(err => sendResponse({ error: err.message, data: null }));
    return true;
  }

  if (request.type === 'BATCH_WRITE_CELLS') {
    batchWriteCells(request.spreadsheetId, request.sheetTitle, request.updates, request.token)
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (request.type === 'CREATE_SHEET_TAB') {
    createSheetTab(request.spreadsheetId, request.tabName)
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }
});

async function translateWithAI(apiKey, apiType, endpoint, model, systemPrompt, texts) {
  const userMessage = `请翻译以下 ${texts.length} 行文本：\n${JSON.stringify(texts)}`;

  let headers, body;

  if (apiType === 'anthropic') {
    headers = {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31',
    };
    body = JSON.stringify({
      model,
      max_tokens: 8192,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userMessage }],
    });
  } else {
    // OpenAI 兼容格式（OpenAI / DeepSeek / Gemini OpenAI-compat / 本地 Ollama 等）
    headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    };
    body = JSON.stringify({
      model,
      max_tokens: 8192,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
    });
  }

  const response = await fetch(endpoint, { method: 'POST', headers, body });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    const msg = err?.error?.message || `API 错误: ${response.status}`;
    // 用特殊前缀标记限速错误，让前端做更长的等待
    if (response.status === 429) throw new Error(`RATE_LIMIT:${msg}`);
    throw new Error(msg);
  }

  const data = await response.json();

  // 统一提取文本：Anthropic 格式 vs OpenAI 格式
  const raw = apiType === 'anthropic'
    ? (data.content?.[0]?.text || '')
    : (data.choices?.[0]?.message?.content || '');

  // 提取 JSON 数组（兼容模型在回复中包含多余文字的情况）
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) throw new Error('返回内容无法解析为 JSON 数组');
  return JSON.parse(match[0]);
}

// ===== Google token 管理（service worker 内，无法 import ES 模块，故内联）=====
function bgGetAuthToken(interactive) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError || !token) {
        reject(new Error(chrome.runtime.lastError?.message || '获取授权失败'));
      } else {
        resolve(token);
      }
    });
  });
}

function bgRemoveCachedToken(token) {
  return new Promise((resolve) => {
    if (!token) return resolve();
    chrome.identity.removeCachedAuthToken({ token }, () => resolve());
  });
}

// 带 401/403 自动清缓存→静默刷新→重试的 fetch（长批次翻译时 token 过期也能续上）
async function bgAuthedFetch(url, options = {}) {
  let token;
  try {
    token = await bgGetAuthToken(false);
  } catch (e) {
    token = await bgGetAuthToken(true);
  }
  const build = (t) => ({
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${t}` },
  });

  let res = await fetch(url, build(token));
  if (res.status !== 401 && res.status !== 403) return res;

  await bgRemoveCachedToken(token);
  try {
    token = await bgGetAuthToken(false);
  } catch (e) {
    token = await bgGetAuthToken(true);
  }
  res = await fetch(url, build(token));
  return res;
}

async function readSheetTab(spreadsheetId, tabName, token) {
  const range = encodeURIComponent(`${tabName}`);
  const res = await bgAuthedFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}`
  );
  if (res.status === 400 || res.status === 404) return null; // tab 不存在
  if (!res.ok) throw new Error(`读取 ${tabName} 失败: ${res.status}`);
  const data = await res.json();
  return data.values || [];
}

async function batchWriteCells(spreadsheetId, sheetTitle, updates, token) {
  // updates: [{ row: number, col: string, value: string }, ...]
  const valueRanges = updates.map(u => ({
    range: `${sheetTitle}!${u.col}${u.row}`,
    values: [[u.value]],
  }));

  const res = await bgAuthedFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchUpdate`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        valueInputOption: 'RAW',
        data: valueRanges,
      }),
    }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `写入失败: ${res.status}`);
  }
}

// 新建一个工作表标签页（如 _glossary）。若同名 tab 已存在，Google 会报错，这里当作成功忽略。
async function createSheetTab(spreadsheetId, tabName) {
  const res = await bgAuthedFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [{ addSheet: { properties: { title: tabName } } }],
      }),
    }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err?.error?.message || `创建标签页失败: ${res.status}`;
    // 已存在同名 tab 时不算错误
    if (/already exists/i.test(msg)) return;
    throw new Error(msg);
  }
}

async function getFilteredVisibleRows(spreadsheetId, sheetTitle) {
  const range = sheetTitle ? `&ranges=${encodeURIComponent(sheetTitle)}` : '';
  const res = await bgAuthedFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?includeGridData=true${range}&fields=sheets.data.rowMetadata`
  );
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  const data = await res.json();
  if (!data.sheets?.[0]?.data?.[0]?.rowMetadata) {
    return [];
  }
  const rowMetadata = data.sheets[0].data[0].rowMetadata;
  const visibleRows = [];
  rowMetadata.forEach((row, index) => {
    if (!row.hiddenByFilter) {
      visibleRows.push(index + 1);
    }
  });
  return visibleRows;
}