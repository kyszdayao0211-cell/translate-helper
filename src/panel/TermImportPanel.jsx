import { useState, useEffect } from 'react';
import toast from 'react-hot-toast';

function TermImportPanel({ token, onImport, onClose, title = '从 Google Sheet 导入术语库', buttonText = '导入' }) {
  const [spreadsheetId, setSpreadsheetId] = useState('');
  const [sheets, setSheets] = useState([]);
  const [selectedSheet, setSelectedSheet] = useState('');
  const [sourceCol, setSourceCol] = useState('A');
  const [targetCol, setTargetCol] = useState('B');
  const [noteCol, setNoteCol] = useState('');
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState(1);

  const fetchSheets = async () => {
    if (!spreadsheetId) {
      toast.error('请输入表格 ID');
      return;
    }
    setLoading(true);
    try {
      const response = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties.title,sheets.properties.sheetId`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!response.ok) throw new Error('获取工作表失败');
      const data = await response.json();
      const list = data.sheets?.map(s => ({
        id: s.properties.sheetId,
        title: s.properties.title
      })) || [];
      setSheets(list);
      if (list.length > 0) {
        setSelectedSheet(list[0].title);
      }
      setStep(2);
    } catch (err) {
      toast.error('获取工作表失败: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  const colToIndex = (col) => {
    if (!col) return 0;
    let index = 0;
    const upperCol = col.toUpperCase();
    for (let i = 0; i < upperCol.length; i++) {
      index = index * 26 + (upperCol.charCodeAt(i) - 64);
    }
    return index - 1;
  };

  const handleImport = async () => {
    if (!selectedSheet || !sourceCol || !targetCol) {
      toast.error('请填写完整的列信息');
      return;
    }
    setLoading(true);
    try {
      const cols = noteCol ? [sourceCol, targetCol, noteCol].sort() : [sourceCol, targetCol].sort();
      const rangeName = `${selectedSheet}!${cols[0]}:${cols[cols.length - 1]}`;
      const response = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(rangeName)}?majorDimension=ROWS`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!response.ok) throw new Error('获取数据失败');
      const data = await response.json();
      const values = data.values || [];
      
      const terms = [];
      const srcIdx = colToIndex(sourceCol);
      const tgtIdx = colToIndex(targetCol);
      const noteIdx = noteCol ? colToIndex(noteCol) : -1;
      values.forEach(row => {
        if (row[srcIdx] && row[tgtIdx]) {
          terms.push({
            source: row[srcIdx].trim(),
            target: row[tgtIdx].trim(),
            note: noteIdx >= 0 && row[noteIdx] ? row[noteIdx].trim() : ''
          });
        }
      });
      
      if (terms.length === 0) {
        toast.error('未找到有效术语数据');
        return;
      }
      
      onImport({
        spreadsheetId,
        sheetName: selectedSheet,
        sourceCol,
        targetCol,
        terms,
        termCount: terms.length
      });
      toast.success(`成功导入 ${terms.length} 条术语`);
      onClose();
    } catch (err) {
      toast.error('导入失败: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="import-panel-overlay">
      <div className="import-panel">
        <div className="import-panel-header">
          <h3>{title}</h3>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>
        
        <div className="import-panel-body">
          {step === 1 && (
            <div className="form-section">
              <label>表格 ID (URL 中 /d/ 后的部分):</label>
              <input
                type="text"
                value={spreadsheetId}
                onChange={(e) => setSpreadsheetId(e.target.value)}
                placeholder="例如: 1abc123..."
              />
              <p className="hint">表格 URL 格式: https://docs.google.com/spreadsheets/d/[表格ID]/edit</p>
            </div>
          )}
          
          {step === 2 && (
            <div className="form-section">
              <label>选择工作表:</label>
              <select
                value={selectedSheet}
                onChange={(e) => setSelectedSheet(e.target.value)}
              >
                {sheets.map(s => (
                  <option key={s.id} value={s.title}>{s.title}</option>
                ))}
              </select>
              
              <div className="col-inputs">
                <div className="col-input">
                  <label>源语言列:</label>
                  <input
                    type="text"
                    value={sourceCol}
                    onChange={(e) => setSourceCol(e.target.value.toUpperCase())}
                    maxLength={2}
                  />
                </div>
                <div className="col-input">
                  <label>目标语言列:</label>
                  <input
                    type="text"
                    value={targetCol}
                    onChange={(e) => setTargetCol(e.target.value.toUpperCase())}
                    maxLength={2}
                  />
                </div>
                <div className="col-input">
                  <label>备注列 (可选):</label>
                  <input
                    type="text"
                    value={noteCol}
                    onChange={(e) => setNoteCol(e.target.value.toUpperCase())}
                    maxLength={2}
                    placeholder="-"
                  />
                </div>
              </div>
              <p className="hint">第一行应为表头，术语数据从第二行开始</p>
            </div>
          )}
        </div>
        
        <div className="import-panel-footer">
          {step === 1 && (
            <button className="next-btn" onClick={fetchSheets} disabled={loading}>
              {loading ? '加载中...' : '下一步'}
            </button>
          )}
          {step === 2 && (
            <>
              <button className="back-btn" onClick={() => setStep(1)}>上一步</button>
              <button className="import-btn" onClick={handleImport} disabled={loading}>
                {loading ? '处理中...' : buttonText}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default TermImportPanel;