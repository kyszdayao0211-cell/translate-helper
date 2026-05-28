import { useState, useEffect, useCallback, useRef } from 'react';
import toast from 'react-hot-toast';

function TranslationWorkspace({ 
  token, 
  sheet, 
  sheets, 
  loadingSheets, 
  onSheetChange,
  sourceCol, 
  targetCol, 
  onColumnChange, 
  selectedSheetTitle,
  showIntermediate,
  intermediateCol,
  onIntermediateToggle,
  onIntermediateColChange,
  termLibraryBindingId,
  showTermsCol,
  onTermsColToggle
}) {
  const [rows, setRows] = useState([]);
  const [selectedCell, setSelectedCell] = useState(null);
  const [terms, setTerms] = useState([]);
  const [markingMode, setMarkingMode] = useState(null);
  const [tooltip, setTooltip] = useState({ visible: false, x: 0, y: 0, terms: [] });
  const [columnWidths, setColumnWidths] = useState({ source: 300, intermediate: 300, target: 300, terms: 250 });
  const [pageSize, setPageSize] = useState(200);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalRows, setTotalRows] = useState(1000);
  const [loadingData, setLoadingData] = useState(false);
  const [useRange, setUseRange] = useState(false);
  const [rangeStart, setRangeStart] = useState(1);
  const [rangeEnd, setRangeEnd] = useState(200);
  const [autoCheckTerms, setAutoCheckTerms] = useState(false);
  const [showPopup, setShowPopup] = useState(false);
  const [popupData, setPopupData] = useState([]);
  const hasCheckedRef = useRef(false);
  const workspaceRef = useRef(null);
  const resizingRef = useRef(null);
  const columnWidthsRef = useRef(columnWidths);
  const tooltipRef = useRef(null);
  const textareaRefs = useRef({});
  const termsRef = useRef([]);
  const saveTimerRef = useRef(null);
  const pendingSaveRef = useRef(null);
  const dirtyCellsRef = useRef({});
  const [dirtyCount, setDirtyCount] = useState(0);
  const [headerCollapsed, setHeaderCollapsed] = useState(false);
  const headerLoadedRef = useRef(false);
  const [dismissedHint, setDismissedHint] = useState(false);

  useEffect(() => {
    chrome.storage.local.get(['headerCollapsed', 'dismissedHint'], (result) => {
      if (result.headerCollapsed !== undefined) {
        setHeaderCollapsed(result.headerCollapsed);
      }
      if (result.dismissedHint !== undefined) {
        setDismissedHint(result.dismissedHint);
      }
      headerLoadedRef.current = true;
    });
  }, []);

  const toggleHeader = () => {
    const next = !headerCollapsed;
    setHeaderCollapsed(next);
    chrome.storage.local.set({ headerCollapsed: next });
  };

  const dismissToolbarHint = () => {
    setDismissedHint(true);
    chrome.storage.local.set({ dismissedHint: true });
  };

  const persistDirtyCell = async (rangeKey, cellData) => {
    const result = await chrome.storage.local.get(['pendingEdits']);
    const pending = result.pendingEdits || {};
    pending[sheet?.id ? sheet.id + '_' + rangeKey : rangeKey] = cellData;
    await chrome.storage.local.set({ pendingEdits: pending });
  };

  const removePersistedDirtyCell = async (rangeKey) => {
    const result = await chrome.storage.local.get(['pendingEdits']);
    const pending = result.pendingEdits || {};
    delete pending[sheet?.id ? sheet.id + '_' + rangeKey : rangeKey];
    await chrome.storage.local.set({ pendingEdits: pending });
  };

  const loadPendingEdits = async () => {
    const result = await chrome.storage.local.get(['pendingEdits']);
    const allPending = result.pendingEdits || {};
    if (!sheet?.id) return {};
    const prefix = sheet.id + '_';
    const filtered = {};
    for (const key of Object.keys(allPending)) {
      if (key.startsWith(prefix)) {
        filtered[key.slice(prefix.length)] = allPending[key];
      }
    }
    return filtered;
  };

  // 每次请求前获取最新 token，避免 prop 中的 token 过期
  const getFreshToken = () => new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: false }, (t) => {
      if (chrome.runtime.lastError || !t) {
        // 过期时先清缓存再重新获取
        chrome.identity.removeCachedAuthToken({ token: t || '' }, () => {
          chrome.identity.getAuthToken({ interactive: true }, (newT) => {
            if (chrome.runtime.lastError || !newT) {
              reject(new Error('获取授权失败，请重新登录'));
            } else {
              resolve(newT);
            }
          });
        });
      } else {
        resolve(t);
      }
    });
  });
  const [filteredRowIndices, setFilteredRowIndices] = useState(null);
  const [selectedRows, setSelectedRows] = useState(new Set());
  const dragStateRef = useRef({ isDown: false, startRow: null, startX: 0, startY: 0, isDragging: false });

  const displayRows = filteredRowIndices
    ? rows.filter(row => filteredRowIndices.has(row.index))
    : rows;

  const autoResizeTextarea = (textarea) => {
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = textarea.scrollHeight + 'px';
  };

  const textareaRefCallback = useCallback((el) => {
    if (!el) return;
    const index = parseInt(el.dataset.rowIndex);
    textareaRefs.current[index] = el;
    autoResizeTextarea(el);
  }, []);

