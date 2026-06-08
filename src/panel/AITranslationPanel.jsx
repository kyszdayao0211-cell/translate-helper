import { useState, useEffect, useRef } from 'react';
import toast from 'react-hot-toast';

function buildSystemPrompt(glossaryRows, guideText, localTerms) {
  const allTerms = [];
  const seen = new Set();

  (localTerms || []).forEach(t => {
    const key = `${t.source}||${t.target}`;
    if (!seen.has(key)) {
      seen.add(key);
      allTerms.push({ source: t.source, target: t.target, notes: t.note || '' });
    }
  });

  (glossaryRows || []).slice(1).forEach(row => {
    if (!row[0]) return;
    const key = `${row[0]}||${row[1] || ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      allTerms.push({ source: row[0], target: row[1] || '', notes: row[2] || '' });
    }
  });

  const glossarySection = allTerms.length > 0
    ? allTerms.map(t => `${t.source} → ${t.target}${t.notes ? `（${t.notes}）` : ''}`).join('\n')
    : '（无）';

  return `你是专业游戏本地化译者，目标语言为韩语（ko-KR）。请严格遵守以下术语库和翻译指导。

## 术语库
${glossarySection}

## 翻译指导
${guideText || '（无）'}

请将用户提供的文本按行翻译为韩语。
以 JSON 数组格式返回，与输入行顺序严格对应。
只返回译文文本，不要添加任何解释或编号。
示例返回格式：["译文1", "译文2", "译文3"]`;
}

function AITranslationPanel({ token, sheet, sourceCol, targetCol }) {
  const [glossaryRows, setGlossaryRows] = useState(null);
  const [guideText, setGuideText] = useState(null);
  const [glossaryStatus, setGlossaryStatus] = useState('未加载');
  const [guideStatus, setGuideStatus] = useState('未加载');
  const [startRow, setStartRow] = useState('2');
  const [endRow, setEndRow] = useState('');
  const [forceOverwrite, setForceOverwrite] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [progress, setProgress] = useState(null);
  const [failedBatches, setFailedBatches] = useState([]);
  const [syncing, setSyncing] = useState(false);
  const pausedRef = useRef(false);
  const abortRef = useRef(false);

  const spreadsheetId = sheet?.id;
  const sheetTitle = sheet?.title;

  useEffect(() => {
    if (spreadsheetId && token) {
      loadGlossaryAndGuide();
    }
  }, [spreadsheetId, token]);

  const loadGlossaryAndGuide = async () => {
    if (!spreadsheetId || !token) {
      setGlossaryStatus('请先选择表格');
      setGuideStatus('请先选择表格');
      setGlossaryRows([]);
      setGuideText('');
      return;
    }
    setGlossaryStatus('加载中...');
    setGuideStatus('加载中...');

    try {
      const [glossaryResp, guideResp] = await Promise.all([
        sendBgMessage({ type: 'READ_SHEET_TAB', spreadsheetId, tabName: '_glossary', token }),
        sendBgMessage({ type: 'READ_SHEET_TAB', spreadsheetId, tabName: '_guide', token }),
      ]);

      if (glossaryResp?.data && glossaryResp.data.length > 0) {
        setGlossaryRows(glossaryResp.data);
        const count = Math.max(0, glossaryResp.data.length - 1); // 减去表头行
        setGlossaryStatus(`已加载（${count} 条）`);
      } else {
        setGlossaryRows([]);
        setGlossaryStatus('未找到 _glossary tab（将使用本地术语库）');
      }

      if (guideResp?.data && guideResp.data.length > 0) {
        const text = guideResp.data.map(r => r[0] || '').join('\n').trim();
        setGuideText(text);
        setGuideStatus(text ? '已加载' : '内容为空');
      } else {
        setGuideText('');
        setGuideStatus('未找到 _guide tab');
      }
    } catch (err) {
      setGlossaryRows([]);
      setGuideText('');
      setGlossaryStatus('加载失败: ' + err.message);
      setGuideStatus('加载失败');
    }
  };

  // 带超时的 sendMessage，防止 background service worker 未响应时永久挂起
  function sendBgMessage(msg, timeoutMs = 15000) {
    return new Promise(resolve => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) { settled = true; resolve({ data: null, error: '请求超时' }); }
      }, timeoutMs);
      chrome.runtime.sendMessage(msg, (resp) => {
        clearTimeout(timer);
        if (!settled) { settled = true; resolve(resp || { data: null }); }
      });
    });
  }

  const getLocalTerms = async (bindingId) => {
    const result = await chrome.storage.local.get(['terms']);
    const all = result.terms || [];
    if (!bindingId) return all;
    return all.filter(t => !t.libraryId || t.libraryId === bindingId);
  };

  const loadApiConfig = async () => {
    const stored = await chrome.storage.local.get(['aiApiKey', 'aiApiType', 'aiEndpoint', 'aiModel', 'batchSize', 'sheetSettings']);
    return stored;
  };

  const makeTranslateCall = (cfg, systemPrompt, texts) =>
    sendBgMessage({
      type: 'ANTHROPIC_TRANSLATE',
      apiKey: cfg.aiApiKey,
      apiType: cfg.aiApiType || 'anthropic',
      endpoint: cfg.aiEndpoint,
      model: cfg.aiModel,
      systemPrompt,
      texts,
    });

  const runTranslation = async () => {
    if (!spreadsheetId || !sheetTitle) {
      toast.error('请先选择表格');
      return;
    }

    const cfg = await loadApiConfig();

    if (!cfg.aiApiKey) {
      toast.error('请先在设置页填入 API Key');
      return;
    }
    if (!cfg.aiEndpoint) {
      toast.error('请先在设置页填写 API 端点');
      return;
    }

    const batchSize = cfg.batchSize || 50;
    const bindingId = cfg.sheetSettings?.termLibraryBindingId || null;
    const localTerms = await getLocalTerms(bindingId);
    const systemPrompt = buildSystemPrompt(glossaryRows, guideText, localTerms);

    const start = parseInt(startRow, 10) || 2;
    const end = endRow ? parseInt(endRow, 10) : null;

    const endParam = end || '';
    const [srcResp, tgtResp] = await Promise.all([
      sendBgMessage({ type: 'READ_SHEET_TAB', spreadsheetId, tabName: `${sheetTitle}!${sourceCol}${start}:${sourceCol}${endParam}`, token }),
      sendBgMessage({ type: 'READ_SHEET_TAB', spreadsheetId, tabName: `${sheetTitle}!${targetCol}${start}:${targetCol}${endParam}`, token }),
    ]);

    const sourceValues = (srcResp.data || []).map(r => r[0] || '');
    const targetValues = (tgtResp.data || []).map(r => r[0] || '');

    const rows = [];
    sourceValues.forEach((src, i) => {
      const rowNum = start + i;
      if (!src.trim()) return;
      if (!forceOverwrite && targetValues[i]?.trim()) return;
      rows.push({ rowNum, text: src });
    });

    if (rows.length === 0) {
      toast('没有需要翻译的行（所有行已有译文或为空）', { icon: 'ℹ️' });
      return;
    }

    const batches = [];
    for (let i = 0; i < rows.length; i += batchSize) {
      batches.push(rows.slice(i, i + batchSize));
    }

    setIsRunning(true);
    setIsPaused(false);
    setFailedBatches([]);
    pausedRef.current = false;
    abortRef.current = false;

    const newFailed = [];

    for (let bi = 0; bi < batches.length; bi++) {
      if (abortRef.current) break;

      while (pausedRef.current) {
        await new Promise(r => setTimeout(r, 300));
        if (abortRef.current) break;
      }
      if (abortRef.current) break;

      const batch = batches[bi];
      const batchRowNums = batch.map(r => r.rowNum);
      setProgress({
        current: bi + 1,
        total: batches.length,
        startRow: batchRowNums[0],
        endRow: batchRowNums[batchRowNums.length - 1],
      });

      let translations = null;
      let lastError = null;

      for (let attempt = 0; attempt < 3; attempt++) {
        const resp = await makeTranslateCall(cfg, systemPrompt, batch.map(r => r.text));
        if (resp.translations) { translations = resp.translations; break; }
        lastError = resp.error || '未知错误';
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      }

      if (!translations) {
        newFailed.push({ batchIndex: bi, rowNums: batchRowNums, error: lastError });
        setFailedBatches(prev => [...prev, { batchIndex: bi, rowNums: batchRowNums, error: lastError }]);
        continue;
      }

      const updates = batch.map((r, i) => ({
        row: r.rowNum, col: targetCol, value: translations[i] ?? '',
      })).filter(u => u.value !== '');

      const writeResp = await sendBgMessage({ type: 'BATCH_WRITE_CELLS', spreadsheetId, sheetTitle, updates, token });
      if (writeResp.error) {
        newFailed.push({ batchIndex: bi, rowNums: batchRowNums, error: writeResp.error });
        setFailedBatches(prev => [...prev, { batchIndex: bi, rowNums: batchRowNums, error: writeResp.error }]);
      }
    }

    setIsRunning(false);
    setProgress(null);

    if (newFailed.length === 0) {
      toast.success(`翻译完成！共 ${rows.length} 行`);
    } else {
      toast.error(`翻译完成，${newFailed.length} 批失败，可点击「重试失败行」`);
    }
  };

  const handlePauseResume = () => {
    if (isPaused) {
      pausedRef.current = false;
      setIsPaused(false);
    } else {
      pausedRef.current = true;
      setIsPaused(true);
    }
  };

  const handleStop = () => {
    abortRef.current = true;
    pausedRef.current = false;
    setIsPaused(false);
  };

  const handleRetryFailed = async () => {
    if (failedBatches.length === 0) return;

    const cfg = await loadApiConfig();

    if (!cfg.aiApiKey) {
      toast.error('请先在设置页填入 API Key');
      return;
    }

    const bindingId = cfg.sheetSettings?.termLibraryBindingId || null;
    const localTerms = await getLocalTerms(bindingId);
    const systemPrompt = buildSystemPrompt(glossaryRows, guideText, localTerms);

    setIsRunning(true);
    setIsPaused(false);
    pausedRef.current = false;
    abortRef.current = false;

    const stillFailed = [];

    for (let fi = 0; fi < failedBatches.length; fi++) {
      const failedBatch = failedBatches[fi];
      if (abortRef.current) break;

      while (pausedRef.current) {
        await new Promise(r => setTimeout(r, 300));
        if (abortRef.current) break;
      }

      setProgress({
        current: fi + 1,
        total: failedBatches.length,
        startRow: failedBatch.rowNums[0],
        endRow: failedBatch.rowNums[failedBatch.rowNums.length - 1],
        isRetry: true,
      });

      const srcResp = await sendBgMessage({
        type: 'READ_SHEET_TAB',
        spreadsheetId,
        tabName: `${sheetTitle}!${sourceCol}${failedBatch.rowNums[0]}:${sourceCol}${failedBatch.rowNums[failedBatch.rowNums.length - 1]}`,
        token,
      });
      const srcValues = (srcResp.data || []).map(r => r[0] || '');

      let translations = null;
      let lastError = null;

      for (let attempt = 0; attempt < 3; attempt++) {
        const resp = await makeTranslateCall(cfg, systemPrompt, srcValues);
        if (resp.translations) { translations = resp.translations; break; }
        lastError = resp.error || '未知错误';
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      }

      if (!translations) {
        stillFailed.push({ ...failedBatch, error: lastError });
        continue;
      }

      const updates = failedBatch.rowNums.map((rowNum, i) => ({
        row: rowNum, col: targetCol, value: translations[i] ?? '',
      })).filter(u => u.value !== '');

      const writeResp = await sendBgMessage({ type: 'BATCH_WRITE_CELLS', spreadsheetId, sheetTitle, updates, token });
      if (writeResp.error) stillFailed.push({ ...failedBatch, error: writeResp.error });
    }

    setIsRunning(false);
    setProgress(null);
    setFailedBatches(stillFailed);

    if (stillFailed.length === 0) {
      toast.success('所有失败行重试成功');
    } else {
      toast.error(`仍有 ${stillFailed.length} 批失败`);
    }
  };

  // 将本地术语库同步（合并）到 _glossary tab
  const handleSyncToGlossary = async () => {
    if (!spreadsheetId || !token) { toast.error('请先选择表格'); return; }
    setSyncing(true);
    try {
      const stored = await chrome.storage.local.get(['terms', 'sheetSettings']);
      const bindingId = stored.sheetSettings?.termLibraryBindingId || null;
      const allTerms = stored.terms || [];
      const localTerms = bindingId
        ? allTerms.filter(t => !t.libraryId || t.libraryId === bindingId)
        : allTerms;

      if (localTerms.length === 0) {
        toast('本地术语库为空，无需同步', { icon: 'ℹ️' });
        setSyncing(false);
        return;
      }

      // 读取现有 _glossary tab
      const existingResp = await sendBgMessage({ type: 'READ_SHEET_TAB', spreadsheetId, tabName: '_glossary', token });
      const existingRows = existingResp?.data || [];

      // 构建现有条目的 source 集合（跳过表头行）
      const existingSources = new Set(
        existingRows.slice(1).map(r => r[0]).filter(Boolean)
      );

      // 只追加本地有、_glossary 没有的条目
      const newRows = localTerms
        .filter(t => t.source && !existingSources.has(t.source))
        .map(t => [t.source, t.target || '', t.note || '']);

      if (newRows.length === 0) {
        toast('所有本地术语已在 _glossary tab 中，无新增', { icon: 'ℹ️' });
        setSyncing(false);
        return;
      }

      // 追加写入：先确定写入位置（现有行数 + 1）
      const nextRow = existingRows.length > 0 ? existingRows.length + 1 : 2; // 第1行是表头
      const hasHeader = existingRows.length > 0;

      // 构建完整写入数据
      let writeValues;
      if (!hasHeader) {
        // tab 不存在或为空，写表头 + 数据
        writeValues = [['source', 'target', 'notes'], ...newRows];
        const range = encodeURIComponent('_glossary');
        const res = await fetch(
          `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}?valueInputOption=RAW`,
          {
            method: 'PUT',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ range: '_glossary', majorDimension: 'ROWS', values: writeValues }),
          }
        );
        if (!res.ok) throw new Error(`写入失败: ${res.status}`);
      } else {
        // 追加到现有内容后面
        const appendRange = encodeURIComponent(`_glossary!A${nextRow}`);
        const res = await fetch(
          `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${appendRange}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ majorDimension: 'ROWS', values: newRows }),
          }
        );
        if (!res.ok) throw new Error(`追加写入失败: ${res.status}`);
      }

      toast.success(`已同步 ${newRows.length} 条本地术语到 _glossary tab`);
      // 刷新状态
      await loadGlossaryAndGuide();
    } catch (err) {
      toast.error('同步失败: ' + err.message);
    } finally {
      setSyncing(false);
    }
  };

  const isLoaded = glossaryRows !== null && guideText !== null;
  const canStart = !isRunning && isLoaded;

  return (
    <div className="ai-translation-panel">
      <div className="ai-panel-header">
        <h3>AI 批量翻译</h3>
      </div>

      <div className="ai-status-bar">
        <div className="ai-status-item">
          <span className="ai-status-label">术语库:</span>
          <span className="ai-status-value">{glossaryStatus}</span>
        </div>
        <div className="ai-status-item">
          <span className="ai-status-label">翻译指导:</span>
          <span className="ai-status-value">{guideStatus}</span>
        </div>
        <button className="ai-refresh-btn" onClick={loadGlossaryAndGuide} disabled={isRunning || syncing}>
          刷新
        </button>
        <button
          className="ai-sync-btn"
          onClick={handleSyncToGlossary}
          disabled={isRunning || syncing}
          title="将工作区本地术语库中的术语追加到 _glossary tab（已存在的不重复添加）"
        >
          {syncing ? '同步中...' : '同步本地术语 →'}
        </button>
      </div>

      <div className="ai-config-row">
        <span className="ai-config-label">源列:</span>
        <span className="ai-config-value">{sourceCol}</span>
        <span className="ai-config-label" style={{ marginLeft: 12 }}>目标列:</span>
        <span className="ai-config-value">{targetCol}</span>
        <span className="ai-config-hint">（在工作区顶部修改）</span>
      </div>

      <div className="ai-config-section">
        <div className="ai-range-row">
          <label>翻译范围:</label>
          <span>第</span>
          <input
            type="number"
            value={startRow}
            onChange={e => setStartRow(e.target.value)}
            min={1}
            className="ai-row-input"
            disabled={isRunning}
          />
          <span>行 ~</span>
          <input
            type="number"
            value={endRow}
            onChange={e => setEndRow(e.target.value)}
            placeholder="留空=全部"
            className="ai-row-input"
            disabled={isRunning}
          />
          <span>行</span>
        </div>
        <label className="ai-checkbox-label">
          <input
            type="checkbox"
            checked={forceOverwrite}
            onChange={e => setForceOverwrite(e.target.checked)}
            disabled={isRunning}
          />
          强制覆盖已有译文
        </label>
      </div>

      <div className="ai-actions">
        {!isRunning ? (
          <button className="ai-start-btn" onClick={runTranslation} disabled={!canStart}>
            开始翻译
          </button>
        ) : (
          <>
            <button className="ai-pause-btn" onClick={handlePauseResume}>
              {isPaused ? '继续' : '暂停'}
            </button>
            <button className="ai-stop-btn" onClick={handleStop}>停止</button>
          </>
        )}
      </div>

      {isRunning && progress && (
        <div className="ai-progress-section">
          <div className="ai-progress-bar-wrap">
            <div
              className="ai-progress-bar-fill"
              style={{ width: `${Math.round((progress.current / progress.total) * 100)}%` }}
            />
          </div>
          <div className="ai-progress-text">
            {progress.isRetry ? '重试 ' : ''}第 {progress.current} 批 / 共 {progress.total} 批
            （第 {progress.startRow} 行 ~ 第 {progress.endRow} 行）
            {isPaused && ' [已暂停]'}
          </div>
        </div>
      )}

      {failedBatches.length > 0 && !isRunning && (
        <div className="ai-failed-section">
          <div className="ai-failed-header">
            失败批次（{failedBatches.length} 批）:
            <button className="ai-retry-btn" onClick={handleRetryFailed}>重试失败行</button>
          </div>
          <ul className="ai-failed-list">
            {failedBatches.map((b, i) => (
              <li key={i}>第 {b.rowNums[0]}~{b.rowNums[b.rowNums.length - 1]} 行: {b.error}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default AITranslationPanel;
