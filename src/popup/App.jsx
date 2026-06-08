import { useState, useEffect } from 'react';
import Login from './components/Login';
import SheetSelector from './components/SheetSelector';
import TermManager from './components/TermManager';
import Settings from './components/Settings';
import './styles.css';

function App() {
  const [token, setToken] = useState(null);
  const [currentSheet, setCurrentSheet] = useState(null);
  const [view, setView] = useState('selector');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    chrome.storage.local.get(['google_token'], (result) => {
      setToken(result.google_token || null);
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    if (token) {
      chrome.storage.local.set({ google_token: token });
    } else {
      chrome.storage.local.remove('google_token');
    }
  }, [token]);

  const handleLogout = () => {
    // Revoke the token
    if (token) {
      chrome.identity.removeCachedAuthToken({ token }, () => {});
    }
    setToken(null);
    setCurrentSheet(null);
    setView('selector');
  };

  if (!token) {
    return <Login onLogin={setToken} />;
  }

  const openPanel = () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('panel.html') });
  };

  return (
    <div className="popup-container">
      <header className="popup-header">
        <h1>翻译助手</h1>
        <div className="header-actions">
          <button className="panel-btn" onClick={openPanel}>打开工作面板</button>
          <button className="logout-btn" onClick={handleLogout}>退出</button>
        </div>
      </header>
      <nav className="popup-nav">
        <button className={view === 'selector' ? 'active' : ''} onClick={() => setView('selector')}>选择表格</button>
        <button className={view === 'terms' ? 'active' : ''} onClick={() => setView('terms')}>术语管理</button>
        <button className={view === 'settings' ? 'active' : ''} onClick={() => setView('settings')}>设置</button>
      </nav>
      <main className="popup-content">
        {view === 'selector' && (
          <SheetSelector 
            token={token} 
            onSheetSelect={setCurrentSheet}
            currentSheet={currentSheet}
          />
        )}
        {view === 'terms' && (
          <TermManager />
        )}
        {view === 'settings' && (
          <Settings />
        )}
      </main>
    </div>
  );
}

export default App;
