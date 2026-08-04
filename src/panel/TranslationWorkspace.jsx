import { useState, useEffect, useCallback, useRef, memo } from 'react';
import toast from 'react-hot-toast';
import { authedFetch, getFreshToken as getFreshTokenUtil } from '../utils/googleAuth';
import {
  buildMatchers, findTermsInSource, findMatchedTerms, analyzeConsistency,
  detectMissingTranslations, buildTieredReport, reportItemKey,
} from './utils/termMatcher';

// 疑问标记在原表目标列使用的背景色（淡紫色，和常见的黄/绿/红区分开，方便按颜色筛选）
const QUESTION_FLAG_COLOR = { red: 0.81, green: 0.71, blue: 0.90 };

// 术语缺失率达到这个比例，判定为「术语库过时」而非逐行错误，聚合成一条提示
const DRIFT_THRESHOLD = 0.6;

// 漏译/截断检测参数：默认针对英→韩，中→韩等字符比接近 1:1 的语向需调高 RATIO_FLOOR
const MIN_SOURCE_LEN = 40; // 源文可翻译长度低于这个门槛，不做比例判定（避免误伤短术语行）
const RATIO_FLOOR = 0.15;  // 译/源 可翻译长度比下限，低于此值判定为疑似漏译/截断

// 术语不一致的置信度低于这个值，从「直接改译文」降级为「疑似，需人肉复核」
const REVIEW_BELOW = 0.6;

// AI 复核只处理低置信度的 REVIEW/GLOSSARY_DRIFT 条目，一次最多送这么多条（控制 prompt 大小和成本）
const MAX_AI_VERIFY_ITEMS = 60;
// 术语库过时聚合条目附带的实际译法样例最多带几条，让 AI 有点上下文又不至于把整批未命中行都塞进去
const DRIFT_EXAMPLE_ROWS = 5;

// AI 复核系统提示：只对算法自己不确定的两档（REVIEW 逐行疑似 / GLOSSARY_DRIFT 术语库疑似过时）做语义判断，
// 高置信度的 CONFIRMED/MISSING 不送审，避免重复劳动。
const AI_VERIFY_SYSTEM_PROMPT = `你是资深游戏本地化审校，正在复核一个术语一致性检查工具生成的疑似问题列表。

每条数据带一个 tier 字段：
- "REVIEW"：某一行源文命中了术语库里的术语，但译文里没有直接包含标准译法字符串，工具不确定这是不是真的错误。请结合 source（源文）、expected（术语库标准译法）、actual（该行实际译文）判断：如果 actual 在语境下其实翻译得没问题（比如同义替换、语法变形、这里根本不该套用该术语），判定 "FALSE_POSITIVE"；如果确实是术语用错了，判定 "CONFIRM"。
- "GLOSSARY_DRIFT"：某个术语在全表大多数命中的行里，译者都没有使用术语库里的标准译法（examples 是若干未使用标准译法的实际样例）。请判断：如果这些行的译法本身更合理、更统一，只是术语库没跟上，判定 "UPDATE_GLOSSARY" 并在 suggestedTarget 给出建议的新标准译法；如果术语库译法才是对的、这些行确实译错了，判定 "CONFIRM"。

请对输入数组里的每一条给出一个判断，严格按输入顺序一一对应，以 JSON 数组格式返回，每项格式：
{"verdict": "CONFIRM" | "FALSE_POSITIVE" | "UPDATE_GLOSSARY", "reason": "一句话理由", "suggestedTarget": "仅 verdict 为 UPDATE_GLOSSARY 时填写，其余留空字符串"}
只返回 JSON 数组本身，不要添加任何解释、编号或 markdown 代码块标记。`;

const AI_VERDICT_LABEL = {
  CONFIRM: '✅ AI: 确认原判定',
  FALSE_POSITIVE: '💤 AI: 误报，可忽略',
  UPDATE_GLOSSARY: '🔧 AI: 建议改术语库',
};

function autoResizeTextarea(textarea) {
  if (!textarea) return;
  textarea.style.height = 'auto';
  textarea.style.height = textarea.scrollHeight + 'px';
}

