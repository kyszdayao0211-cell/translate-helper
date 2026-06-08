import { useState, useEffect } from 'react';
import toast from 'react-hot-toast';
import TermImportPanel from './TermImportPanel';

function TermLibrarySelector({ currentLibraryId, onLibraryChange, token, spreadsheetId }) {
  const [libraries, setLibraries] = useState([]);
  const [selectedLibId, setSelectedLibId] = useState(currentLibraryId || '');
  const [showNewForm, setShowNewForm] = useState(false);
  const [newLibName, setNewLibName] = useState('');
  const [newLibLang, setNewLibLang] = useState('');
  const [showImportPanel, setShowImportPanel] = useState(false);
  const [showMergeImportPanel, setShowMergeImportPanel] = useState(false);
  const [editingLibId, setEditingLibId] = useState(null);
  const [editingLibName, setEditingLibName] = useState('');
  const [showDocIO, setShowDocIO] = useState(false);

  useEffect(() => {
    loadLibraries();
  }, []);

  useEffect(() => {
    setSelectedLibId(currentLibraryId || '');
  }, [currentLibraryId]);

  const loadLibraries = async () => {
    try {
      const result = await chrome.storage.local.get(['termLibraries']);
      setLibraries(result.termLibraries || []);
    } catch (err) {
      console.error('加载术语库失败:', err);
    }
  };

  const handleCreateLibrary = async () => {
    if (!newLibName.trim()) {
      toast.error('请输入术语库名称');
      return;
    }

    const newLib = {
      id: `lib_${Date.now()}`,
      name: newLibName.trim(),
      language: newLibLang.trim() || 'zh',
      description: '',
    };

    try {
      const result = await chrome.storage.local.get(['termLibraries']);
      const libs = result.termLibraries || [];
      libs.push({ ...newLib, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      await chrome.storage.local.set({ termLibraries: libs });
      
      setLibraries(libs);
      setSelectedLibId(newLib.id);
      onLibraryChange(newLib.id);
      setShowNewForm(false);
      setNewLibName('');
      setNewLibLang('');
      toast.success('术语库创建成功');
    } catch (err) {
      toast.error('创建术语库失败');
    }
  };

  const handleSelectChange = (e) => {
    const libId = e.target.value;
    setSelectedLibId(libId);
    onLibraryChange(libId || null);
  };

  const handleImport = async (importData) => {
    const newLib = {
      id: `lib_${Date.now()}`,
      name: importData.sheetName,
      language: 'remote',
      description: '',
      source: 'remote',
      spreadsheetId: importData.spreadsheetId,
      sheetName: importData.sheetName,
      sourceCol: importData.sourceCol,
      targetCol: importData.targetCol,
      terms: importData.terms,
      termCount: importData.termCount,
    };

    try {
      const result = await chrome.storage.local.get(['termLibraries']);
      const libs = result.termLibraries || [];
      libs.push({ ...newLib, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      await chrome.storage.local.set({ termLibraries: libs });
      
      setLibraries(libs);
      setSelectedLibId(newLib.id);
      onLibraryChange(newLib.id);
      setShowImportPanel(false);
      toast.success('术语库导入成功');
    } catch (err) {
      toast.error('导入术语库失败');
    }
  };

  const handleMergeImport = async (importData) => {
    if (!selectedLibId) {
      toast.error('请先选择要合并到的术语库');
      return;
    }

    try {
      const result = await chrome.storage.local.get(['termLibraries', 'terms']);
      const libs = result.termLibraries || [];
      const libIdx = libs.findIndex(l => l.id === selectedLibId);
      if (libIdx < 0) {
        toast.error('未找到目标术语库');
        return;
      }

      const lib = { ...libs[libIdx] };
      const isRemote = lib.source === 'remote';
      const importTerms = importData.terms || [];

      // 根据库类型正确加载现有术语
      let existingTerms;
      let allGlobalTerms;
      if (isRemote) {
        existingTerms = lib.terms || [];
      } else {
        allGlobalTerms = result.terms || [];
        existingTerms = allGlobalTerms.filter(t => t.libraryId === selectedLibId);
      }

      let added = 0;
      let updated = 0;

      importTerms.forEach(nt => {
        const idx = existingTerms.findIndex(
          et => et.source === nt.source && et.target === nt.target
        );
        if (idx >= 0) {
          // 同 source+target：合并备注
          if (nt.note && nt.note !== (existingTerms[idx].note || '')) {
            existingTerms[idx] = { ...existingTerms[idx], note: nt.note };
            updated++;
          }
        } else {
          existingTerms.push({ ...nt, libraryId: selectedLibId });
          added++;
        }
      });

      if (isRemote) {
        lib.terms = existingTerms;
      }
      lib.termCount = existingTerms.length;
      libraries[libIdx] = lib;
      await chrome.storage.local.set({ termLibraries: libraries });

      // 本地库还要同步到全局 terms 数组
      if (!isRemote && added > 0) {
        const newGlobalTerms = allGlobalTerms.filter(t => t.libraryId !== selectedLibId);
        existingTerms.forEach(et => {
          const globalIdx = newGlobalTerms.findIndex(gt => gt.source === et.source && gt.target === et.target && gt.libraryId === selectedLibId);
          if (globalIdx >= 0) {
            newGlobalTerms[globalIdx] = et;
          } else {
            newGlobalTerms.push(et);
          }
        });
        await chrome.storage.local.set({ terms: newGlobalTerms });
      }

      setLibraries([...libraries]);
      setShowMergeImportPanel(false);
      const parts = [];
      if (added > 0) parts.push(`新增 ${added} 条`);
      if (updated > 0) parts.push(`更新备注 ${updated} 条`);
      if (added === 0 && updated === 0) parts.push('无变化');
      toast.success(`合并完成：${parts.join('，')}`);
    } catch (err) {
      toast.error('合并术语库失败');
    }
  };

  const handleExportLibrary = async () => {
    if (!selectedLibId) return;
    
    const lib = libraries.find(l => l.id === selectedLibId);
    if (!lib) return;
    
    let termsToExport = [];
    if (lib.source === 'remote' && lib.terms) {
      termsToExport = lib.terms;
    } else {
      const result = await chrome.storage.local.get(['terms']);
      termsToExport = (result.terms || []).filter(t => t.libraryId === selectedLibId);
    }
    
    if (termsToExport.length === 0) {
      toast.error('没有可导出的术语');
      return;
    }
    
    const csvContent = '源文本,翻译\n' + termsToExport.map(t => 
      `"${t.source.replace(/"/g, '""')}","${t.target.replace(/"/g, '""')}"`
    ).join('\n');
    
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${lib.name || '术语库'}_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    
    toast.success(`已导出 ${termsToExport.length} 条术语`);
  };

  const handleRenameLibrary = async () => {
    if (!editingLibId || !editingLibName.trim()) return;
    
    const result = await chrome.storage.local.get(['termLibraries']);
    const libs = result.termLibraries || [];
    const updated = libs.map(l => 
      l.id === editingLibId ? { ...l, name: editingLibName.trim(), updatedAt: new Date().toISOString() } : l
    );
    await chrome.storage.local.set({ termLibraries: updated });
    setLibraries(updated);
    setEditingLibId(null);
    setEditingLibName('');
    toast.success('术语库已重命名');
  };

  const startRename = (lib) => {
    setEditingLibId(lib.id);
    setEditingLibName(lib.name);
  };

  // ---- 文档绑定术语库 (_glossary / _guide) 导入导出 ----

  function sendBgMessage(msg) {
    return new Promise(resolve => chrome.runtime.sendMessage(msg, resolve));
  }

  const handleExportGlossary = async () => {
    if (!spreadsheetId) { toast.error('请先选择表格'); return; }
    const resp = await sendBgMessage({ type: 'READ_SHEET_TAB', spreadsheetId, tabName: '_glossary', token });
    if (!resp.data) { toast.error('_glossary tab 不存在'); return; }
    const rows = resp.data.slice(1); // 跳过表头
    const json = rows
      .filter(r => r[0])
      .map(r => ({ source: r[0] || '', target: r[1] || '', notes: r[2] || '' }));
    const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `glossary_${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success(`已导出 ${json.length} 条术语`);
  };

  const handleExportGuide = async () => {
    if (!spreadsheetId) { toast.error('请先选择表格'); return; }
    const resp = await sendBgMessage({ type: 'READ_SHEET_TAB', spreadsheetId, tabName: '_guide', token });
    if (!resp.data) { toast.error('_guide tab 不存在'); return; }
    const text = resp.data.map(r => r[0] || '').join('\n');
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `guide_${new Date().toISOString().slice(0, 10)}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success('翻译指导已导出');
  };

  const handleImportGlossaryFile = () => {
    if (!spreadsheetId) { toast.error('请先选择表格'); return; }
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        if (!Array.isArray(data)) throw new Error('格式错误');
        const values = [['source', 'target', 'notes'], ...data.map(r => [r.source || '', r.target || '', r.notes || ''])];
        await writeTabFull('_glossary', values);
        toast.success(`已导入 ${data.length} 条术语到 _glossary tab`);
      } catch (err) {
        toast.error('导入失败: ' + err.message);
      }
    };
    document.body.appendChild(input);
    input.click();
    document.body.removeChild(input);
  };

  const handleImportGuideFile = () => {
    if (!spreadsheetId) { toast.error('请先选择表格'); return; }
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.txt';
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const lines = text.split('\n');
        const values = lines.map(l => [l]);
        await writeTabFull('_guide', values);
        toast.success('翻译指导已导入到 _guide tab');
      } catch (err) {
        toast.error('导入失败: ' + err.message);
      }
    };
    document.body.appendChild(input);
    input.click();
    document.body.removeChild(input);
  };

  const writeTabFull = async (tabName, values) => {
    const range = encodeURIComponent(tabName);
    const res = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}?valueInputOption=RAW`,
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ range: tabName, majorDimension: 'ROWS', values }),
      }
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      // 可能 tab 不存在，尝试先清空再写
      throw new Error(err?.error?.message || `写入失败: ${res.status}`);
    }
  };

  return (
    <div className="term-library-selector">
      <div className="lib-header">
        <span className="lib-label">绑定术语库:</span>
        <select 
          value={selectedLibId} 
          onChange={handleSelectChange}
          className="lib-dropdown"
        >
          <option value="">-- 选择术语库 --</option>
          {libraries.map(lib => (
            <option key={lib.id} value={lib.id}>
              {lib.name} {lib.termCount ? `(${lib.termCount}条)` : `(${lib.language})`}
            </option>
          ))}
        </select>
        <button 
          className="new-lib-btn" 
          onClick={() => setShowNewForm(!showNewForm)}
        >
          {showNewForm ? '取消' : '+ 新建'}
        </button>
        <button 
          className="import-lib-btn"
          onClick={() => setShowImportPanel(true)}
        >
          导入
        </button>
        {selectedLibId && (
          <>
            <button 
              className="merge-import-lib-btn"
              onClick={() => setShowMergeImportPanel(true)}
            >
              导入合并
            </button>
            <button 
              className="export-lib-btn"
              onClick={handleExportLibrary}
            >
              导出
            </button>
            <button 
              className="rename-lib-btn"
              onClick={() => startRename(libraries.find(l => l.id === selectedLibId))}
            >
              重命名
            </button>
          </>
        )}
      </div>

      {showNewForm && (
        <div className="new-lib-form">
          <div className="form-row">
            <input
              type="text"
              value={newLibName}
              onChange={(e) => setNewLibName(e.target.value)}
              placeholder="术语库名称"
            />
            <input
              type="text"
              value={newLibLang}
              onChange={(e) => setNewLibLang(e.target.value)}
              placeholder="语言代码 (如 zh, en)"
            />
            <button onClick={handleCreateLibrary}>创建</button>
          </div>
        </div>
      )}

      {editingLibId && (
        <div className="rename-lib-form">
          <div className="form-row">
            <input
              type="text"
              value={editingLibName}
              onChange={(e) => setEditingLibName(e.target.value)}
              placeholder="新名称"
            />
            <button onClick={handleRenameLibrary}>保存</button>
            <button onClick={() => { setEditingLibId(null); setEditingLibName(''); }}>取消</button>
          </div>
        </div>
      )}

      {showImportPanel && token && (
        <TermImportPanel 
          token={token} 
          onImport={handleImport}
          onClose={() => setShowImportPanel(false)}
        />
      )}
      {showMergeImportPanel && token && (
        <TermImportPanel
          token={token}
          onImport={handleMergeImport}
          onClose={() => setShowMergeImportPanel(false)}
          title="从 Google Sheet 合并到术语库"
          buttonText="合并"
        />
      )}

      {/* 文档绑定术语库 / 翻译指导 导入导出 */}
      <div className="doc-glossary-section">
        <div className="doc-glossary-header" onClick={() => setShowDocIO(!showDocIO)}>
          <span>文档术语库 (_glossary / _guide)</span>
          <span className="doc-glossary-toggle">{showDocIO ? '▲' : '▼'}</span>
        </div>
        {showDocIO && (
          <div className="doc-glossary-body">
            <div className="doc-io-row">
              <span className="doc-io-label">_glossary tab:</span>
              <button className="doc-io-btn" onClick={handleExportGlossary}>导出 JSON</button>
              <button className="doc-io-btn" onClick={handleImportGlossaryFile}>从 JSON 导入（覆盖）</button>
            </div>
            <div className="doc-io-row">
              <span className="doc-io-label">_guide tab:</span>
              <button className="doc-io-btn" onClick={handleExportGuide}>导出 TXT</button>
              <button className="doc-io-btn" onClick={handleImportGuideFile}>从 TXT 导入（覆盖）</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default TermLibrarySelector;
