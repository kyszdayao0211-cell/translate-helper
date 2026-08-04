import { useState, useEffect } from 'react';
import toast from 'react-hot-toast';

const PRESETS = {
  anthropic: {
    label: 'Anthropic (Claude)',
    endpoint: 'https://api.anthropic.com/v1/messages',
    model: 'claude-sonnet-4-6',
    keyPlaceholder: 'sk-ant-...',
  },
  openai: {
    label: 'OpenAI',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-4o',
    keyPlaceholder: 'sk-...',
  },
  deepseek: {
    label: 'DeepSeek',
    endpoint: 'https://api.deepseek.com/v1/chat/completions',
    model: 'deepseek-v4-flash',
    keyPlaceholder: 'sk-...',
  },
  gemini: {
    label: 'Gemini',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    model: 'gemini-3.6-flash',
    keyPlaceholder: 'AIza...',
  },
  custom: {
    label: '自定义',
    endpoint: '',
    model: '',
    keyPlaceholder: 'API Key',
  },
};

function Settings() {
  const [apiType, setApiType] = useState('anthropic');
  const [apiKey, setApiKey] = useState('');
  const [endpoint, setEndpoint] = useState(PRESETS.anthropic.endpoint);
  const [model, setModel] = useState(PRESETS.anthropic.model);
  const [showKey, setShowKey] = useState(false);
  const [batchSize, setBatchSize] = useState(50);
  const [batchDelay, setBatchDelay] = useState(4);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    chrome.storage.local.get(['aiApiKey', 'aiApiType', 'aiEndpoint', 'aiModel', 'batchSize', 'batchDelay'], (result) => {
      const type = result.aiApiType || 'anthropic';
      setApiType(type);
      setApiKey(result.aiApiKey || '');
      setEndpoint(result.aiEndpoint || PRESETS[type]?.endpoint || '');
      setModel(result.aiModel || PRESETS[type]?.model || '');
      setBatchSize(result.batchSize || 50);
      setBatchDelay(result.batchDelay ?? 4);
    });
  }, []);

  const handleTypeChange = (type) => {
    setApiType(type);
    if (type !== 'custom') {
      setEndpoint(PRESETS[type].endpoint);
      setModel(PRESETS[type].model);
    }
  };

  const handleSave = async () => {
    const size = parseInt(batchSize, 10);
    if (isNaN(size) || size < 10 || size > 200) {
      toast.error('每批行数须在 10–200 之间');
      return;
    }
    if (!endpoint.trim()) {
      toast.error('请填写 API 端点');
      return;
    }
    if (!model.trim()) {
      toast.error('请填写模型名称');
      return;
    }
    setSaving(true);
    try {
      const delay = parseInt(batchDelay, 10);
      await chrome.storage.local.set({
        aiApiKey: apiKey.trim(),
        aiApiType: apiType,
        aiEndpoint: endpoint.trim(),
        aiModel: model.trim(),
        batchSize: size,
        batchDelay: isNaN(delay) ? 0 : Math.max(0, delay),
        // 兼容旧键名
        anthropicApiKey: apiType === 'anthropic' ? apiKey.trim() : undefined,
      });
      toast.success('设置已保存');
    } catch {
      toast.error('保存失败');
    } finally {
      setSaving(false);
    }
  };

  const preset = PRESETS[apiType];

  return (
    <div className="settings-panel">
      <h3>AI 翻译设置</h3>

      <div className="input-group">
        <label>API 类型</label>
        <div className="api-type-tabs">
          {Object.entries(PRESETS).map(([key, p]) => (
            <button
              key={key}
              className={`api-type-tab ${apiType === key ? 'active' : ''}`}
              onClick={() => handleTypeChange(key)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="input-group">
        <label>API Key</label>
        <div className="api-key-row">
          <input
            type={showKey ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={preset?.keyPlaceholder || 'API Key'}
            className="api-key-input"
          />
          <button
            className="toggle-show-btn"
            onClick={() => setShowKey(!showKey)}
          >
            {showKey ? '隐藏' : '显示'}
          </button>
        </div>
        <small>Key 仅存储在本地，不会上传到任何服务器</small>
      </div>

      <div className="input-group">
        <label>API 端点</label>
        <input
          type="text"
          value={endpoint}
          onChange={(e) => setEndpoint(e.target.value)}
          placeholder="https://..."
        />
      </div>

      <div className="input-group">
        <label>模型名称</label>
        <input
          type="text"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="模型 ID，如 gpt-4o"
        />
      </div>

      <div className="input-group">
        <label>每批翻译行数（10–200）</label>
        <input
          type="number"
          value={batchSize}
          onChange={(e) => setBatchSize(e.target.value)}
          min={10}
          max={200}
        />
      </div>

      <div className="input-group">
        <label>批次间隔（秒）</label>
        <input
          type="number"
          value={batchDelay}
          onChange={(e) => setBatchDelay(e.target.value)}
          min={0}
          max={60}
          step={1}
        />
        <small>
          遇到 429 限速时建议设为 4–5 秒。Gemini 免费层约 15次/分钟，
          每批 20 行时建议间隔 ≥ 4 秒。付费层可设为 0。
        </small>
      </div>

      <button className="load-btn" onClick={handleSave} disabled={saving}>
        {saving ? '保存中...' : '保存设置'}
      </button>
    </div>
  );
}

export default Settings;
