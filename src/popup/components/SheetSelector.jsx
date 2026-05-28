import { useState, useEffect } from 'react';
import toast from 'react-hot-toast';

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
    loadSavedSettings();
    detectCurrentSheet();
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

  const loadSavedSettings = async () => {
    const result = await chrome.storage.local.get(['sheetSettings']);
    const ss = result.sheetSettings;
    if (ss?.sourceCol) setSourceCol(ss.sourceCol);
    if (ss?.targetCol) setTargetCol(ss.targetCol);
  };

  const saveSettings = async (settings) => {
    const result = await chrome.storage.local.get(['sheetSettings']);
    const current = result.sheetSettings || {};
    await chrome.storage.local.set({
      sheetSettings: { ...current, ...settings }
    });
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
      const response = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=sheets.properties.title,sheets.properties.sheetId`,
        {
          headers: { Authorization: `Bearer ${token}` }
        }
      );
      
     if (!response.ok) throw new Error('无法访问表格');
      
      const data = await response.json();
      const list = data.sheets?.map(s => ({
        id: s.properties.sheetId,
        title: s.properties.title
      })) || [];
      setSheets(list);
      
      await saveRecentId(sheetId.trim());
      
      await saveSettings({ sourceCol, targetCol });
      
      if (list.length > 0) {
        const first = list[0];
        setSelectedTitle(first.title);
        onSheetSelect({ id: sheetId, sheetId: first.id, title: first.title });
      } else {
        onSheetSelect({ id: sheetId, title: '' });
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
          onChange={(e) => setSourceCol(e.target.value.toUpperCase())}
          placeholder="如: A"
        />
      </div>

      <div className="input-group">
        <label>目标语言列</label>
        <input 
          type="text" 
          value={targetCol}
          onChange={(e) => setTargetCol(e.target.value.toUpperCase())}
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
            onSheetSelect({ id: sheetId, sheetId: s?.id, title: s?.title ?? title });
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
