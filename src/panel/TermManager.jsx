import { useState, useEffect } from 'react';
import toast from 'react-hot-toast';

function TermManager({ token }) {
  const [terms, setTerms] = useState([]);
  const [search, setSearch] = useState('');
  const [showAddForm, setShowAddForm] = useState(false);
  const [newTermSource, setNewTermSource] = useState('');
  const [newTermTarget, setNewTermTarget] = useState('');
  const [libraries, setLibraries] = useState([]);
  const [selectedLibraryId, setSelectedLibraryId] = useState('');
  const [showNewLibForm, setShowNewLibForm] = useState(false);
  const [newLibName, setNewLibName] = useState('');
  const [newLibLang, setNewLibLang] = useState('');
  const [editingTerm, setEditingTerm] = useState(null);
  const [newTermCaseSensitive, setNewTermCaseSensitive] = useState(false);
  const [newTermNote, setNewTermNote] = useState('');

  useEffect(() => {
    loadTerms();
    loadLibraries();
  }, []);

  const loadTerms = async () => {
    const result = await chrome.storage.local.get(['terms', 'termLibraries']);
    const allTerms = result.terms || [];
    const libs = result.termLibraries || [];
    setLibraries(libs);
    
    let filteredTerms = allTerms;
    if (selectedLibraryId) {
      const lib = libs.find(l => l.id === selectedLibraryId);
      if (lib?.source === 'remote' && lib?.terms) {
        filteredTerms = lib.terms;
      } else {
        filteredTerms = allTerms.filter(t => t.libraryId === selectedLibraryId);
      }
    }
    setTerms(filteredTerms);
  };

  const loadLibraries = async () => {
    const result = await chrome.storage.local.get(['termLibraries']);
    setLibraries(result.termLibraries || []);
  };

  const notifyContentScript = () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, { type: 'REFRESH_TERMS' });
      }
    });
  };

  const deleteTerm = async (sourceText) => {
    const result = await chrome.storage.local.get(['terms']);
    const allTerms = result.terms || [];
    const updated = allTerms.filter(t => t.source !== sourceText);
    await chrome.storage.local.set({ terms: updated });
    setTerms(updated.filter(t => t.source !== sourceText));
    toast.success('术语已删除');
  };

  const handleAddTerm = async () => {
    if (!newTermSource.trim() || !newTermTarget.trim()) {
      toast.error('请输入源文本和翻译');
      return;
    }
    
    // 如果选中的是远程库，直接更新 lib.terms
    if (selectedLibraryId) {
      const libsResult = await chrome.storage.local.get(['termLibraries']);
      const libraries = libsResult.termLibraries || [];
      const libIdx = libraries.findIndex(l => l.id === selectedLibraryId);
      if (libIdx >= 0 && libraries[libIdx].source === 'remote') {
        const lib = { ...libraries[libIdx] };
        const existingIdx = (lib.terms || []).findIndex(t => t.source === newTermSource.trim());
        if (existingIdx >= 0) {
          lib.terms[existingIdx] = { ...lib.terms[existingIdx], target: newTermTarget.trim(), caseSensitive: newTermCaseSensitive, note: newTermNote.trim() };
        } else {
          lib.terms = [...(lib.terms || []), { source: newTermSource.trim(), target: newTermTarget.trim(), caseSensitive: newTermCaseSensitive, note: newTermNote.trim() }];
        }
        lib.termCount = lib.terms.length;
        libraries[libIdx] = lib;
        await chrome.storage.local.set({ termLibraries: libraries });
        setNewTermSource('');
        setNewTermTarget('');
        setNewTermCaseSensitive(false);
        setNewTermNote('');
        setShowAddForm(false);
        loadTerms();
        notifyContentScript();
        toast.success('术语已添加');
        return;
      }
    }
    
    const result = await chrome.storage.local.get(['terms']);
    const allTerms = result.terms || [];
    
    const existingIndex = allTerms.findIndex(t => t.source === newTermSource.trim());
    let updated;
    if (existingIndex >= 0) {
      updated = [...allTerms];
      updated[existingIndex] = { 
        ...updated[existingIndex], 
        target: newTermTarget.trim(),
        caseSensitive: newTermCaseSensitive,
        note: newTermNote.trim(),
        count: (updated[existingIndex].count || 1) + 1
      };
    } else {
      updated = [...allTerms, { 
        source: newTermSource.trim(), 
        target: newTermTarget.trim(),
        caseSensitive: newTermCaseSensitive,
        note: newTermNote.trim(),
        count: 1,
        created: new Date().toISOString()
      }];
    }
    
    await chrome.storage.local.set({ terms: updated });
    setNewTermSource('');
    setNewTermTarget('');
    setNewTermCaseSensitive(false);
    setNewTermNote('');
    setShowAddForm(false);
    loadTerms();
    toast.success('术语已添加');
  };

  const handleEditTerm = async () => {
    if (!editingTerm || !editingTerm.source.trim() || !editingTerm.target.trim()) {
      toast.error('请填写完整');
      return;
    }
    
    const result = await chrome.storage.local.get(['terms']);
    const allTerms = result.terms || [];
    
    const updated = allTerms.map(t => {
      if (t.source === editingTerm.originalSource) {
        return { 
          ...t, 
          source: editingTerm.source.trim(), 
          target: editingTerm.target.trim(),
          caseSensitive: editingTerm.caseSensitive || false,
          note: editingTerm.note || ''
        };
      }
      return t;
    });
    
    await chrome.storage.local.set({ terms: updated });
    setEditingTerm(null);
    loadTerms();
    toast.success('术语已更新');
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
      source: 'local',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    
    const result = await chrome.storage.local.get(['termLibraries']);
    const libs = result.termLibraries || [];
    libs.push(newLib);
    await chrome.storage.local.set({ termLibraries: libs });
    
    setLibraries(libs);
    setSelectedLibraryId(newLib.id);
    setShowNewLibForm(false);
    setNewLibName('');
    setNewLibLang('');
    toast.success('术语库创建成功');
  };

  const filtered = terms.filter(t => 
    t.source.toLowerCase().includes(search.toLowerCase()) ||
    t.target.toLowerCase().includes(search.toLowerCase()) ||
    (t.note && t.note.toLowerCase().includes(search.toLowerCase()))
  );

  return (
    <div className="term-manager-full">
      <div className="term-manager-title">
        <h3>术语管理</h3>
      </div>
      
      <div className="term-manager-header">
        <div className="lib-selector-row">
          <select 
            value={selectedLibraryId} 
            onChange={(e) => { setSelectedLibraryId(e.target.value); loadTerms(); }}
            className="lib-select"
          >
            <option value="">全部术语</option>
            {libraries.map(lib => (
              <option key={lib.id} value={lib.id}>
                {lib.name} {lib.termCount ? `(${lib.termCount})` : ''}
              </option>
            ))}
          </select>
          <button className="new-lib-btn" onClick={() => setShowNewLibForm(!showNewLibForm)}>
            {showNewLibForm ? '取消' : '+ 新建术语库'}
          </button>
          <button className="refresh-terms-btn" onClick={() => { loadTerms(); loadLibraries(); notifyContentScript(); toast.success('已刷新'); }}>
            🔄 刷新
          </button>
        </div>
        
        {showNewLibForm && (
          <div className="new-lib-form-inline">
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
              placeholder="语言"
              style={{ width: '60px' }}
            />
            <button onClick={handleCreateLibrary}>创建</button>
          </div>
        )}
      </div>

      <div className="term-manager-toolbar">
        <input 
          type="text" 
          placeholder="搜索术语..." 
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="search-input"
        />
        <button className="add-term-btn" onClick={() => setShowAddForm(!showAddForm)}>
          {showAddForm ? '取消' : '+ 添加术语'}
        </button>
      </div>

{showAddForm && (
        <div className="add-term-form">
          <input
            type="text"
            value={newTermSource}
            onChange={(e) => setNewTermSource(e.target.value)}
            placeholder="源文本"
          />
          <input
            type="text"
            value={newTermTarget}
            onChange={(e) => setNewTermTarget(e.target.value)}
            placeholder="翻译"
          />
          <input
            type="text"
            value={newTermNote}
            onChange={(e) => setNewTermNote(e.target.value)}
            placeholder="备注 (可选)"
            className="note-input"
          />
          <label className="case-sensitive-label">
            <input
              type="checkbox"
              checked={newTermCaseSensitive}
              onChange={(e) => setNewTermCaseSensitive(e.target.checked)}
            />
            区分大小写
          </label>
          <button onClick={handleAddTerm}>添加</button>
        </div>
      )}

      <div className="terms-list-full">
        {filtered.length === 0 ? (
          <p className="empty-terms">暂无术语</p>
        ) : (
          filtered.map((term, i) => (
            <div key={i} className="term-item-full">
              <div className="term-content-full">
                <span className="term-source-full">{term.source}</span>
                <span className="term-arrow-full">→</span>
                <span className="term-target-full">{term.target}</span>
                {term.count > 1 && <span className="term-count-full">×{term.count}</span>}
                {term.caseSensitive && <span className="term-case-sensitive">Aa</span>}
                {term.note && <span className="term-note-badge" title={term.note}>📝</span>}
              </div>
              <div className="term-actions">
                <button className="edit-btn" onClick={() => setEditingTerm({ source: term.source, target: term.target, originalSource: term.source, caseSensitive: term.caseSensitive, note: term.note || '' })}>编辑</button>
                <button className="delete-btn" onClick={() => deleteTerm(term.source)}>删除</button>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="term-stats-full">
        共 {terms.length} 个术语
      </div>

      {editingTerm && (
        <div className="edit-overlay" onClick={() => setEditingTerm(null)}>
          <div className="edit-modal" onClick={(e) => e.stopPropagation()}>
            <h4>编辑术语</h4>
            <div className="edit-form">
              <label>源文本</label>
              <input
                type="text"
                value={editingTerm.source}
                onChange={(e) => setEditingTerm({ ...editingTerm, source: e.target.value })}
              />
              <label>翻译</label>
              <input
                type="text"
                value={editingTerm.target}
                onChange={(e) => setEditingTerm({ ...editingTerm, target: e.target.value })}
              />
              <label>备注</label>
              <input
                type="text"
                value={editingTerm.note}
                onChange={(e) => setEditingTerm({ ...editingTerm, note: e.target.value })}
              />
              <label className="case-sensitive-label">
                <input
                  type="checkbox"
                  checked={editingTerm.caseSensitive || false}
                  onChange={(e) => setEditingTerm({ ...editingTerm, caseSensitive: e.target.checked })}
                />
                区分大小写
              </label>
            </div>
            <div className="edit-actions">
              <button className="save-btn" onClick={handleEditTerm}>保存</button>
              <button className="cancel-btn" onClick={() => setEditingTerm(null)}>取消</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default TermManager;