// 单行组件：用 memo 包裹，保证只有数据真正变化的行才会重渲染，
// 避免每敲一个字就重渲染整页几百行。
const TableRow = memo(function TableRow({
  row, i, isVisible, isSelectedCell, isMultiSelected,
  columnWidths, showIntermediate, showTermsCol,
  onCellSelect, onUpdateCell, onTextareaRef,
  onRowMouseDown, onRowMouseMove, onClearRowInconsistency,
  isFlagged, flagNote, onToggleFlag, onFlagNote,
}) {
  return (
    <div
      data-row-index={i}
      data-row={row.index}
      style={!isVisible ? { display: 'none' } : undefined}
      className={`table-row ${row.marked ? 'marked' : ''} ${isSelectedCell ? 'selected' : ''} ${row.inconsistent ? 'inconsistent' : ''} ${row.highlighted ? 'highlighted' : ''} ${isMultiSelected ? 'multi-selected' : ''}`}
      onMouseDown={(e) => {
        const targetColEl = e.target.closest('.col-target');
        if (targetColEl) {
          if (e.shiftKey || e.ctrlKey || e.metaKey) {
            e.preventDefault();
            onRowMouseDown(i, e);
            return;
          }
          if (e.target.tagName !== 'TEXTAREA') {
            onRowMouseDown(i, e);
          }
        }
      }}
      onMouseMove={(e) => onRowMouseMove(i, e)}
    >
      <div className="col-num">{row.index}</div>
      <div
        className="col-source"
        style={{ width: columnWidths.source, minWidth: columnWidths.source }}
        onClick={(e) => onCellSelect(i, 'source', row.source, e)}
      >
        <div className="cell-readonly">{row.source}</div>
      </div>
      {showIntermediate && (
        <div
          className="col-intermediate"
          style={{ width: columnWidths.intermediate, minWidth: columnWidths.intermediate }}
          onClick={(e) => onCellSelect(i, 'intermediate', row.intermediate, e)}
        >
          <div className="cell-readonly">{row.intermediate}</div>
        </div>
      )}
      <div
        className="col-target"
        style={{ width: columnWidths.target, minWidth: columnWidths.target }}
        onClick={(e) => onCellSelect(i, 'target', row.target, e)}
      >
        <textarea
          ref={onTextareaRef}
          data-row-index={i}
          value={row.target}
          onChange={(e) => {
            onUpdateCell(i, e.target.value, 'target');
            autoResizeTextarea(e.target);
          }}
          onFocus={(e) => onCellSelect(i, 'target', row.target, e)}
          placeholder="目标语言..."
        />
        {row.marked && <span className="term-badge">术语</span>}
        {row.inconsistent && row.inconsistentReason && (
          <span className="inconsistent-reason" title={row.inconsistentReason}>⚠</span>
        )}
        <button
          className={`row-flag-btn ${isFlagged ? 'flagged' : ''} ${isFlagged && flagNote ? 'has-note' : ''}`}
          onClick={(e) => { e.stopPropagation(); onToggleFlag(i); }}
          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onFlagNote(i); }}
          title={isFlagged
            ? `疑问：${flagNote || '(无备注)'}\n左键取消标记 · 右键编辑备注`
            : '左键标记疑问（标色）· 右键标记并加备注'}
        >🚩{isFlagged && flagNote ? <span className="row-flag-note-dot">📝</span> : null}</button>
      </div>
      {showTermsCol && (
        <div
          className="col-terms"
          style={{ width: columnWidths.terms, minWidth: columnWidths.terms }}
          onClick={(e) => onCellSelect(i, 'target', row.target, e)}
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
                        onClick={(e) => { e.stopPropagation(); onClearRowInconsistency(i); }}
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
  );
});

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
  onTermsColToggle,
  refreshKey
}) {
  const [rows, setRows] = useState([]);
  const [resizeNonce, setResizeNonce] = useState(0);
  const rowsRef = useRef([]);
  const [selectedCell, setSelectedCell] = useState(null);
  const [terms, setTerms] = useState([]);
  const [markingMode, setMarkingMode] = useState(null);
  const [columnWidths, setColumnWidths] = useState({ source: 300, intermediate: 300, target: 300, terms: 250 });
  const [pageSize, setPageSize] = useState(200);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalRows, setTotalRows] = useState(1000);
  const [loadingData, setLoadingData] = useState(false);
  const [useRange, setUseRange] = useState(false);
  const [rangeStart, setRangeStart] = useState(1);
  const [rangeEnd, setRangeEnd] = useState(200);
  const [autoCheckTerms, setAutoCheckTerms] = useState(false);
  const [sidePanel, setSidePanel] = useState({ visible: false, data: [] });
  const [aiVerifying, setAiVerifying] = useState(false);
  const [highlightRow, setHighlightRow] = useState(null);
  const [dismissedInconsistencies, setDismissedInconsistencies] = useState([]);
  // 疑问标记：{ [表格行号]: { note } }，标记时同步给原表目标列标色+批注
  const [flaggedMap, setFlaggedMap] = useState({});
  const hasCheckedRef = useRef(false);
  const workspaceRef = useRef(null);
  const resizingRef = useRef(null);
  const columnWidthsRef = useRef(columnWidths);
  const textareaRefs = useRef({});
  const termsRef = useRef([]);
  const saveTimerRef = useRef(null);
  const pendingSaveRef = useRef(null);
  const dirtyCellsRef = useRef({});
  const [dirtyCount, setDirtyCount] = useState(0);
  const [headerCollapsed, setHeaderCollapsed] = useState(false);
  const headerLoadedRef = useRef(false);
  const [dismissedHint, setDismissedHint] = useState(false);
  const [floatMark, setFloatMark] = useState({ visible: false, x: 0, y: 0, text: '', rowIndex: null });
  const floatMarkRef = useRef(null);
  
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

  // 按表格 ID 分开存储“不再提醒”记录，不同表格互不影响
  useEffect(() => {
    if (!sheet?.id) {
      setDismissedInconsistencies([]);
      return;
    }
    const key = 'dismissedInconsistencies_' + sheet.id;
    chrome.storage.local.get([key], (result) => {
      setDismissedInconsistencies(result[key] || []);
    });
  }, [sheet?.id]);

  // 疑问标记按 表格ID + 工作表标题 分开存储（不同 tab 行号会重复，必须区分）
  const flagStorageKey = () =>
    `questionFlags_${sheet?.id}__${selectedSheetTitle || sheet?.title || ''}`;

  useEffect(() => {
    if (!sheet?.id) { setFlaggedMap({}); return; }
    const key = flagStorageKey();
    chrome.storage.local.get([key], (result) => {
      setFlaggedMap(result[key] || {});
    });
  }, [sheet?.id, selectedSheetTitle]);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (floatMark.visible && floatMarkRef.current && !floatMarkRef.current.contains(e.target)) {
        setFloatMark({ visible: false, x: 0, y: 0, text: '', rowIndex: null });
      }
    };
    if (floatMark.visible) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [floatMark.visible]);

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

  // 每次请求前获取最新 token，避免 prop 中的 token 过期（统一走 utils）
  const getFreshToken = getFreshTokenUtil;
  const [filteredRowIndices, setFilteredRowIndices] = useState(null);
  const [selectedRows, setSelectedRows] = useState(new Set());
  const dragStateRef = useRef({ isDown: false, startRow: null, startX: 0, startY: 0, isDragging: false });

  const displayRows = filteredRowIndices
    ? rows.filter(row => filteredRowIndices.has(row.index))
    : rows;

  const textareaRefCallback = useCallback((el) => {
    if (!el) return;
    const index = parseInt(el.dataset.rowIndex);
    textareaRefs.current[index] = el;
    autoResizeTextarea(el);
  }, []);

  // 仅在数据整体（重新）加载、AI 写回时重算所有 textarea 高度。
  // 不能依赖 [rows]，否则每次按键编辑都会触发全量重排，造成严重卡顿。
  useEffect(() => {
    requestAnimationFrame(() => {
      Object.values(textareaRefs.current).forEach(el => {
        if (el) autoResizeTextarea(el);
      });
    });
  }, [resizeNonce]);

  // AI 翻译完成后自动刷新工作区数据
  useEffect(() => {
    if (refreshKey > 0 && sheet?.id) {
      loadSheetData();
    }
  }, [refreshKey]);

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
  useEffect(() => { rowsRef.current = rows; }, [rows]);

  useEffect(() => {
    if (highlightRow && rows.length > 0 && !loadingData) {
      scrollToRow(highlightRow);
      setHighlightRow(null);
    }
  }, [rows, loadingData, highlightRow]);

  useEffect(() => {
    if (highlightRow && rows.length > 0 && !loadingData) {
      scrollToRow(highlightRow);
      setHighlightRow(null);
    }
  }, [rows, loadingData, highlightRow]);

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
      
      let filteredTerms;

      if (termLibraryBindingId) {
        const lib = libraries.find(l => l.id === termLibraryBindingId);
        if (lib) {
          if ((lib.source === 'remote' || lib.source === 'glossary') && lib.terms) {
            filteredTerms = lib.terms;
          } else {
            filteredTerms = allTerms.filter(t => t.libraryId === termLibraryBindingId);
          }
        } else {
          filteredTerms = [];
        }
      } else {
        // 没有绑定术语库时，只加载未归属到任何库的全局术语
        filteredTerms = allTerms.filter(t => !t.libraryId);
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
    
    const matchers = buildMatchers(currentTerms);
    const highlightMatches = rows.map(row => {
      if (!row.source) return { ...row, highlighted: false, matchedTerms: [] };
      const matchedTerms = findMatchedTerms(row.source, matchers);
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

  const loadSheetData = async (forceRange = null, keepOnlyRows = null) => {
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
      
      const response = await authedFetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${sheet.id}/values/${encodeURIComponent(rangeName)}?majorDimension=ROWS`
      );

      if (!response.ok) throw new Error(`加载失败 (${response.status})`);

      const data = await response.json();
      const values = data.values || [];

      if (!useRange && values.length > 0) {
        try {
          const metaResponse = await authedFetch(
            `https://sheets.googleapis.com/v4/spreadsheets/${sheet.id}?fields=sheets(properties(title,gridProperties.rowCount))`
          );
          if (metaResponse.ok) {
            const metaData = await metaResponse.json();
            const sheetsArr = metaData.sheets || [];
            // 按当前工作表标题匹配对应 tab，取不到再退回第一个，避免读成别的 tab 的行数
            const matched = sheetsArr.find(s => s.properties?.title === sheetTitle) || sheetsArr[0];
            const totalRowsFromMeta = matched?.properties?.gridProperties?.rowCount || 0;
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
      
      const sheetMatchers = buildMatchers(termsRef.current);
      const findMatchingTerms = (text) => {
        if (!text || !sheetMatchers.length) return [];
        return findMatchedTerms(text, sheetMatchers);
      };

      const pendingEdits = await loadPendingEdits();

      const builtRows = values.map((row, i) => {
        const rowNum = startRow + i;
        const visible = !keepOnlyRows || keepOnlyRows.has(rowNum);
        const sourceText = row[colIndexMap.source] || '';
        // 隐藏行不参与术语匹配，省去每行对整个术语表的扫描（筛选全表时的主要 CPU 开销）
        const matchedTerms = visible ? findMatchingTerms(sourceText) : [];
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
      // 筛选全表时：只保留可见行，避免渲染首尾之间成千上万的隐藏行造成卡顿
      const finalRows = (keepOnlyRows && keepOnlyRows.size > 0)
        ? builtRows.filter(r => keepOnlyRows.has(r.index))
        : builtRows;
      setRows(finalRows);
      setResizeNonce(n => n + 1);

      if (forceRange || useRange) {
        setTotalRows(endRow);
      } else {
        // 用函数式更新，基于最新的 totalRows（meta 可能刚设成更大的真实值），
        // 避免用过期闭包值把正确的总行数缩回去
        const rowCount = values.length > 0 ? startRow + values.length - 1 : 0;
        setTotalRows(prev => Math.max(rowCount, prev));
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
      
      const response = await authedFetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${sheet.id}/values/${encodeURIComponent(rangeName)}?majorDimension=ROWS`
      );

      if (!response.ok) throw new Error('加载失败');
      
      const data = await response.json();
      const allValues = data.values || [];
      const colIndexMap = getColumnIndexMap();
      
      const checkMatchers = buildMatchers(currentTerms);
      const sourceRows = allValues.map((row, index) => ({
        rowNo: index + 1,
        source: row[colIndexMap.source]?.trim(),
        target: row[colIndexMap.target]?.trim(),
      }));

      const { glossaryDrift, likelyErrors } = analyzeConsistency(sourceRows, checkMatchers, { driftThreshold: DRIFT_THRESHOLD });
      const missingFindings = detectMissingTranslations(sourceRows, { minSourceLen: MIN_SOURCE_LEN, ratioFloor: RATIO_FLOOR });
      const tieredReport = buildTieredReport({ glossaryDrift, likelyErrors }, missingFindings, { reviewBelow: REVIEW_BELOW });

      toast.dismiss('checkAll');

      const dismissed = dismissedInconsistencies;
      const filteredItems = tieredReport.filter(item => !dismissed.some(d => d.key === reportItemKey(item)));

      if (filteredItems.length > 0) {
        openSidePanel(filteredItems);
      } else if (tieredReport.length > 0) {
        toast.success('全表检查完成，所有提示已忽略');
      } else {
        toast.success('全表检查完成，未发现问题');
      }
    } catch (err) {
      toast.dismiss('checkAll');
      toast.error('检查失败: ' + err.message);
    }
  };
  
  const openSidePanel = (data) => {
    setSidePanel({ visible: true, data });
  };

  const closeSidePanel = () => {
    setSidePanel({ visible: false, data: [] });
    setHighlightRow(null);
  };

  // 把当前不一致列表（用户已筛掉"不再提醒"的，剩下需要确认的）导出为 CSV
  const handleExportInconsistencies = () => {
    const rows = sidePanel.data || [];
    if (!rows.length) {
      toast.error('没有可导出的不一致项');
      return;
    }
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const tierLabel = { MISSING: '漏译/截断', CONFIRMED: '术语不一致', GLOSSARY_DRIFT: '术语库疑似过时', REVIEW: '疑似不一致(待复核)' };
    const header = ['档位', '行号', '置信度', '说明'];
    const body = rows.map(item => [
      tierLabel[item.tier] || item.tier,
      item.rowNo ?? '',
      item.confidence,
      item.detail,
    ].map(esc).join(','));
    const csv = '﻿' + [header.map(esc).join(','), ...body].join('\r\n');

    const sheetTitle = selectedSheetTitle || sheet?.title || '表格';
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `检查结果_${sheetTitle}_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success(`已导出 ${rows.length} 条待确认的提示`);
  };

  // 只把置信度低、算法自己拿不准的 REVIEW/GLOSSARY_DRIFT 条目喂给 AI 做语义复核，
  // 不读整张表；每条只带该条目本身需要的字段（源文/术语库标准译法/实际译文等）。
  const handleAiVerify = async () => {
    const candidates = sidePanel.data.filter(item => item.tier === 'REVIEW' || item.tier === 'GLOSSARY_DRIFT');
    if (candidates.length === 0) {
      toast('没有需要 AI 复核的条目（仅 🟡 疑似不一致 / 🔵 术语库疑似过时 会送去复核）', { icon: 'ℹ️' });
      return;
    }

    const targets = candidates.slice(0, MAX_AI_VERIFY_ITEMS);
    if (candidates.length > MAX_AI_VERIFY_ITEMS) {
      toast(`待复核条目较多，本次先处理前 ${MAX_AI_VERIFY_ITEMS} 条`, { icon: '⚠️' });
    }

    const cfg = await chrome.storage.local.get(['aiApiKey', 'aiApiType', 'aiEndpoint', 'aiModel']);
    if (!cfg.aiApiKey || !cfg.aiEndpoint) {
      toast.error('请先在设置页配置 AI API Key 和端点');
      return;
    }

    const payload = targets.map(item => item.tier === 'GLOSSARY_DRIFT'
      ? {
          tier: item.tier,
          source: item.source,
          expected: item.expected,
          hitCount: item.hitCount,
          missCount: item.missCount,
          examples: (item.missRows || []).slice(0, DRIFT_EXAMPLE_ROWS).map(r => ({ row: r.rowNo, actual: r.actual })),
        }
      : {
          tier: item.tier,
          row: item.rowNo,
          source: item.source,
          expected: item.expected,
          actual: item.actual,
        }
    );

    setAiVerifying(true);
    toast.loading('AI 复核中...', { id: 'aiVerify' });
    try {
      const resp = await new Promise(resolve => {
        const timer = setTimeout(() => resolve({ error: '请求超时' }), 120000);
        chrome.runtime.sendMessage({
          type: 'AI_VERIFY_TERMS',
          apiKey: cfg.aiApiKey,
          apiType: cfg.aiApiType || 'anthropic',
          endpoint: cfg.aiEndpoint,
          model: cfg.aiModel,
          systemPrompt: AI_VERIFY_SYSTEM_PROMPT,
          items: payload,
        }, (r) => {
          clearTimeout(timer);
          if (r) return resolve(r);
          // 回调收到 undefined = 端口在没有回复的情况下关闭了。最常见的原因是
          // 构建后只重开了面板、没有重新加载扩展，后台仍是不认识本消息的旧脚本。
          const reason = chrome.runtime.lastError?.message;
          resolve({ error: reason
            ? `扩展后台未响应（${reason}）。请到 chrome://extensions 重新加载本扩展后重试`
            : '无响应' });
        });
      });

      toast.dismiss('aiVerify');

      if (resp?.error) {
        toast.error('AI 复核失败: ' + resp.error);
        return;
      }

      const verdicts = resp?.verdicts || [];
      // 判定靠下标与送审条目一一对应，数量不符说明模型漏答/多答，
      // 此时整批都不可信（会把判定挂到错的行上），宁可全丢弃让用户重试。
      if (verdicts.length !== targets.length) {
        toast.error(`AI 返回 ${verdicts.length} 条判定，与送审的 ${targets.length} 条不符，已丢弃本次结果，请重试`);
        return;
      }

      const verdictMap = new Map();
      targets.forEach((item, i) => {
        if (verdicts[i]) verdictMap.set(reportItemKey(item), verdicts[i]);
      });

      setSidePanel(prev => ({
        ...prev,
        data: prev.data.map(item => {
          const v = verdictMap.get(reportItemKey(item));
          return v ? { ...item, aiVerdict: v } : item;
        }),
      }));
      toast.success(`AI 复核完成，共 ${verdicts.length} 条`);
    } catch (err) {
      toast.dismiss('aiVerify');
      toast.error('AI 复核出错: ' + err.message);
    } finally {
      setAiVerifying(false);
    }
  };

  // 取当前工作表的数字 sheetId（gid），批注/标色的 API 需要它
  const getNumericSheetId = () => {
    const title = selectedSheetTitle || sheet?.title;
    const found = (sheets || []).find(s => s.title === title);
    return found ? found.id : null;
  };

  // 给原表目标列某一行写背景色+批注；note 传 null 表示清除标记
  const writeFlagToSheet = async (rowNum, note) => {
    const numericSheetId = getNumericSheetId();
    if (numericSheetId == null) throw new Error('未找到工作表 ID，请先刷新');
    const columnIndex = colToIndex(targetCol);
    const isClear = note === null;
    const cellValue = isClear
      ? { userEnteredFormat: { backgroundColor: { red: 1, green: 1, blue: 1 } }, note: '' }
      : { userEnteredFormat: { backgroundColor: QUESTION_FLAG_COLOR }, note };
    const body = {
      requests: [{
        updateCells: {
          rows: [{ values: [cellValue] }],
          fields: 'userEnteredFormat.backgroundColor,note',
          start: { sheetId: numericSheetId, rowIndex: rowNum - 1, columnIndex },
        },
      }],
    };
    const res = await authedFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheet.id}:batchUpdate`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error?.message || `写入失败: ${res.status}`);
    }
  };

  // 左键点 🚩：直接标记/取消，不弹备注（大多数情况用这个）
  const handleToggleFlag = async (i) => {
    const row = rowsRef.current[i];
    if (!row) return;
    const rowNum = row.index;
    const existing = flaggedMap[rowNum];
    const removing = !!existing;

    toast.loading(removing ? '正在取消标记...' : '正在标记...', { id: 'flagRow' });
    try {
      // 取消时传 null 清除；标记时保留已有备注（一般为空）
      await writeFlagToSheet(rowNum, removing ? null : (existing?.note ?? ''));
      setFlaggedMap(prev => {
        const next = { ...prev };
        if (removing) delete next[rowNum];
        else next[rowNum] = { note: existing?.note ?? '' };
        if (sheet?.id) chrome.storage.local.set({ [flagStorageKey()]: next });
        return next;
      });
      toast.dismiss('flagRow');
      toast.success(removing ? '已取消该行疑问标记' : '已标记疑问');
    } catch (err) {
      toast.dismiss('flagRow');
      toast.error('操作失败: ' + err.message);
    }
  };

  // 右键 🚩：添加/编辑备注（并确保该行已标记）
  const handleFlagNote = async (i) => {
    const row = rowsRef.current[i];
    if (!row) return;
    const rowNum = row.index;
    const existing = flaggedMap[rowNum];

    const input = window.prompt('填写/编辑该行疑问备注（会写入原表目标列单元格批注）：', existing?.note || '');
    if (input === null) return; // 用户取消
    const note = input.trim();

    toast.loading('正在写入备注...', { id: 'flagRow' });
    try {
      await writeFlagToSheet(rowNum, note); // 设色+写批注，未标记的会一并标上
      setFlaggedMap(prev => {
        const next = { ...prev, [rowNum]: { note } };
        if (sheet?.id) chrome.storage.local.set({ [flagStorageKey()]: next });
        return next;
      });
      toast.dismiss('flagRow');
      toast.success(note ? '疑问备注已保存' : '已清空备注（仍保留标记）');
    } catch (err) {
      toast.dismiss('flagRow');
      toast.error('操作失败: ' + err.message);
    }
  };

  const handleDismissInconsistency = (item) => {
    const key = reportItemKey(item);
    // 乐观更新：先用内存里的 state 立即更新界面，存储在后台异步写入，
    // 不再每次点击都串行 await 一次 storage 读+写（数据越多越慢）。
    setDismissedInconsistencies(prev => {
      const next = [...prev, { key, dismissedAt: new Date().toISOString() }];
      if (sheet?.id) {
        chrome.storage.local.set({ ['dismissedInconsistencies_' + sheet.id]: next });
      }
      return next;
    });
    const remaining = sidePanel.data.filter(d => reportItemKey(d) !== key);
    if (remaining.length === 0) {
      setSidePanel({ visible: false, data: [] });
      toast.success('所有提示已处理完毕');
    } else {
      setSidePanel({ visible: true, data: remaining });
    }
  };

  const handleSidePanelRowClick = (item) => {
    const rowNo = item.rowNo ?? item.missRows?.[0]?.rowNo;
    if (!rowNo) return;
    const targetPage = Math.ceil(rowNo / pageSize);
    setHighlightRow(rowNo);
    if (targetPage !== currentPage) {
      setCurrentPage(targetPage);
    } else {
      scrollToRow(rowNo);
    }
  };

  const scrollToRow = (rowNum) => {
    setTimeout(() => {
      const rowEl = document.querySelector(`[data-row="${rowNum}"]`);
      if (rowEl) {
        rowEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        rowEl.classList.add('highlight-flash');
        setTimeout(() => rowEl?.classList.remove('highlight-flash'), 2000);
      }
    }, 100);
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
        
        const response = await authedFetch(
          'https://sheets.googleapis.com/v4/spreadsheets',
          {
            method: 'POST',
            headers: {
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

  const recalcMatchedTerms = useCallback(async () => {
    const currentTerms = termsRef.current;
    const recalcMatchers = buildMatchers(currentTerms);
    const result = await chrome.storage.local.get(['markedTerms']);
    const markedTerms = result.markedTerms || [];
    setRows(prevRows => prevRows.map(row => {
      if (!row.source) return row;
      const matched = findMatchedTerms(row.source, recalcMatchers);
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
      if (libIdx >= 0 && (libraries[libIdx].source === 'remote' || libraries[libIdx].source === 'glossary')) {
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
      ? newTerms.filter(t => t.libraryId === termLibraryBindingId)
      : newTerms.filter(t => !t.libraryId);
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

  const clearRowInconsistency = useCallback((rowIndex) => {
    setRows(prevRows => prevRows.map((row, idx) =>
      idx === rowIndex ? { ...row, inconsistent: false, inconsistentReason: '' } : row
    ));
  }, []);

   const getVisibleRowsFromApi = async () => {
     const res = await authedFetch(
       `https://sheets.googleapis.com/v4/spreadsheets/${sheet.id}?includeGridData=true&ranges=${encodeURIComponent(selectedSheetTitle)}&fields=sheets(properties(gridProperties),data(rowMetadata))`
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
       const visibleSet = new Set(visibleRows);
       setUseRange(true);
       setRangeStart(firstVisible);
       setRangeEnd(lastVisible);
       // 只构建/渲染可见行，避免首尾之间的大量隐藏行拖慢加载与编辑
       await loadSheetData({ start: firstVisible, end: lastVisible }, visibleSet);
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
    if (e.ctrlKey && e.shiftKey && (e.key === 'Z' || e.key === 'z')) {
      const sel = window.getSelection();
      const selText = sel?.toString()?.trim();
      if (selText && selectedCell?.col === 'source' && !markingMode) {
        e.preventDefault();
        setMarkingMode({ type: 'source', text: selText, rowIndex: selectedCell.rowIndex });
        setFloatMark({ visible: false, x: 0, y: 0, text: '', rowIndex: null });
      }
      return;
    }
    if (selectedRows.size === 0) return;
    // 正在单元格文本框里编辑时，放行浏览器原生的复制/粘贴，不触发批量操作
    const tag = e.target?.tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT') return;
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

  const handleRowMouseDown = useCallback((rowArrayIndex, e) => {
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
  }, []);

  const handleRowMouseMove = useCallback((rowArrayIndex, e) => {
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
  }, []);

  const handleCellSelect = useCallback((rowIndex, col, text, event) => {
    setSelectedCell({ rowIndex, col, text });

    if (col === 'source') {
      workspaceRef.current?.focus();
    }
  }, []);

  const handleTextSelect = (e) => {
    if (dragStateRef.current.isDragging) return;
    const selection = window.getSelection();
    const text = selection.toString().trim();
    if (!text || !selectedCell) return;

    if (selectedCell.col === 'source') {
      if (selection.rangeCount > 0) {
        const rect = selection.getRangeAt(0).getBoundingClientRect();
        setFloatMark({
          visible: true,
          x: rect.right,
          y: rect.top,
          text,
          rowIndex: selectedCell.rowIndex
        });
      }
    } else if (selectedCell.col === 'target' && markingMode?.type === 'source') {
      let selectedTargetText = text;
      if (e?.target?.tagName === 'TEXTAREA') {
        selectedTargetText = e.target.value.substring(e.target.selectionStart, e.target.selectionEnd).trim();
      }
      if (!selectedTargetText) {
        toast.error('请在目标列选中对应文本');
        return;
      }
      const newRows = [...rows];
      newRows[selectedCell.rowIndex] = { ...newRows[selectedCell.rowIndex], marked: true };
      setRows(newRows);
      saveTerm(markingMode.text, selectedTargetText);
      setMarkingMode(null);
      toast.success('术语标记成功');
    }
  };

  const handleFloatMarkClick = () => {
    if (floatMark.text) {
      setMarkingMode({ type: 'source', text: floatMark.text, rowIndex: floatMark.rowIndex });
      setFloatMark({ visible: false, x: 0, y: 0, text: '', rowIndex: null });
    }
  };

  const updateCell = useCallback((rowIndex, value, col) => {
    // 生成新的行对象（而非原地修改），memo 的子行才能感知到变化只发生在这一行
    setRows(prev => {
      if (!prev[rowIndex]) return prev;
      const next = [...prev];
      next[rowIndex] = { ...next[rowIndex], [col]: value };
      return next;
    });

    let colLetter;
    if (col === 'source') colLetter = sourceCol;
    else if (col === 'intermediate') colLetter = intermediateCol;
    else colLetter = targetCol;

    const sheetTitle = selectedSheetTitle || (sheet?.title ?? '');
    const sheetRow = rowsRef.current[rowIndex]?.index || rowIndex + 1;
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
        const res = await authedFetch(
          `https://sheets.googleapis.com/v4/spreadsheets/${save.sheetId}/values/${save.encodedRange}?valueInputOption=RAW`,
          {
            method: 'PUT',
            headers: {
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
  }, [sourceCol, intermediateCol, targetCol, selectedSheetTitle, sheet?.id, sheet?.title]);

  const handleManualSave = async () => {
    const keys = Object.keys(dirtyCellsRef.current);
    if (keys.length === 0) {
      toast.success('没有需要保存的内容');
      return;
    }
    toast.loading(`正在保存 ${keys.length} 个单元格...`, { id: 'manualSave' });
    let success = 0;
    let fail = 0;
    for (const key of keys) {
      const cell = dirtyCellsRef.current[key];
      if (!cell) continue;
      try {
        const res = await authedFetch(
          `https://sheets.googleapis.com/v4/spreadsheets/${sheet.id}/values/${cell.range}?valueInputOption=RAW`,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
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
      <div className="workspace" onMouseUp={(e) => { handleTextSelect(e); handleSelectionMouseUp(); }} onKeyDown={handleKeyDown} tabIndex={-1} ref={workspaceRef}>
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
          {rows.map((row, i) => (
            <TableRow
              key={row.index}
              row={row}
              i={i}
              isVisible={!filteredRowIndices || filteredRowIndices.has(row.index)}
              isSelectedCell={selectedCell?.rowIndex === i}
              isMultiSelected={selectedRows.has(i)}
              columnWidths={columnWidths}
              showIntermediate={showIntermediate}
              showTermsCol={showTermsCol}
              onCellSelect={handleCellSelect}
              onUpdateCell={updateCell}
              onTextareaRef={textareaRefCallback}
              onRowMouseDown={handleRowMouseDown}
              onRowMouseMove={handleRowMouseMove}
              onClearRowInconsistency={clearRowInconsistency}
              isFlagged={!!flaggedMap[row.index]}
              flagNote={flaggedMap[row.index]?.note || ''}
              onToggleFlag={handleToggleFlag}
              onFlagNote={handleFlagNote}
            />
          ))}
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

      {sidePanel.visible && (
        <div className="inconsistency-side-panel">
          <div className="side-panel-header">
            <h3>检查结果</h3>
            <div className="side-panel-header-actions">
              <button
                className="side-panel-ai-verify-btn"
                onClick={handleAiVerify}
                disabled={aiVerifying}
                title="只把 🟡 疑似不一致 / 🔵 术语库疑似过时 这两档送 AI 做语义复核，不读整表"
              >
                {aiVerifying ? 'AI 复核中...' : 'AI 复核'}
              </button>
              <button
                className="side-panel-export-btn"
                onClick={handleExportInconsistencies}
                title="把当前列表（已排除「不再提醒」的）导出为 CSV，方便逐条确认"
              >
                导出 CSV
              </button>
              <button className="side-panel-close" onClick={closeSidePanel}>×</button>
            </div>
          </div>
          <div className="side-panel-body">
            <p className="side-panel-summary">
              共 {sidePanel.data.length} 条提示
              （🟥 {sidePanel.data.filter(d => d.tier === 'MISSING').length}
              {' '}🔴 {sidePanel.data.filter(d => d.tier === 'CONFIRMED').length}
              {' '}🔵 {sidePanel.data.filter(d => d.tier === 'GLOSSARY_DRIFT').length}
              {' '}🟡 {sidePanel.data.filter(d => d.tier === 'REVIEW').length}）
            </p>
            <div className="side-panel-list">
              {sidePanel.data.slice(0, 200).map((item, i) => (
                <div key={i} className={`side-panel-item side-panel-item-${item.tier.toLowerCase()}`} onClick={() => handleSidePanelRowClick(item)}>
                  <div className="side-panel-item-main">
                    <span className="side-panel-tier-icon">{item.icon}</span>
                    {item.rowNo != null && <span className="side-panel-row">行 {item.rowNo}</span>}
                    <span className="side-panel-label">{item.label}</span>
                    <span className="side-panel-detail">{item.detail}</span>
                    <span className="side-panel-confidence">置信度 {Math.round(item.confidence * 100)}%</span>
                  </div>
                  {item.aiVerdict && (
                    <div className={`side-panel-ai-verdict side-panel-ai-verdict-${item.aiVerdict.verdict?.toLowerCase()}`}>
                      <span className="side-panel-ai-verdict-label">
                        {AI_VERDICT_LABEL[item.aiVerdict.verdict] || `AI: ${item.aiVerdict.verdict}`}
                      </span>
                      {item.aiVerdict.reason && <span className="side-panel-ai-verdict-reason">{item.aiVerdict.reason}</span>}
                      {item.aiVerdict.verdict === 'UPDATE_GLOSSARY' && item.aiVerdict.suggestedTarget && (
                        <span className="side-panel-ai-verdict-suggestion">建议新译法: {item.aiVerdict.suggestedTarget}</span>
                      )}
                    </div>
                  )}
                  <button
                    className="side-panel-dismiss-btn"
                    onClick={(e) => { e.stopPropagation(); handleDismissInconsistency(item); }}
                    title="不再对此项提示"
                  >
                    不再提醒
                  </button>
                </div>
              ))}
              {sidePanel.data.length > 200 && (
                <p className="side-panel-more">...还有 {sidePanel.data.length - 200} 处未显示</p>
              )}
            </div>
          </div>
        </div>
      )}


      {floatMark.visible && (
        <div 
          ref={floatMarkRef}
          className="float-mark-btn"
          style={{
            left: `${floatMark.x}px`,
            top: `${floatMark.y}px`,
          }}
          onMouseUp={(e) => e.stopPropagation()}
          onClick={handleFloatMarkClick}
          title="标记为术语 (Ctrl+Shift+Z)"
        >
          +
        </div>
      )}
    </div>
  );
}

export default TranslationWorkspace;