useEffect(() => {
    if (!sheet?.id) return;
    hasCheckedRef.current = false;
    const initData = async () => {
      await loadTerms();
      await loadSheetData();
      loadColumnWidths();
    };
    initData();
    
    // 监听来自content script的过滤变化消息
    const handleMessage = (message) => {
      if (message.type === 'FILTER_CHANGED') {
        console.log('[Filter sync]', message.visibleRows.length, 'rows visible');
        // 直接用推送过来的行号更新，不需要再触发 handleSyncFilter
        applyFilterToPanel(message.visibleRows);
      }
    };

    chrome.runtime.onMessage.addListener(handleMessage);
    
    const handleStorageChange = (changes, area) => {
      if (area === 'local' && (changes.terms || changes.termLibraries)) {
        loadTerms().then(() => recalcMatchedTerms());
      }
      if (area === 'local' && changes.markedTerms) {
        recalcMatchedTerms();
      }
    };
    chrome.storage.onChanged.addListener(handleStorageChange);
    
    return () => {
      chrome.runtime.onMessage.removeListener(handleMessage);
      chrome.storage.onChanged.removeListener(handleStorageChange);
    };
  }, [sheet?.id, sourceCol, targetCol, selectedSheetTitle, showIntermediate, intermediateCol, termLibraryBindingId, currentPage, rangeStart, rangeEnd]);

  useEffect(() => {
    if (!loadingData && rows.length > 0) {
      if (autoCheckTerms && terms.length > 0 && !hasCheckedRef.current) {
        hasCheckedRef.current = true;
        checkTermLibraryConsistency(terms);
      }
    }
  }, [loadingData, rows, autoCheckTerms, terms]);

  useEffect(() => { columnWidthsRef.current = columnWidths; }, [columnWidths]);

  const loadColumnWidths = async () => {
    const result = await chrome.storage.local.get(['columnWidths']);
    if (result.columnWidths) {
      setColumnWidths(result.columnWidths);
    }
  };

  const saveColumnWidths = async (widths) => {
    await chrome.storage.local.set({ columnWidths: widths });
  };

  const loadTerms = async () => {
    try {
      const result = await chrome.storage.local.get(['terms', 'termLibraries']);
      const allTerms = result.terms || [];
      const libraries = result.termLibraries || [];
      
      let filteredTerms = allTerms;
      
      if (termLibraryBindingId) {
        const lib = libraries.find(l => l.id === termLibraryBindingId);
        if (lib) {
          if (lib.source === 'remote' && lib.terms) {
            filteredTerms = lib.terms;
          } else {
            filteredTerms = allTerms.filter(t => t.libraryId === termLibraryBindingId);
          }
        }
      }
      
      setTerms(filteredTerms);
      termsRef.current = filteredTerms;
    } catch (err) {
      console.error('加载术语失败:', err);
      setTerms([]);
      termsRef.current = [];
    }
  };

  const getAllTermsFromStorage = async () => {
    const result = await chrome.storage.local.get(['terms']);
    return result.terms || [];
  };

  const handleHighlightTerms = () => {
    const currentTerms = termsRef.current;
    if (!currentTerms.length) {
      toast.error('暂无术语，请先添加术语');
      return;
    }
    
    const highlightMatches = rows.map(row => {
      if (!row.source) return { ...row, highlighted: false, matchedTerms: [] };
      const matchedTerms = currentTerms.filter(t => {
        if (!t.source) return false;
        if (t.caseSensitive) {
          return row.source.includes(t.source);
        } else {
          return row.source.toLowerCase().includes(t.source.toLowerCase());
        }
      });
      return {
        ...row,
        highlighted: matchedTerms.length > 0,
        matchedTerms: matchedTerms
      };
    });
    
    setRows(highlightMatches);
    const count = highlightMatches.filter(r => r.highlighted).length;
    toast.success(`已扫描 ${count} 个高亮术语`);
  };

  const handleClearHighlights = () => {
    const clearMatches = rows.map(row => ({
      ...row,
      highlighted: false,
      matchedTerms: [],
      marked: false
    }));
    setRows(clearMatches);
    toast.success('已清除高亮');
  };

  const checkTermLibraryConsistency = (termList) => {
    const newRows = rows.map((row) => {
      if (!row.source) return { ...row, inconsistent: false, inconsistentReason: '' };
      
      const matchedTerm = termList.find(t => t.source === row.source);
      if (matchedTerm && row.target && row.target.trim() !== matchedTerm.target.trim()) {
        return { ...row, inconsistent: true, inconsistentReason: `标准译法: "${matchedTerm.target}"` };
      }
      return { ...row, inconsistent: false, inconsistentReason: '' };
    });
    
    setRows(newRows);
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

  const getColumnIndexMap = () => {
    let startCol;
    if (showIntermediate && intermediateCol) {
      const cols = [sourceCol, intermediateCol, targetCol].sort();
      startCol = cols[0];
    } else {
      startCol = sourceCol < targetCol ? sourceCol : targetCol;
    }
    
    const startIndex = colToIndex(startCol);
    
    return {
      source: colToIndex(sourceCol) - startIndex,
      target: colToIndex(targetCol) - startIndex,
      ...(showIntermediate && intermediateCol && { 
        intermediate: colToIndex(intermediateCol) - startIndex 
      })
    };
  };

  const loadSheetData = async (forceRange = null) => {
    try {
      setLoadingData(true);
      setFilteredRowIndices(null);
      setSelectedRows(new Set());
      
      let colRange;
      if (showIntermediate && intermediateCol) {
        const cols = [sourceCol, intermediateCol, targetCol].sort();
        colRange = `${cols[0]}:${cols[2]}`;
      } else {
        const sorted = [sourceCol, targetCol].sort();
        colRange = `${sorted[0]}:${sorted[1]}`;
      }
      
      const sheetTitle = selectedSheetTitle || (sheet?.title ?? '');
      
      let startRow, endRow;
      if (forceRange) {
        startRow = forceRange.start;
        endRow = forceRange.end;
      } else if (useRange) {
        startRow = Math.max(1, parseInt(rangeStart) || 1);
        endRow = parseInt(rangeEnd) || startRow + pageSize - 1;
      } else {
        startRow = (currentPage - 1) * pageSize + 1;
        endRow = currentPage * pageSize;
      }
      
      startRow = parseInt(startRow) || 1;
      endRow = parseInt(endRow) || startRow + pageSize - 1;
      
      const rangeName = sheetTitle ? `${sheetTitle}!${colRange.substring(0, 1)}${startRow}:${colRange.substring(colRange.length - 1)}${endRow}` : `${colRange.substring(0, 1)}${startRow}:${colRange.substring(colRange.length - 1)}${endRow}`;
      
      const freshToken = await getFreshToken();
      const response = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${sheet.id}/values/${encodeURIComponent(rangeName)}?majorDimension=ROWS`,
        { headers: { Authorization: `Bearer ${freshToken}` } }
      );
      
      if (!response.ok) throw new Error(`加载失败 (${response.status})`);
      
      const data = await response.json();
      const values = data.values || [];
      
      if (!useRange && values.length > 0) {
        try {
          const metaResponse = await fetch(
            `https://sheets.googleapis.com/v4/spreadsheets/${sheet.id}?fields=sheets.properties.gridProperties.rowCount`,
            { headers: { Authorization: `Bearer ${freshToken}` } }
          );
          if (metaResponse.ok) {
            const metaData = await metaResponse.json();
            const totalRowsFromMeta = metaData.sheets?.[0]?.properties?.gridProperties?.rowCount || 0;
            if (totalRowsFromMeta > 0) {
              setTotalRows(totalRowsFromMeta);
            }
          }
        } catch (e) {
          console.error('获取总行数失败', e);
        }
      }
      
      const colIndexMap = getColumnIndexMap();
      
      const markedResult = await chrome.storage.local.get(['markedTerms']);
      const markedTerms = markedResult.markedTerms || [];
      
      const findMatchingTerms = (text) => {
        const currentTerms = termsRef.current;
        if (!text || !currentTerms.length) return [];
        return currentTerms.filter(t => {
          if (!t.source) return false;
          if (t.caseSensitive) {
            return text.includes(t.source);
          } else {
            return text.toLowerCase().includes(t.source.toLowerCase());
          }
        });
      };

      const pendingEdits = await loadPendingEdits();

      const builtRows = values.map((row, i) => {
        const sourceText = row[colIndexMap.source] || '';
        const matchedTerms = findMatchingTerms(sourceText);
        const rowNum = startRow + i;
        return {
          index: rowNum,
          source: sourceText,
          intermediate: showIntermediate ? (row[colIndexMap.intermediate] || '') : '',
          target: row[colIndexMap.target] || '',
          marked: markedTerms.includes(sourceText.trim()) && matchedTerms.length > 0,
          highlighted: matchedTerms.length > 0,
          matchedTerms: matchedTerms,
          inconsistent: false,
          inconsistentReason: ''
        };
      });

      // 合并本地未同步的编辑到已加载的行
      let restored = 0;
      for (const [rangeKey, cellData] of Object.entries(pendingEdits)) {
        const match = rangeKey.match(/([A-Z]+)(\d+)/);
        if (!match) continue;
        const rowNum = parseInt(match[2]);
        const rowArrayIndex = rowNum - startRow;
        if (rowArrayIndex >= 0 && rowArrayIndex < builtRows.length) {
          builtRows[rowArrayIndex].target = cellData.value;
          dirtyCellsRef.current[rangeKey] = cellData;
          restored++;
        }
      }
      if (restored > 0) {
        setDirtyCount(Object.keys(dirtyCellsRef.current).length);
        toast.success(`已恢复 ${restored} 个未同步的本地编辑`, { duration: 3000 });
      }
      setRows(builtRows);

      if (forceRange || useRange) {
        setTotalRows(endRow);
      } else {
        const rowCount = values.length > 0 ? startRow + values.length - 1 : totalRows;
        setTotalRows(Math.max(rowCount, totalRows));
      }
      
    } catch (err) {
      console.error(err);
      toast.error('加载表格失败');
    } finally {
      setLoadingData(false);
    }
  };

  const totalPages = Math.ceil(totalRows / pageSize);

  const goToPage = (page) => {
    if (page >= 1 && page <= totalPages) {
      const dirtyKeys = Object.keys(dirtyCellsRef.current);
      if (dirtyKeys.length > 0) {
        toast.warning(`有 ${dirtyKeys.length} 个未保存的更改，翻页后将会暂时隐藏，返回后可继续保存`, { duration: 3000 });
      }
      setCurrentPage(page);
    }
  };

  const handleManualCheck = () => {
    if (terms.length > 0 && rows.length > 0) {
      checkTermLibraryConsistency(terms);
      toast.success('术语一致性检查完成');
    } else {
      toast.error('没有可检查的术语');
    }
  };

  const handleCheckAllTerms = async () => {
    if (!sheet?.id) {
      toast.error('没有选中的表格');
      return;
    }
    
    await loadTerms();
    
    if (!termsRef.current.length) {
      toast.error('没有可检查的术语');
      return;
    }
    
    const currentTerms = termsRef.current;
    
    toast.loading('正在检查全表...', { id: 'checkAll' });
    
    try {
      let colRange;
      if (showIntermediate && intermediateCol) {
        const cols = [sourceCol, intermediateCol, targetCol].sort();
        colRange = `${cols[0]}:${cols[2]}`;
      } else {
        const sorted = [sourceCol, targetCol].sort();
        colRange = `${sorted[0]}:${sorted[1]}`;
      }
      
      const sheetTitle = selectedSheetTitle || (sheet?.title ?? '');
      const rangeName = sheetTitle ? `${sheetTitle}!${colRange}` : colRange;
      
      const response = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${sheet.id}/values/${encodeURIComponent(rangeName)}?majorDimension=ROWS`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      
      if (!response.ok) throw new Error('加载失败');
      
      const data = await response.json();
      const allValues = data.values || [];
      const colIndexMap = getColumnIndexMap();
      
      const inconsistentRows = [];
      allValues.forEach((row, index) => {
        const sourceText = row[colIndexMap.source]?.trim();
        const targetText = row[colIndexMap.target]?.trim();
        
        if (!sourceText) return;
        
        const matchedTerm = currentTerms.find(t => 
          t.source && sourceText.includes(t.source)
        );
        if (matchedTerm && targetText && !targetText.includes(matchedTerm.target)) {
          inconsistentRows.push({ row: index + 1, source: sourceText, expected: matchedTerm.target, actual: targetText });
        }
      });
      
      toast.dismiss('checkAll');
      
      if (inconsistentRows.length > 0) {
        showInconsistentPopup(inconsistentRows);
      } else {
        toast.success('全表检查完成，未发现不一致');
      }
    } catch (err) {
      toast.dismiss('checkAll');
      toast.error('检查失败: ' + err.message);
    }
  };
  
  const showInconsistentPopup = (data) => {
    setPopupData(data);
    setShowPopup(true);
  };

  const closePopup = () => {
    setShowPopup(false);
    setPopupData([]);
  };

  const handleExportSheet = async (type) => {
    const exportRows = displayRows;
    if (!sheet?.id || exportRows.length === 0) {
      toast.error('没有可导出的数据');
      return;
    }
    
    if (type === 'csv') {
      const csvContent = '行号,源文本,目标翻译\n' + exportRows.map(r => 
        `${r.index},"${(r.source || '').replace(/"/g, '""')}","${(r.target || '').replace(/"/g, '""')}"`
      ).join('\n');
      
      const blob = new Blob(['\ufeff' + csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${sheet?.title || '翻译结果'}_${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      
      toast.success(`已导出 ${exportRows.length} 行数据`);
    } else if (type === 'sheet') {
      try {
        toast.loading('正在创建新表格...', { id: 'exportSheet' });
        
        const response = await fetch(
          'https://sheets.googleapis.com/v4/spreadsheets',
          {
            method: 'POST',
            headers: { 
              Authorization: `Bearer ${token}`, 
              'Content-Type': 'application/json' 
            },
            body: JSON.stringify({
              properties: { title: `${sheet?.title || '翻译结果'}_导出` },
              sheets: [{
                data: [{
                  startRow: 0,
                  startColumn: 0,
                  rowData: exportRows.map(r => ({
                    values: [
                      { userEnteredValue: { stringValue: String(r.index) } },
                      { userEnteredValue: { stringValue: r.source || '' } },
                      { userEnteredValue: { stringValue: r.target || '' } }
                    ]
                  }))
                }]
              }]
            })
          }
        );
        
        toast.dismiss('exportSheet');
        
        if (!response.ok) throw new Error('创建表格失败');
        
        const data = await response.json();
        const spreadsheetUrl = `https://docs.google.com/spreadsheets/d/${data.spreadsheetId}/edit`;
        
        toast.success(<div>表格创建成功！<br/><a href={spreadsheetUrl} target="_blank" rel="noopener noreferrer">点击打开</a></div>, { duration: 10000 });
      } catch (err) {
        toast.dismiss('exportSheet');
        toast.error('导出失败: ' + err.message);
      }
    }
  };

  const findTermsInText = (text) => {
    if (!text) return [];
    return terms.filter(t => {
      if (!t.source) return false;
      if (t.caseSensitive) {
        return text.includes(t.source);
      } else {
        return text.toLowerCase().includes(t.source.toLowerCase());
      }
    });
  };

  const recalcMatchedTerms = useCallback(async () => {
    const currentTerms = termsRef.current;
    const result = await chrome.storage.local.get(['markedTerms']);
    const markedTerms = result.markedTerms || [];
    setRows(prevRows => prevRows.map(row => {
      if (!row.source) return row;
      const matched = currentTerms.filter(t => {
        if (!t.source) return false;
        if (t.caseSensitive) return row.source.includes(t.source);
        return row.source.toLowerCase().includes(t.source.toLowerCase());
      });
      return {
        ...row,
        highlighted: matched.length > 0,
        matchedTerms: matched,
        marked: markedTerms.includes(row.source.trim()) && matched.length > 0
      };
    }));
  }, []);

  const saveTerm = async (sourceText, targetText) => {
    // 如果绑定的是远程库，直接更新 lib.terms
    if (termLibraryBindingId) {
      const libsResult = await chrome.storage.local.get(['termLibraries']);
      const libraries = libsResult.termLibraries || [];
      const libIdx = libraries.findIndex(l => l.id === termLibraryBindingId);
      if (libIdx >= 0 && libraries[libIdx].source === 'remote') {
        const lib = { ...libraries[libIdx] };
        const existingIdx = (lib.terms || []).findIndex(t => t.source === sourceText);
        if (existingIdx >= 0) {
          lib.terms[existingIdx] = { ...lib.terms[existingIdx], target: targetText };
        } else {
          lib.terms = [...(lib.terms || []), { source: sourceText, target: targetText }];
        }
        lib.termCount = lib.terms.length;
        libraries[libIdx] = lib;
        await chrome.storage.local.set({ termLibraries: libraries });
      }
    }

    const allTerms = await getAllTermsFromStorage();
    
    const existingIndex = allTerms.findIndex(t => t.source === sourceText);
    let newTerms;
    
    if (existingIndex >= 0) {
      newTerms = [...allTerms];
      newTerms[existingIndex] = { 
        ...newTerms[existingIndex], 
        target: targetText,
        count: (newTerms[existingIndex].count || 1) + 1,
        lastUsed: new Date().toISOString(),
        ...(termLibraryBindingId && { libraryId: termLibraryBindingId })
      };
    } else {
      newTerms = [...allTerms, { 
        source: sourceText, 
        target: targetText,
        note: '',
        count: 1,
        created: new Date().toISOString(),
        ...(termLibraryBindingId && { libraryId: termLibraryBindingId })
      }];
    }
    
    await chrome.storage.local.set({ terms: newTerms });
    
    const filteredTerms = termLibraryBindingId 
      ? newTerms.filter(t => !t.libraryId || t.libraryId === termLibraryBindingId)
      : newTerms;
    setTerms(filteredTerms);
    
    const markedResult = await chrome.storage.local.get(['markedTerms']);
    const markedTerms = markedResult.markedTerms || [];
    if (!markedTerms.includes(sourceText)) {
      markedTerms.push(sourceText);
      await chrome.storage.local.set({ markedTerms });
    }
    
    setRows(prevRows => prevRows.map(row => 
      row.source === sourceText ? { ...row, marked: true } : row
    ));
    
    toast.success('术语已保存');
    
    checkConsistency(sourceText, targetText);
    
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, { type: 'REFRESH_TERMS' });
      }
    });
  };

  const checkConsistency = (sourceText, targetText) => {
    const inconsistentRows = [];
    const newRows = rows.map((row, index) => {
      if (row.source === sourceText && row.target && row.target !== targetText) {
        inconsistentRows.push(index + 1);
        return { ...row, inconsistent: true };
      }
      return { ...row, inconsistent: false };
    });
    setRows(newRows);
    
    if (inconsistentRows.length > 0) {
      toast.error(`发现 ${inconsistentRows.length} 处不一致: 行 ${inconsistentRows.join(', ')}`);
    }
  };

  const clearInconsistencies = () => {
    const newRows = rows.map(row => ({ ...row, inconsistent: false }));
    setRows(newRows);
  };

  const clearRowInconsistency = (rowIndex) => {
    setRows(prevRows => prevRows.map((row, idx) =>
      idx === rowIndex ? { ...row, inconsistent: false, inconsistentReason: '' } : row
    ));
  };

   const getVisibleRowsFromApi = async () => {
     const res = await fetch(
       `https://sheets.googleapis.com/v4/spreadsheets/${sheet.id}?includeGridData=true&ranges=${encodeURIComponent(selectedSheetTitle)}&fields=sheets(properties(gridProperties),data(rowMetadata))`,
       { headers: { Authorization: `Bearer ${token}` } }
     );
     if (!res.ok) throw new Error(`API error: ${res.status}`);
     const data = await res.json();
     if (!data.sheets?.[0]?.data?.[0]?.rowMetadata) return [];
     const rowMetadata = data.sheets[0].data[0].rowMetadata;
     const frozenRowCount = data.sheets[0].properties?.gridProperties?.frozenRowCount ?? 0;
     const visibleRows = [];
     rowMetadata.forEach((row, index) => {
       const rowNumber = index + 1;
       if (rowNumber <= frozenRowCount) return;
       if (row.hiddenByFilter !== true && row.hiddenByUser !== true) {
         visibleRows.push(rowNumber);
       }
     });
     return visibleRows;
   };

   const handleSyncFilterPage = async () => {
     if (!sheet?.id || !token || !selectedSheetTitle) {
       toast.error('请先选择表格');
       return;
     }
     toast.loading('正在同步筛选...', { id: 'syncFilter' });
     try {
       const visibleRows = await getVisibleRowsFromApi();
       if (visibleRows.length === 0) {
         toast.dismiss('syncFilter');
         toast.error('筛选结果为空');
         return;
       }
       const visibleSet = new Set(visibleRows);
       setFilteredRowIndices(visibleSet);
       toast.dismiss('syncFilter');
       toast.success(`已同步：本页显示 ${rows.filter(r => visibleSet.has(r.index)).length} 行`);
     } catch (err) {
       toast.dismiss('syncFilter');
       toast.error('同步失败: ' + err.message);
     }
   };

   const handleSyncFilter = async () => {
     if (!sheet?.id || !token || !selectedSheetTitle) {
       toast.error('请先选择表格');
       return;
     }
     toast.loading('正在同步筛选...', { id: 'syncFilter' });
     try {
       const visibleRows = await getVisibleRowsFromApi();
       if (visibleRows.length === 0) {
         toast.dismiss('syncFilter');
         toast.error('筛选结果为空，请检查 Google 表格筛选状态');
         return;
       }
       const firstVisible = visibleRows[0];
       const lastVisible = visibleRows[visibleRows.length - 1];
       setUseRange(true);
       setRangeStart(firstVisible);
       setRangeEnd(lastVisible);
       await loadSheetData({ start: firstVisible, end: lastVisible });
       const visibleSet = new Set(visibleRows);
       setFilteredRowIndices(visibleSet);
       toast.dismiss('syncFilter');
       toast.success(`已同步筛选：共 ${visibleRows.length} 行可见 (行 ${firstVisible}-${lastVisible})`);
     } catch (err) {
       toast.dismiss('syncFilter');
       toast.error('同步失败: ' + err.message);
     }
   };

   const handleClearFilter = () => {
     setFilteredRowIndices(null);
     toast.success('已清除筛选');
   };

   const applyFilterToPanel = (visibleRows) => {
     const rowSet = new Set(visibleRows);
     setFilteredRowIndices(rowSet);
   };

  const handleKeyDown = async (e) => {
    if (selectedRows.size === 0) return;
    if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
      e.preventDefault();
      e.stopPropagation();
      const sortedIndices = [...selectedRows].sort((a, b) => a - b);
      const values = sortedIndices.map(idx => rows[idx]?.target || '').join('\n');
      try {
        await navigator.clipboard.writeText(values);
        toast.success(`已复制 ${selectedRows.size} 个单元格`);
      } catch { toast.error('复制失败'); }
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V')) {
      e.preventDefault();
      e.stopPropagation();
      try {
        const text = await navigator.clipboard.readText();
        const values = text.split('\n').map(v => v.trim());
        const sortedIndices = [...selectedRows].sort((a, b) => a - b);
        sortedIndices.forEach((idx, i) => {
          if (i < values.length) updateCell(idx, values[i] || '', 'target');
        });
        toast.success(`已粘贴 ${Math.min(sortedIndices.length, values.length)} 个单元格`);
      } catch { toast.error('粘贴失败'); }
    }
  };

  const handleSelectionMouseUp = () => {
    const ds = dragStateRef.current;
    ds.isDragging = false;
    ds.isDown = false;
  };

  const handleRowMouseDown = (rowArrayIndex, e) => {
    if (e.shiftKey) {
      e.preventDefault();
      setSelectedRows(prev => {
        if (prev.size === 0) return new Set([rowArrayIndex]);
        const sortedPrev = [...prev].sort((a, b) => a - b);
        const start = Math.min(sortedPrev[0], rowArrayIndex);
        const end = Math.max(sortedPrev[sortedPrev.length - 1], rowArrayIndex);
        const newSet = new Set();
        for (let i = start; i <= end; i++) newSet.add(i);
        return newSet;
      });
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      setSelectedRows(prev => {
        const newSet = new Set(prev);
        if (newSet.has(rowArrayIndex)) newSet.delete(rowArrayIndex);
        else newSet.add(rowArrayIndex);
        return newSet;
      });
      return;
    }
    const ds = dragStateRef.current;
    ds.isDown = true;
    ds.startRow = rowArrayIndex;
    ds.startX = e.clientX;
    ds.startY = e.clientY;
    ds.isDragging = false;
    setSelectedRows(new Set([rowArrayIndex]));
  };

  const handleRowMouseMove = (rowArrayIndex, e) => {
    const ds = dragStateRef.current;
    if (!ds.isDown) return;
    if (e.buttons !== 1) {
      ds.isDown = false;
      ds.isDragging = false;
      return;
    }
    if (!ds.isDragging) {
      const dx = Math.abs(e.clientX - ds.startX);
      const dy = Math.abs(e.clientY - ds.startY);
      if (dy < 3 && dx < 3) return;
      ds.isDragging = true;
    }
    if (ds.isDragging && ds.startRow !== null) {
      const start = Math.min(ds.startRow, rowArrayIndex);
      const end = Math.max(ds.startRow, rowArrayIndex);
      const newSet = new Set();
      for (let i = start; i <= end; i++) newSet.add(i);
      setSelectedRows(newSet);
    }
  };

  const handleCellSelect = (rowIndex, col, event) => {
    const row = rows[rowIndex];
    const text = col === 'source' ? row.source : col === 'intermediate' ? row.intermediate : row.target;
    setSelectedCell({ rowIndex, col, text });

    if (col === 'source' && text) {
      const matchedTerms = findTermsInText(text);
      if (matchedTerms.length > 0) {
        const rect = event?.currentTarget?.getBoundingClientRect();
        if (rect) {
          showTermTooltip(matchedTerms, rect);
        }
      }
    }
  };

  const handleTextSelect = () => {
    if (dragStateRef.current.isDragging) return;
    const selection = window.getSelection();
    const text = selection.toString().trim();
    if (!text || !selectedCell) return;
    
    const matchedTerms = findTermsInText(text);
    if (matchedTerms.length > 0) {
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      showTermTooltip(matchedTerms, rect);
    }
    
    if (selectedCell.col === 'source') {
      setMarkingMode({ type: 'source', text, rowIndex: selectedCell.rowIndex });
      toast.success(`已选择 "${text}"，现在点击目标语言列标记术语`);
    } else if (selectedCell.col === 'target' && markingMode?.type === 'source') {
      const newRows = [...rows];
      newRows[selectedCell.rowIndex].marked = true;
      setRows(newRows);
      saveTerm(markingMode.text, text);
      setMarkingMode(null);
      toast.success('术语标记成功');
    }
  };

  const showTermTooltip = (matchedTerms, rect) => {
    setTooltip({
      visible: true,
      x: rect.left + rect.width / 2,
      y: rect.top - 10,
      terms: matchedTerms
    });
  };

  const closeTooltip = () => {
    setTooltip({ visible: false, x: 0, y: 0, terms: [] });
  };

  const checkTermReminder = useCallback((text) => {
    const matched = terms.find(t => {
      if (!t.source) return false;
      if (t.caseSensitive) {
        return text.includes(t.source);
      } else {
        return text.toLowerCase().includes(t.source.toLowerCase());
      }
    });
    if (matched) {
      return { show: true, translation: matched.target, count: matched.count };
    }
    return { show: false };
  }, [terms]);

  const updateCell = (rowIndex, value, col) => {
    const newRows = [...rows];
    newRows[rowIndex][col] = value;
    setRows(newRows);
    
    let colLetter;
    if (col === 'source') colLetter = sourceCol;
    else if (col === 'intermediate') colLetter = intermediateCol;
    else colLetter = targetCol;
    
    const sheetTitle = selectedSheetTitle || (sheet?.title ?? '');
    const sheetRow = rows[rowIndex]?.index || rowIndex + 1;
    const cellRef = `${colLetter}${sheetRow}`;
    const rangeName = sheetTitle ? `${sheetTitle}!${cellRef}` : cellRef;
    const encodedRange = encodeURIComponent(rangeName);
    
    const cellData = { value, range: encodedRange, timestamp: Date.now() };
    dirtyCellsRef.current[encodedRange] = cellData;
    setDirtyCount(Object.keys(dirtyCellsRef.current).length);
    persistDirtyCell(encodedRange, cellData);
    
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    pendingSaveRef.current = { encodedRange, value, sheetId: sheet?.id };
    saveTimerRef.current = setTimeout(async () => {
      const save = pendingSaveRef.current;
      if (!save || !save.sheetId) return;
      try {
        const freshToken = await getFreshToken();
        const res = await fetch(
          `https://sheets.googleapis.com/v4/spreadsheets/${save.sheetId}/values/${save.encodedRange}?valueInputOption=RAW`,
          {
            method: 'PUT',
            headers: { 
              Authorization: `Bearer ${freshToken}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ values: [[save.value]] })
          }
        );
        if (res.ok && dirtyCellsRef.current[save.encodedRange]) {
          delete dirtyCellsRef.current[save.encodedRange];
          setDirtyCount(Object.keys(dirtyCellsRef.current).length);
          removePersistedDirtyCell(save.encodedRange);
        }
      } catch (err) {
        console.error('保存失败:', err);
      }
    }, 500);
  };

  const handleManualSave = async () => {
    const keys = Object.keys(dirtyCellsRef.current);
    if (keys.length === 0) {
      toast.success('没有需要保存的内容');
      return;
    }
    toast.loading(`正在保存 ${keys.length} 个单元格...`, { id: 'manualSave' });
    let success = 0;
    let fail = 0;
    const freshToken = await getFreshToken();
    for (const key of keys) {
      const cell = dirtyCellsRef.current[key];
      if (!cell) continue;
      try {
        const res = await fetch(
          `https://sheets.googleapis.com/v4/spreadsheets/${sheet.id}/values/${cell.range}?valueInputOption=RAW`,
          {
            method: 'PUT',
            headers: { Authorization: `Bearer ${freshToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ values: [[cell.value]] })
          }
        );
        if (res.ok) {
          delete dirtyCellsRef.current[key];
          removePersistedDirtyCell(key);
          success++;
        } else {
          fail++;
        }
      } catch {
        fail++;
      }
    }
    toast.dismiss('manualSave');
    setDirtyCount(Object.keys(dirtyCellsRef.current).length);
    if (fail === 0) {
      toast.success(`全部保存成功 (${success} 个)`);
    } else {
      toast.warning(`保存完成：${success} 成功，${fail} 失败。请重连后重新保存`);
    }
  };

  const handleTargetBlur = (rowIndex) => {
    const sourceText = rows[rowIndex]?.source;
    if (sourceText) {
      const reminder = checkTermReminder(sourceText);
      if (reminder.show) {
        toast(`参考翻译: ${reminder.translation} (出现 ${reminder.count} 次)`, { icon: '💡' });
      }
    }
  };

  const handleResizeStart = (e, column) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = columnWidths[column];
    
    resizingRef.current = { column, startX, startWidth };
    
    const handleResizeMove = (e) => {
      if (!resizingRef.current) return;
      const { column, startX, startWidth } = resizingRef.current;
      const diff = e.clientX - startX;
      const newWidth = Math.max(100, startWidth + diff);
      
      setColumnWidths(prev => ({ ...prev, [column]: newWidth }));
    };
    
    const handleResizeEnd = () => {
      if (resizingRef.current) {
        saveColumnWidths(columnWidthsRef.current);
        resizingRef.current = null;
      }
      document.removeEventListener('mousemove', handleResizeMove);
      document.removeEventListener('mouseup', handleResizeEnd);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    
    document.addEventListener('mousemove', handleResizeMove);
    document.addEventListener('mouseup', handleResizeEnd);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  return (
      <div className="workspace" onMouseUp={(e) => { handleTextSelect(); handleSelectionMouseUp(); }} onKeyDown={handleKeyDown} tabIndex={-1} ref={workspaceRef}>
      <div className={`workspace-header${headerCollapsed ? ' collapsed' : ''}`}>
        {!headerCollapsed && (<>
          <div className="sheet-info">
          <div className="sheet-selector-inline">
            <label>工作表:</label>
            {loadingSheets ? (
              <span className="loading-text">加载中...</span>
            ) : sheets.length > 0 ? (
              <select 
                value={selectedSheetTitle} 
                onChange={(e) => onSheetChange(e.target.value)}
                className="sheet-dropdown"
              >
                {sheets.map(s => (
                  <option key={s.id} value={s.title}>{s.title}</option>
                ))}
              </select>
            ) : (
              <span>{selectedSheetTitle}</span>
            )}
          </div>
          <div className="col-settings">
            <label>源列: <input value={sourceCol} onChange={(e) => onColumnChange(e.target.value.toUpperCase(), targetCol)} /></label>
            <label className="intermediate-toggle">
              <input 
                type="checkbox" 
                checked={showIntermediate} 
                onChange={(e) => onIntermediateToggle(e.target.checked)} 
              />
              中间语言
            </label>
            {showIntermediate && (
              <label>中间列: <input value={intermediateCol} onChange={(e) => onIntermediateColChange(e.target.value.toUpperCase())} /></label>
            )}
            <label className="terms-toggle">
              <input 
                type="checkbox" 
                checked={showTermsCol} 
                onChange={(e) => onTermsColToggle(e.target.checked)} 
              />
              术语列
            </label>
            <label>目标列: <input value={targetCol} onChange={(e) => onColumnChange(sourceCol, e.target.value.toUpperCase())} /></label>
          </div>
        </div>
        <div className="header-actions">
          <label className="range-toggle">
            <input 
              type="checkbox" 
              checked={useRange} 
              onChange={(e) => setUseRange(e.target.checked)} 
            />
            范围选择
          </label>
          {useRange && (
            <div className="range-inputs">
              <input 
                type="number" 
                value={rangeStart} 
                onChange={(e) => setRangeStart(e.target.value)}
                placeholder="起始行"
                min="1"
              />
              <span>-</span>
              <input 
                type="number" 
                value={rangeEnd} 
                onChange={(e) => setRangeEnd(e.target.value)}
                placeholder="结束行"
                min="1"
              />
              <button className="apply-range-btn" onClick={() => { 
                const dc = Object.keys(dirtyCellsRef.current).length;
                if (dc > 0) toast.warning(`有 ${dc} 个未保存的更改，切换范围后可通过「保存」恢复`, { duration: 3000 });
                setCurrentPage(1); loadSheetData(); 
              }}>应用</button>
            </div>
          )}
          <div className="pagination-inline">
            {!useRange && totalPages > 1 && (
              <>
                <button onClick={() => goToPage(1)} disabled={currentPage === 1 || loadingData}>«</button>
                <button onClick={() => goToPage(currentPage - 1)} disabled={currentPage === 1 || loadingData}>‹</button>
                <span className="page-info">{currentPage} / {totalPages}</span>
                <button onClick={() => goToPage(currentPage + 1)} disabled={currentPage === totalPages || loadingData}>›</button>
                <button onClick={() => goToPage(totalPages)} disabled={currentPage === totalPages || loadingData}>»</button>
                <select 
                  value={pageSize} 
                  onChange={(e) => {
                    const dc = Object.keys(dirtyCellsRef.current).length;
                    if (dc > 0) toast.warning(`有 ${dc} 个未保存的更改，切换页数后可通过「保存」恢复`, { duration: 3000 });
                    setPageSize(parseInt(e.target.value)); setCurrentPage(1);
                  }}
                  className="page-size-select"
                >
                  <option value={100}>100</option>
                  <option value={200}>200</option>
                  <option value={500}>500</option>
                </select>
              </>
            )}
          </div>
          <label className="auto-check-toggle">
            <input 
              type="checkbox" 
              checked={autoCheckTerms} 
              onChange={(e) => setAutoCheckTerms(e.target.checked)} 
            />
            自动检查
          </label>
          <button className="check-all-btn" onClick={handleCheckAllTerms} disabled={loadingData || !terms.length}>
            检查全表
          </button>
          <div className="export-dropdown">
            <button className="export-btn" disabled={displayRows.length === 0}>
              导出表格 ▾
            </button>
            <div className="export-menu">
              <button onClick={() => handleExportSheet('csv')}>导出为 CSV</button>
              <button onClick={() => handleExportSheet('sheet')}>导出到新表格</button>
            </div>
          </div>
          {filteredRowIndices ? (
            <button className="clear-filter-btn" onClick={handleClearFilter}>
              清除筛选 ✕
            </button>
          ) : (
            <div className="sync-filter-dropdown">
              <button className="sync-filter-btn" onClick={handleSyncFilterPage} disabled={loadingData}>
                ◈ 同步筛选
              </button>
              <div className="sync-filter-menu">
                <button onClick={handleSyncFilterPage}>筛选本页</button>
                <button onClick={handleSyncFilter}>筛选全表</button>
              </div>
            </div>
          )}
          <button className="clear-highlight-btn" onClick={handleClearHighlights}>
            清除高亮
          </button>
          <button className="highlight-terms-btn" onClick={handleHighlightTerms}>
            🔍 高亮术语
          </button>
          <button className="save-btn" onClick={handleManualSave} disabled={dirtyCount === 0} title={dirtyCount > 0 ? `${dirtyCount} 个未保存的更改` : '全部已同步'}>
            {dirtyCount > 0 ? `保存 (${dirtyCount})` : '✓ 已同步'}
          </button>
          <button className="refresh-btn" onClick={() => {
            const dc = Object.keys(dirtyCellsRef.current).length;
            if (dc > 0) toast.warning(`有 ${dc} 个未保存的更改，刷新后可通过「保存」恢复`, { duration: 3000 });
            loadSheetData();
          }} disabled={loadingData}>
            {loadingData ? '加载中...' : '刷新'}
          </button>
        </div>
        </>)}
        <button className="header-collapse-btn" onClick={toggleHeader} title={headerCollapsed ? '展开工具栏' : '折叠工具栏'}>
          {headerCollapsed ? '▸' : '▾'}
        </button>
      </div>

      {(filteredRowIndices || markingMode || !dismissedHint) && (
      <div className="workspace-toolbar">
        <div className="toolbar-left-hints">
        {filteredRowIndices ? (
          <span className="filter-active-hint">
            ◈ 筛选已同步：显示 {displayRows.length}/{rows.length} 行
            {selectedRows.size > 0 && <span className="selection-count"> | 已选 {selectedRows.size} 行</span>}
          </span>
        ) : markingMode ? (
          <span className="marking-hint">正在标记术语: "{markingMode.text}" → 点击目标语言翻译完成标记</span>
        ) : (
          <span className="marking-hint">
            选择源语言文字后点击标记 → 再点击目标语言完成术语保存
            <button className="dismiss-hint-btn" onClick={dismissToolbarHint} title="关闭提示">✕</button>
          </span>
        )}
        </div>
        <div className="toolbar-actions">
          {rows.some(r => r.inconsistent) && (
            <button className="clear-inconsistency" onClick={clearInconsistencies}>
              清除标记
            </button>
          )}
          {markingMode && <button className="clear-marking" onClick={() => setMarkingMode(null)}>取消</button>}
        </div>
      </div>
      )}

      <div className="workspace-table">
        <div className="table-header">
          <div className="col-num">#</div>
          <div className="col-source" style={{ width: columnWidths.source, minWidth: columnWidths.source }}>
            源语言 ({sourceCol})
            <div className="resize-handle" onMouseDown={(e) => handleResizeStart(e, 'source')} />
          </div>
          {showIntermediate && (
            <div className="col-intermediate" style={{ width: columnWidths.intermediate, minWidth: columnWidths.intermediate }}>
              中间语言 ({intermediateCol})
              <div className="resize-handle" onMouseDown={(e) => handleResizeStart(e, 'intermediate')} />
            </div>
          )}
          <div className="col-target" style={{ width: columnWidths.target, minWidth: columnWidths.target }}>
            目标语言 ({targetCol})
            <div className="resize-handle" onMouseDown={(e) => handleResizeStart(e, 'target')} />
          </div>
          {showTermsCol && (
            <div className="col-terms" style={{ width: columnWidths.terms, minWidth: columnWidths.terms }}>
              术语
              <div className="resize-handle" onMouseDown={(e) => handleResizeStart(e, 'terms')} />
            </div>
          )}
        </div>
        
        <div className="table-body">
          {rows.map((row, i) => {
            const isVisible = !filteredRowIndices || filteredRowIndices.has(row.index);
            return (
            <div 
              key={row.index}
              data-row-index={i}
              style={!isVisible ? { display: 'none' } : {}}
              className={`table-row ${row.marked ? 'marked' : ''} ${selectedCell?.rowIndex === i ? 'selected' : ''} ${row.inconsistent ? 'inconsistent' : ''} ${row.highlighted ? 'highlighted' : ''} ${selectedRows.has(i) ? 'multi-selected' : ''}`}
              onMouseDown={(e) => {
                const targetCol = e.target.closest('.col-target');
                if (targetCol) {
                  if (e.shiftKey || e.ctrlKey || e.metaKey) {
                    e.preventDefault();
                    handleRowMouseDown(i, e);
                    return;
                  }
                  if (e.target.tagName !== 'TEXTAREA') {
                    handleRowMouseDown(i, e);
                  }
                }
              }}
              onMouseMove={(e) => handleRowMouseMove(i, e)}
            >
              <div className="col-num">{row.index}</div>
              <div 
                className="col-source"
                style={{ width: columnWidths.source, minWidth: columnWidths.source }}
                onClick={(e) => handleCellSelect(i, 'source', e)}
              >
                <div className="cell-readonly">{row.source}</div>
              </div>
              {showIntermediate && (
                <div 
                  className="col-intermediate"
                  style={{ width: columnWidths.intermediate, minWidth: columnWidths.intermediate }}
                  onClick={(e) => handleCellSelect(i, 'intermediate', e)}
                >
                  <div className="cell-readonly">{row.intermediate}</div>
                </div>
              )}
              <div 
                className="col-target"
                style={{ width: columnWidths.target, minWidth: columnWidths.target }}
                onClick={(e) => handleCellSelect(i, 'target', e)}
              >
                  <textarea 
                    ref={textareaRefCallback}
                    data-row-index={i}
                    value={row.target}
                    onChange={(e) => {
                      updateCell(i, e.target.value, 'target');
                      autoResizeTextarea(e.target);
                    }}
                    onFocus={(e) => handleCellSelect(i, 'target', e)}
                    onBlur={() => handleTargetBlur(i)}
                    placeholder="目标语言..."
                  />
                {row.marked && <span className="term-badge">术语</span>}
                {row.inconsistent && row.inconsistentReason && (
                  <span className="inconsistent-reason" title={row.inconsistentReason}>⚠</span>
                )}
              </div>
              {showTermsCol && (
                <div 
                  className="col-terms"
                  style={{ width: columnWidths.terms, minWidth: columnWidths.terms }}
                  onClick={(e) => handleCellSelect(i, 'target', e)}
                >
                  {row.matchedTerms && row.matchedTerms.length > 0 ? (
                    <div className="terms-col-list">
                      {row.matchedTerms.map((term, ti) => {
                        const isInconsistent = row.inconsistent && row.target && term.target && row.target.trim() !== term.target.trim();
                        return (
                          <div key={ti} className={`terms-col-item ${isInconsistent ? 'terms-col-warn' : ''}`}>
                            <span className="terms-col-source">{term.source}</span>
                            <span className="terms-col-arrow">→</span>
                            <span className="terms-col-target">{term.target}</span>
                            {term.note && <span className="term-note-icon" title={term.note}>📝</span>}
                            {isInconsistent && (
                              <button
                                className="terms-col-dismiss"
                                onClick={(e) => { e.stopPropagation(); clearRowInconsistency(i); }}
                                title="清除不一致标记"
                              >×</button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <span className="terms-col-empty">-</span>
                  )}
                </div>
              )}
            </div>
          )
        })}
        </div>

        {!useRange && totalPages > 1 && (
          <div className="pagination">
            <button onClick={() => goToPage(1)} disabled={currentPage === 1}>首页</button>
            <button onClick={() => goToPage(currentPage - 1)} disabled={currentPage === 1}>上一页</button>
            <span className="page-info">第 {currentPage} / {totalPages} 页 (共 {totalRows} 行)</span>
            <button onClick={() => goToPage(currentPage + 1)} disabled={currentPage === totalPages}>下一页</button>
            <button onClick={() => goToPage(totalPages)} disabled={currentPage === totalPages}>末页</button>
            <select 
              value={pageSize} 
              onChange={(e) => {
                const dc = Object.keys(dirtyCellsRef.current).length;
                if (dc > 0) toast.warning(`有 ${dc} 个未保存的更改，切换页数后可通过「保存」恢复`, { duration: 3000 });
                setPageSize(parseInt(e.target.value)); setCurrentPage(1);
              }}
              className="page-size-select"
            >
              <option value={100}>100行/页</option>
              <option value={200}>200行/页</option>
              <option value={500}>500行/页</option>
            </select>
          </div>
        )}
      </div>

      {showPopup && (
        <div className="popup-overlay" onClick={closePopup}>
          <div className="popup-content" onClick={(e) => e.stopPropagation()}>
            <div className="popup-header">
              <h3>术语不一致列表</h3>
              <button className="popup-close" onClick={closePopup}>×</button>
            </div>
            <div className="popup-body">
              <p className="popup-summary">发现 {popupData.length} 处不一致：</p>
              <div className="popup-list">
                {popupData.slice(0, 100).map((item, i) => (
                  <div key={i} className="popup-item">
                    <span className="popup-row">行 {item.row}</span>
                    <span className="popup-source">{item.source}</span>
                    <span className="popup-arrow">→</span>
                    <span className="popup-expected">标准: {item.expected}</span>
                    <span className="popup-actual">实际: {item.actual}</span>
                  </div>
                ))}
                {popupData.length > 100 && (
                  <p className="popup-more">...还有 {popupData.length - 100} 处未显示</p>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {tooltip.visible && tooltip.terms && tooltip.terms.length > 0 && (
        <div 
          className="term-tooltip"
          ref={tooltipRef}
          style={{
            left: `${tooltip.x}px`,
            top: `${tooltip.y}px`,
            transform: 'translate(-50%, -100%)'
          }}
        >
          <div className="term-tooltip-header">
            <span className="term-tooltip-title">术语提醒</span>
            <button className="term-tooltip-close" onClick={closeTooltip}>×</button>
          </div>
          {tooltip.terms.map((term, i) => (
            <div key={i} className="term-tooltip-item">
              <div className="term-tooltip-source">{term.source}</div>
              <div className="term-tooltip-arrow">→</div>
              <div className="term-tooltip-target">{term.target}</div>
              {term.count > 1 && <span className="term-tooltip-count">×{term.count}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default TranslationWorkspace;
