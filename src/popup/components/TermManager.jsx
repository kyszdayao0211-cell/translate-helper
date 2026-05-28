import { useState, useEffect } from 'react';

function TermManager() {
  const [terms, setTerms] = useState([]);
  const [search, setSearch] = useState('');

  useEffect(() => {
    loadTerms();
  }, []);

  const loadTerms = async () => {
    const result = await chrome.storage.local.get(['terms']);
    setTerms(result.terms || []);
  };

  const deleteTerm = async (sourceText) => {
    const updated = terms.filter(t => t.source !== sourceText);
    await chrome.storage.local.set({ terms: updated });
    setTerms(updated);
  };

  const filtered = terms.filter(t => 
    t.source.toLowerCase().includes(search.toLowerCase()) ||
    t.target.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="term-manager">
      <div className="search-box">
        <input 
          type="text" 
          placeholder="搜索术语..." 
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="terms-list">
        {filtered.length === 0 ? (
          <p className="empty">暂无术语，请先在翻译面板标记术语</p>
        ) : (
          filtered.map((term, i) => (
            <div key={i} className="term-item">
              <div className="term-content">
                <div className="term-source">
                  <span className="label">源:</span> {term.source}
                </div>
                <div className="term-target">
                  <span className="label">译:</span> {term.target}
                </div>
                {term.count && <span className="count">出现 {term.count} 次</span>}
              </div>
              <button className="delete-btn" onClick={() => deleteTerm(term.source)}>删除</button>
            </div>
          ))
        )}
      </div>

      <div className="term-stats">
        共 {terms.length} 个术语
      </div>
    </div>
  );
}

export default TermManager;