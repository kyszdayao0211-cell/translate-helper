import { useState } from 'react';

function Login({ onLogin }) {
  const [loading, setLoading] = useState(false);

  const handleLogin = () => {
    setLoading(true);
    chrome.identity.getAuthToken({ interactive: true }, (token) => {
      setLoading(false);
      if (chrome.runtime.lastError) {
        console.error('登录失败:', chrome.runtime.lastError.message);
        return;
      }
      chrome.storage.local.set({ google_token: token }, () => {
        onLogin(token);
      });
    });
  };

  return (
    <div className="login-container">
      <div className="login-icon">🌍</div>
      <h2>翻译助手</h2>
      <p>连接 Google 表格进行翻译工作</p>
      <button className="login-btn" onClick={handleLogin} disabled={loading}>
        {loading ? '登录中...' : '使用 Google 账号登录'}
      </button>
    </div>
  );
}

export default Login;
