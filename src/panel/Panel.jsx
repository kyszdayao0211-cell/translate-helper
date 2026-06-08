import { useState, useEffect, useCallback } from 'react';
import Login from '../popup/components/Login';
import SheetSelector from '../popup/components/SheetSelector';
import TranslationWorkspace from './TranslationWorkspace';
import TermLibrarySelector from './TermLibrarySelector';
import TermManager from './TermManager';
import AITranslationPanel from './AITranslationPanel';
import './styles.css';

function Panel() {
  const [token, setToken] = useState(null);
  const [currentSheet, setCurrentSheet] = useState(null);
  const [sourceCol, setSourceCol] = useState('A');
  const [targetCol, setTargetCol] = useState('B');
  const [showIntermediate, setShowIntermediate] = useState(false);
  const [intermediateCol, setIntermediateCol] = useState('C');
  const [sheets, setSheets] = useState([]);
  const [loadingSheets, setLoadingSheets] = useState(false);
  const [showSetup, setShowSetup] = useState(false);
  const [termLibraryBindingId, setTermLibraryBindingId] = useState(null);
  const [showTermsCol, setShowTermsCol] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    chrome.storage.local.get(['google_token', 'sheetSettings', 'sheetSettingsMap'], (result) => {
      setToken(result.google_token || null);
      const ss = result.sheetSettings;
      const map = result.sheetSettingsMap || {};
      if (ss?.sheet) {
        // 用该表格自己保存的配置覆盖全局配置（如果有的话）
        const perSheet = map[ss.sheet.id] || ss;
        setCurrentSheet(ss.sheet);
        setShowSetup(false);
        setSourceCol(perSheet.sourceCol || 'A');
        setTargetCol(perSheet.targetCol || 'B');
        setShowIntermediate(perSheet.showIntermediate || false);
        setIntermediateCol(perSheet.intermediateCol || 'C');
        setTermLibraryBindingId(perSheet.termLibraryBindingId || null);
        setShowTermsCol(perSheet.showTermsCol || false);
      } else {
        setShowSetup(true);
        setSourceCol(ss?.sourceCol || 'A');
        setTargetCol(ss?.targetCol || 'B');
        setShowIntermediate(ss?.showIntermediate || false);
        setIntermediateCol(ss?.intermediateCol || 'C');
        setTermLibraryBindingId(ss?.termLibraryBindingId || null);
        setShowTermsCol(ss?.showTermsCol || false);
      }
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    if (!token || !currentSheet?.id) return;
    fetchSheetsList(currentSheet.id);
  }, [token, currentSheet?.id]);

  const fetchSheetsList = async (spreadsheetId) => {
    if (!spreadsheetId) return;
    setLoadingSheets(true);
    try {
      const response = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties.title,sheets.properties.sheetId`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!response.ok) throw new Error('获取 sheet 列表失败');
      const data = await response.json();
      const list = data.sheets?.map(s => ({
        id: s.properties.sheetId,
        title: s.properties.title
      })) || [];
      setSheets(list);
    } catch (err) {
      console.error('获取 sheet 列表失败:', err);
    } finally {
      setLoadingSheets(false);
    }
  };

  const handleSheetSelect = async (sheet) => {
    // 读取该表格之前保存过的独立配置
    const result = await new Promise(resolve =>
      chrome.storage.local.get(['sheetSettingsMap'], resolve)
    );
    const map = result.sheetSettingsMap || {};
    const perSheet = map[sheet.id] || {};

    // 还原该表格自己的列设置和术语库绑定
    setCurrentSheet(sheet);
    setSourceCol(perSheet.sourceCol || 'A');
    setTargetCol(perSheet.targetCol || 'B');
    setShowIntermediate(perSheet.showIntermediate || false);
    setIntermediateCol(perSheet.intermediateCol || 'C');
    setTermLibraryBindingId(perSheet.termLibraryBindingId || null);
    setShowTermsCol(perSheet.showTermsCol || false);
    setShowSetup(false);

    await saveSettings({
      sheet,
      sourceCol: perSheet.sourceCol || 'A',
      targetCol: perSheet.targetCol || 'B',
      showIntermediate: perSheet.showIntermediate || false,
      intermediateCol: perSheet.intermediateCol || 'C',
      termLibraryBindingId: perSheet.termLibraryBindingId || null,
      showTermsCol: perSheet.showTermsCol || false,
    });
  };

  const handleSheetChange = async (title) => {
    const sheet = { ...currentSheet, title };
    setCurrentSheet(sheet);
    await saveSettings({ sheet });
  };

  const handleColumnChange = async (newSourceCol, newTargetCol) => {
    setSourceCol(newSourceCol);
    setTargetCol(newTargetCol);
    await saveSettings({ sourceCol: newSourceCol, targetCol: newTargetCol });
  };

  const handleIntermediateToggle = async (enabled) => {
    setShowIntermediate(enabled);
    await saveSettings({ showIntermediate: enabled });
  };

  const handleIntermediateColChange = async (col) => {
    setIntermediateCol(col);
    await saveSettings({ intermediateCol: col });
  };

  const handleTermLibraryChange = async (libraryId) => {
    setTermLibraryBindingId(libraryId);
    await saveSettings({ termLibraryBindingId: libraryId });
  };

  const handleTermsColToggle = async (enabled) => {
    setShowTermsCol(enabled);
    await saveSettings({ showTermsCol: enabled });
  };

  const saveSettings = async (partial) => {
    const result = await chrome.storage.local.get(['sheetSettings', 'sheetSettingsMap']);
    const current = result.sheetSettings || {};
    const updated = { ...current, ...partial };
    const map = result.sheetSettingsMap || {};

    // 以当前表格 ID 为 key，单独保存一份该表格的配置
    const sheetId = updated.sheet?.id;
    if (sheetId) {
      map[sheetId] = {
        ...(map[sheetId] || {}),
        ...partial,
        // sheet 对象本身不需要重复存在 map 里
        sheet: undefined,
      };
    }

    await chrome.storage.local.set({
      sheetSettings: updated,
      sheetSettingsMap: map,
    });
  };

  const handleCloseTable = async () => {
    setCurrentSheet(null);
    setShowSetup(true);
    await saveSettings({ sheet: null });
  };

  const handleReload = () => {
    if (currentSheet?.id) {
      fetchSheetsList(currentSheet.id);
    }
  };

  const handleNewTable = () => {
    setShowSetup(true);
  };

  if (!token) {
    return <Login onLogin={setToken} />;
  }

  return (
    <div className="panel-container">
      {currentSheet && !showSetup && (
        <div className="panel-toolbar">
          <div className="toolbar-left">
            <span className="current-sheet-info">
              当前表: {currentSheet?.title || currentSheet?.id}
            </span>
          </div>
          <div className="toolbar-right">
            <button className="toolbar-btn" onClick={handleNewTable} title="新表配置">
              新建表格
            </button>
            <button className="toolbar-btn" onClick={handleReload} title="重新加载">
              重新加载
            </button>
            <button className="toolbar-btn close-btn" onClick={handleCloseTable} title="关闭当前表 (Ctrl+W)">
              关闭当前表
            </button>
          </div>
        </div>
      )}

      {showSetup || !currentSheet ? (
        <div className="setup-section">
          <h2>新表配置</h2>
          <SheetSelector 
            token={token} 
            onSheetSelect={handleSheetSelect}
            currentSheet={currentSheet}
          />
        </div>
      ) : (
        <>
          <TranslationWorkspace 
            token={token}
            sheet={currentSheet}
            sheets={sheets}
            loadingSheets={loadingSheets}
            onSheetChange={handleSheetChange}
            sourceCol={sourceCol}
            targetCol={targetCol}
            onColumnChange={handleColumnChange}
            selectedSheetTitle={currentSheet?.title ?? ''}
            showIntermediate={showIntermediate}
            intermediateCol={intermediateCol}
            onIntermediateToggle={handleIntermediateToggle}
            onIntermediateColChange={handleIntermediateColChange}
            termLibraryBindingId={termLibraryBindingId}
            showTermsCol={showTermsCol}
            onTermsColToggle={handleTermsColToggle}
          />
          <TermLibrarySelector
            currentLibraryId={termLibraryBindingId}
            onLibraryChange={handleTermLibraryChange}
            token={token}
            spreadsheetId={currentSheet?.id}
          />
          <AITranslationPanel
            token={token}
            sheet={currentSheet}
            sourceCol={sourceCol}
            targetCol={targetCol}
          />
          <TermManager token={token} />
        </>
      )}
    </div>
  );
}

export default Panel;
