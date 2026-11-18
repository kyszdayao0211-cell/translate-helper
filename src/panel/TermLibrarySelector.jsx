import { useState, useEffect, useRef } from 'react';
import toast from 'react-hot-toast';
import TermImportPanel from './TermImportPanel';
import { authedFetch } from '../utils/googleAuth';
import { parseGlossaryFile, termsToCsv, termsToXlsx } from '../utils/glossaryFile';

const GLOSSARY_HEADER = ['source', 'target', 'notes'];

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

  // 文档术语库 (_glossary) 自动回传云端相关
  const uploadTimerRef = useRef(null);
  const skipUploadRef = useRef(false);   // 从云端拉取导致的写入，跳过一次回传
  const lastUploadedRef = useRef(null);  // 上次已上传内容的快照，避免重复上传

  useEffect(() => {
    loadLibraries();
  }, []);

  useEffect(() => {
    setSelectedLibId(currentLibraryId || '');
  }, [currentLibraryId]);

  // 监听术语变化，把文档术语库 (_glossary) 的改动自动回传到云端表格
  useEffect(() => {
    if (!spreadsheetId) return;
    const libId = 'glossary_' + spreadsheetId;
    const listener = (changes, area) => {
      if (area !== 'local' || !changes.termLibraries) return;
      const libs = changes.termLibraries.newValue || [];
      const lib = libs.find(l => l.id === libId);
      if (!lib || lib.source !== 'glossary') return;
      const snapshot = JSON.stringify(lib.terms || []);
      // 这次写入来自“从云端拉取”，只记录快照、不回传
      if (skipUploadRef.current) {
        skipUploadRef.current = false;
        lastUploadedRef.current = snapshot;
        return;
      }
      if (snapshot === lastUploadedRef.current) return; // 内容没变
      if (uploadTimerRef.current) clearTimeout(uploadTimerRef.current);
      uploadTimerRef.current = setTimeout(async () => {
        try {
          await uploadGlossaryTerms(lib.terms || []);
          lastUploadedRef.current = snapshot;
          toast.success('术语已同步到云端', { id: 'glossarySync', duration: 1500 });
        } catch (err) {
          toast.error('云端同步失败: ' + err.message, { id: 'glossarySync' });
        }
      }, 1500);
    };
    chrome.storage.onChanged.addListener(listener);
    return () => {
      chrome.storage.onChanged.removeListener(listener);
      if (uploadTimerRef.current) clearTimeout(uploadTimerRef.current);
    };
  }, [spreadsheetId]);

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
      // 远程库和文档术语库(glossary)的术语都存在 lib.terms 里
      const isRemote = lib.source === 'remote' || lib.source === 'glossary';
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
    if ((lib.source === 'remote' || lib.source === 'glossary') && lib.terms) {
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

  const handleDeleteLibrary = async () => {
    if (!selectedLibId) return;
    const lib = libraries.find(l => l.id === selectedLibId);
    if (!lib) return;
    if (!window.confirm(`确定删除术语库「${lib.name}」吗？此操作不可撤销。`)) return;

    try {
      const result = await chrome.storage.local.get(['termLibraries', 'terms']);
      const libs = (result.termLibraries || []).filter(l => l.id !== selectedLibId);
      const toSet = { termLibraries: libs };

      // 本地库的术语保存在全局 terms 数组里，需一并清理；
      // 远程库/文档术语库的术语在 lib.terms 里，随库删除即可
      if (lib.source !== 'remote' && lib.source !== 'glossary') {
        const allTerms = result.terms || [];
        toSet.terms = allTerms.filter(t => t.libraryId !== selectedLibId);
      }

      await chrome.storage.local.set(toSet);
      setLibraries(libs);
      setSelectedLibId('');
      onLibraryChange(null);
      toast.success('术语库已删除');
    } catch (err) {
      toast.error('删除术语库失败');
    }
  };

  // ---- 文档绑定术语库 (_glossary / _guide) 导入导出 ----

  function sendBgMessage(msg) {
    return new Promise(resolve => chrome.runtime.sendMessage(msg, resolve));
  }

  // 把术语数组整体写回 _glossary tab（含表头）
  const uploadGlossaryTerms = async (terms) => {
    const values = [
      GLOSSARY_HEADER,
      ...terms.map(t => [t.source || '', t.target || '', t.note || '']),
    ];
    await writeTabFull('_glossary', values);
  };

  // 绑定当前文档的 _glossary 术语库；不存在时弹窗询问是否创建
  const bindDocGlossary = async () => {
    if (!spreadsheetId) { toast.error('请先选择表格'); return; }
    try {
      toast.loading('正在读取文档术语库...', { id: 'bindGlossary' });
      const resp = await sendBgMessage({ type: 'READ_SHEET_TAB', spreadsheetId, tabName: '_glossary', token });
      let rows = resp?.data;

      if (rows == null) {
        // _glossary tab 不存在，询问是否创建
        toast.dismiss('bindGlossary');
        if (!window.confirm('此表格还没有术语库（_glossary 标签页），是否现在创建？')) return;
        toast.loading('正在创建术语库...', { id: 'bindGlossary' });
        const createResp = await sendBgMessage({ type: 'CREATE_SHEET_TAB', spreadsheetId, tabName: '_glossary' });
        if (createResp?.error) throw new Error(createResp.error);
        await uploadGlossaryTerms([]); // 写入表头
        rows = [GLOSSARY_HEADER];
      }

      // 解析（跳过表头行）
      const terms = rows.slice(1)
        .filter(r => r && r[0])
        .map(r => ({ source: (r[0] || '').trim(), target: (r[1] || '').trim(), note: (r[2] || '').trim() }));

      const libId = 'glossary_' + spreadsheetId;
      const result = await chrome.storage.local.get(['termLibraries']);
      const libs = result.termLibraries || [];
      const idx = libs.findIndex(l => l.id === libId);
      const libEntry = {
        id: libId,
        name: '文档术语库',
        language: 'glossary',
        source: 'glossary',
        spreadsheetId,
        sheetName: '_glossary',
        terms,
        termCount: terms.length,
        updatedAt: new Date().toISOString(),
      };
      if (idx >= 0) libs[idx] = { ...libs[idx], ...libEntry };
      else libs.push({ ...libEntry, createdAt: new Date().toISOString() });

      skipUploadRef.current = true; // 这次写入是从云端拉取，别再回传
      await chrome.storage.local.set({ termLibraries: libs });
      setLibraries(libs);
      setSelectedLibId(libId);
      onLibraryChange(libId);
      toast.dismiss('bindGlossary');
      toast.success(`已绑定文档术语库（${terms.length} 条）`);
    } catch (err) {
      toast.dismiss('bindGlossary');
      toast.error('绑定失败: ' + err.message);
    }
  };

  const downloadBlob = (blob, fileName) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleExportGlossary = async (format = 'json') => {
    if (!spreadsheetId) { toast.error('请先选择表格'); return; }
    const resp = await sendBgMessage({ type: 'READ_SHEET_TAB', spreadsheetId, tabName: '_glossary', token });
    if (!resp.data) { toast.error('_glossary tab 不存在'); return; }
    const rows = resp.data.slice(1); // 跳过表头
    const terms = rows
      .filter(r => r[0])
      .map(r => ({ source: r[0] || '', target: r[1] || '', notes: r[2] || '' }));
    if (terms.length === 0) { toast.error('_glossary tab 里没有术语'); return; }

    const stamp = new Date().toISOString().slice(0, 10);
    if (format === 'csv') {
      downloadBlob(new Blob([termsToCsv(terms)], { type: 'text/csv;charset=utf-8;' }), `glossary_${stamp}.csv`);
    } else if (format === 'xlsx') {
      const buf = await termsToXlsx(terms);
      downloadBlob(
        new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
        `glossary_${stamp}.xlsx`
      );
    } else {
      downloadBlob(new Blob([JSON.stringify(terms, null, 2)], { type: 'application/json' }), `glossary_${stamp}.json`);
    }
    toast.success(`已导出 ${terms.length} 条术语`);
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
    input.accept = '.json,.csv,.xlsx,.xls,.txt';
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const { terms, format } = await parseGlossaryFile(file);
        if (!terms || terms.length === 0) {
          toast.error('文件里没解析到有效术语');
          return;
        }
        // 安全护栏：写入当前表格的 _glossary 标签页。先检查它是否存在，
        // 避免在不经意间为“公用表格”新建标签页。不存在时明确询问用户。
        const check = await sendBgMessage({ type: 'READ_SHEET_TAB', spreadsheetId, tabName: '_glossary', token });
        if (!check?.data) {
          const ok = window.confirm(
            '当前文档没有 _glossary 标签页。\n\n' +
            '“写入 _glossary（覆盖）”会改写该标签页，并因此自动创建它。\n' +
            '这是公用表格，确定要创建 _glossary 并导入吗？\n\n' +
            '（如果不想改动表格，请改用「从文件导入为独立术语库」，完全不会写入表格）'
          );
          if (!ok) { toast('已取消，未改动表格'); return; }
          const createResp = await sendBgMessage({ type: 'CREATE_SHEET_TAB', spreadsheetId, tabName: '_glossary' });
          if (createResp?.error) throw new Error(createResp.error);
        }
        const values = [GLOSSARY_HEADER, ...terms.map(t => [t.source, t.target, t.notes || ''])];
        await writeTabFull('_glossary', values);
        toast.success(`已从 ${format} 导入 ${terms.length} 条术语到 _glossary tab`);
        // 已绑定文档术语库时自动重新拉取，免去手动点「刷新术语库」
        if (isGlossaryBound) await bindDocGlossary();
      } catch (err) {
        toast.error('导入失败: ' + err.message);
      }
    };
    document.body.appendChild(input);
    input.click();
    document.body.removeChild(input);
  };

  // 把本地文件导入成一个「独立术语库」：术语存在浏览器本地（chrome.storage），
  // 完全不写入当前 Google 表格。适合不想在公用表格上建 _glossary 的场景。
  const handleImportFileToLocalLib = () => {
    if (!spreadsheetId) { toast.error('请先选择表格'); return; }
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,.csv,.xlsx,.xls,.txt';
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const { terms, format } = await parseGlossaryFile(file);
        if (!terms || terms.length === 0) {
          toast.error('文件里没解析到有效术语');
          return;
        }
        const libName = file.name.replace(/\.[^.]+$/, '') || '导入的术语库';
        const libId = `lib_${Date.now()}`;
        const newLib = {
          id: libId,
          name: libName,
          language: 'local',
          description: `从 ${format} 文件导入`,
          source: 'local',
          terms: terms.map(t => ({ source: t.source, target: t.target, note: t.notes || '' })),
          termCount: terms.length,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        // 1) 写入术语库列表
        const result = await chrome.storage.local.get(['termLibraries']);
        const libs = result.termLibraries || [];
        libs.push(newLib);
        // 2) 同步进全局 terms（带 libraryId），供翻译面板按绑定库过滤使用
        const global = (await chrome.storage.local.get(['terms'])).terms || [];
        const libTermsForGlobal = terms.map(t => ({
          source: t.source, target: t.target, note: t.notes || '', libraryId: libId,
        }));
        await chrome.storage.local.set({ termLibraries: libs, terms: [...global, ...libTermsForGlobal] });
        setLibraries(libs);
        setSelectedLibId(libId);
        onLibraryChange(libId);
        toast.success(`已导入 ${terms.length} 条术语为独立术语库「${libName}」（不写入表格）`);
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
    const res = await authedFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}?valueInputOption=RAW`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ range: tabName, majorDimension: 'ROWS', values }),
      }
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      // 可能 tab 不存在，尝试先清空再写
      throw new Error(err?.error?.message || `写入失败: ${res.status}`);
    }
  };

  // 当前是否已绑定“本文档的术语库”——决定按钮显示“绑定”还是“刷新”
  const glossaryLibId = spreadsheetId ? 'glossary_' + spreadsheetId : null;
  const isGlossaryBound = !!glossaryLibId && selectedLibId === glossaryLibId;

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
        <button
          className="bind-glossary-btn"
          onClick={bindDocGlossary}
          title={isGlossaryBound
            ? '从云端重新拉取 _glossary 最新术语（别的设备/他人改动后用）'
            : '绑定当前文档的 _glossary 术语库，换设备登录同一账号可自动同步'}
        >
          {isGlossaryBound ? '🔄 刷新术语库' : '📌 绑定文档术语库'}
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
            <button
              className="delete-lib-btn"
              onClick={handleDeleteLibrary}
            >
              删除
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
            <div className="doc-io-warn">
              ⚠️ 以下“写入”操作会直接改写当前表格的 _glossary / _guide 标签页。当前若是公用表格，请谨慎；不想改动表格可选用「导入为独立术语库」。
            </div>
            <div className="doc-io-row">
              <span className="doc-io-label">_glossary tab:</span>
              <button className="doc-io-btn" onClick={() => handleExportGlossary('json')}>导出 JSON</button>
              <button className="doc-io-btn" onClick={() => handleExportGlossary('csv')}>导出 CSV</button>
              <button className="doc-io-btn" onClick={() => handleExportGlossary('xlsx')}>导出 Excel</button>
              <button className="doc-io-btn" onClick={handleImportGlossaryFile} title="会覆盖当前表格的 _glossary 标签页；不存在时先询问再创建">写入 _glossary（覆盖）</button>
            </div>
            <div className="doc-io-row">
              <span className="doc-io-label">独立术语库:</span>
              <button className="doc-io-btn doc-io-btn-primary" onClick={handleImportFileToLocalLib} title="把文件导入成一个独立术语库，存在浏览器本地，完全不写入当前表格">从文件导入为独立术语库（不写表格）</button>
            </div>
            <div className="doc-io-row">
              <span className="doc-io-label">_guide tab:</span>
              <button className="doc-io-btn" onClick={handleExportGuide}>导出 TXT</button>
              <button className="doc-io-btn" onClick={handleImportGuideFile} title="会覆盖当前表格的 _guide 标签页">写入 _guide（覆盖）</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default TermLibrarySelector;
