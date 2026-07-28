import { useState, useEffect } from 'react';
import toast from 'react-hot-toast';
import { authedFetch } from '../../utils/googleAuth';

function SheetSelector({ token, onSheetSelect, currentSheet }) {
  const [sheetId, setSheetId] = useState('');
  const [sourceCol, setSourceCol] = useState('A');
  const [targetCol, setTargetCol] = useState('B');
  const [loading, setLoading] = useState(false);
  const [sheets, setSheets] = useState([]);
  const [selectedTitle, setSelectedTitle] = useState('');
  const [recentIds, setRecentIds] = useState([]);

  useEffect(() => {
    loadRecentIds();
    (async () => {
      const id = await detectCurrentSheet();
      await loadSavedSettings(id);
    })();
  }, []);

  const detectCurrentSheet = async () => {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const url = tabs[0]?.url || '';
      const match = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
      if (match && match[1]) {
        setSheetId(match[1]);
        return match[1];
      }
      return null;
    } catch (e) {
      console.error('检测当前表格失败:', e);
      return null;
    }
  };

  const loadSavedSettings = async (detectedId) => {
    const result = await chrome.storage.local.get(['sheetSettings', 'sheetSettingsMap']);
    const ss = result.sheetSettings || {};
    const map = result.sheetSettingsMap || {};
    // 优先用该表格自己保存过的列配置，没有再用全局默认
    const perSheet = (detectedId && map[detectedId]) ? map[detectedId] : ss;
    if (perSheet?.sourceCol) setSourceCol(perSheet.sourceCol);
    if (perSheet?.targetCol) setTargetCol(perSheet.targetCol);
  };

  // 把选中的表格 + tab + 列一次性写进 storage（与工作面板读取的结构保持一致）
  // - sheetSettings.sheet 决定工作面板打开哪个表
  // - sheetSettingsMap[表格ID] 决定该表的列，会覆盖全局列，所以必须一并写入
  const persistSelection = async (sheetObj, sCol, tCol) => {
    const result = await chrome.storage.local.get(['sheetSettings', 'sheetSettingsMap']);
    const current = result.sheetSettings || {};
    const map = result.sheetSettingsMap || {};
    const merged = { ...current, sheet: sheetObj, sourceCol: sCol, targetCol: tCol };
    if (sheetObj?.id) {
      map[sheetObj.id] = { ...(map[sheetObj.id] || {}), sourceCol: sCol, targetCol: tCol };
    }
    await chrome.storage.local.set({ sheetSettings: merged, sheetSettingsMap: map });
  };

  const loadRecentIds = async () => {
    const result = await chrome.storage.local.get(['recentSheetIds']);
    setRecentIds(result.recentSheetIds || []);
  };

  const saveRecentId = async (id) => {
    let updated = [id, ...recentIds.filter(i => i !== id)];
    if (updated.length > 10) updated = updated.slice(0, 10);
    await chrome.storage.local.set({ recentSheetIds: updated });
    setRecentIds(updated);
  };

  const removeRecentId = async (id, e) => {
    e.stopPropagation();
    const updated = recentIds.filter(i => i !== id);
    await chrome.storage.local.set({ recentSheetIds: updated });
    setRecentIds(updated);
  };

  const loadSheet = async () => {
    if (!sheetId.trim()) {
      toast.error('请输入表格 ID');
      return;
    }

    setLoading(true);
    try {
      const response = await authedFetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=sheets.properties.title,sheets.properties.sheetId`
      );

     if (!response.ok) throw new Error('无法访问表格');
      
      const data = await response.json();
      const list = data.sheets?.map(s => ({
        id: s.properties.sheetId,
        title: s.properties.title
      })) || [];
      setSheets(list);
      
      const cleanId = sheetId.trim();
      await saveRecentId(cleanId);

      if (list.length > 0) {
        const first = list[0];
        const sheetObj = { id: cleanId, sheetId: first.id, title: first.title };
        setSelectedTitle(first.title);
        await persistSelection(sheetObj, sourceCol, targetCol);
        onSheetSelect(sheetObj);
      } else {
        const sheetObj = { id: cleanId, title: '' };
        await persistSelection(sheetObj, sourceCol, targetCol);
        onSheetSelect(sheetObj);
      }
      toast.success('表格加载成功');
    } catch (err) {
      toast.error('加载失败: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleRecentSelect = (id) => {
    setSheetId(id);
  };

  // 列变更时，如果已经加载了表格，就实时同步到 storage，避免"改了列不生效"
  const handleColChange = (which, rawValue) => {
    const val = rawValue.toUpperCase();
    const nextSource = which === 'source' ? val : sourceCol;
    const nextTarget = which === 'target' ? val : targetCol;
    if (which === 'source') setSourceCol(val); else setTargetCol(val);
    if (sheets.length > 0 && selectedTitle) {
      const s = sheets.find(x => x.title === selectedTitle);
      const sheetObj = { id: sheetId.trim(), sheetId: s?.id, title: selectedTitle };
      persistSelection(sheetObj, nextSource, nextTarget);
    }
  };

  return (
    <div className="sheet-selector">
      <div className="input-group">
        <label>表格 ID</label>
        <input 
          type="text" 
          value={sheetId}
          onChange={(e) => setSheetId(e.target.value)}
          placeholder="Google 表格 URL 中的 ID"
          onKeyDown={(e) => e.key === 'Enter' && loadSheet()}
        />
        <button className="detect-btn" onClick={detectCurrentSheet} title="读取当前打开的表格">
          读取当前表格
        </button>
        <small>URL 中 /d/ 后面的那一长串，或点击按钮自动读取</small>
        
        {recentIds.length > 0 && (
          <div className="recent-ids">
            <span className="recent-label">最近使用:</span>
            <div className="recent-list">
              {recentIds.map((id) => (
                <div 
                  key={id} 
                  className={`recent-item ${sheetId === id ? 'active' : ''}`}
                  onClick={() => handleRecentSelect(id)}
                >
                  <span className="recent-id">{id.length > 20 ? id.slice(0, 20) + '...' : id}</span>
                  <button 
                    className="recent-remove" 
                    onClick={(e) => removeRecentId(id, e)}
                    title="移除"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="input-group">
        <label>源语言列</label>
        <input
          type="text"
          value={sourceCol}
          onChange={(e) => handleColChange('source', e.target.value)}
          placeholder="如: A"
        />
      </div>

      <div className="input-group">
        <label>目标语言列</label>
        <input
          type="text"
          value={targetCol}
          onChange={(e) => handleColChange('target', e.target.value)}
          placeholder="如: B"
        />
      </div>

      <button className="load-btn" onClick={loadSheet} disabled={loading}>
        {loading ? '加载中...' : '加载表格'}
      </button>

      {sheets.length > 0 && (
        <div className="input-group" aria-label="工作表选择">
          <label>工作表</label>
          <select value={selectedTitle} onChange={(e) => {
            const title = e.target.value;
            setSelectedTitle(title);
            const s = sheets.find(x => x.title === title);
            const sheetObj = { id: sheetId.trim(), sheetId: s?.id, title: s?.title ?? title };
            persistSelection(sheetObj, sourceCol, targetCol);
            onSheetSelect(sheetObj);
          }}>
            {sheets.map(s => (
              <option key={s.id} value={s.title}>{s.title}</option>
            ))}
          </select>
        </div>
      )}

      <div className="quick-start">
        <h4>快速开始</h4>
        <p>1. 打开 Google 表格 → 2. 复制 URL 中的表格 ID → 3. 填入上方并设置列</p>
      </div>
    </div>
  );
}

export default SheetSelector;
