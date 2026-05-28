let terms = [];

async function loadTerms() {
  const result = await chrome.storage.local.get(['terms']);
  terms = result.terms || [];
}

loadTerms();

// 过滤变化监听器
let filterObserver = null;
let lastRowSnapshot = null;

function getSpreadsheetId() {
  const match = location.href.match(/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : null;
}

function getCurrentSheetTitle() {
  const tab = document.querySelector('.docs-sheet-tab[aria-selected="true"]');
  return tab?.textContent?.trim() || '';
}

async function getFilteredRowsFromBackground() {
  const spreadsheetId = getSpreadsheetId();
  if (!spreadsheetId) return [];

  const sheetTitle = getCurrentSheetTitle();

  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: 'GET_FILTERED_ROWS', spreadsheetId, sheetTitle },
      (response) => {
        if (chrome.runtime.lastError || response?.error) {
          console.error('getFilteredRows error:', chrome.runtime.lastError || response?.error);
          resolve([]);
        } else {
          resolve(response.visibleRows || []);
        }
      }
    );
  });
}

function startFilterWatcher() {
  const container = document.querySelector('.grid-container');
  if (!container) return;

  filterObserver = new MutationObserver(
    debounce(async () => {
      const currentRows = await getFilteredRowsFromBackground();
      const snapshot = JSON.stringify(currentRows);
      if (snapshot !== lastRowSnapshot) {
        lastRowSnapshot = snapshot;
        chrome.runtime.sendMessage({
          type: 'FILTER_CHANGED',
          visibleRows: currentRows,
          timestamp: Date.now()
        });
      }
    }, 300)
  );

  filterObserver.observe(container, {
    attributes: true,
    attributeFilter: ['style', 'class'],
    subtree: true
  });
}

// 简单防抖
function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

// 页面加载完成后启动
if (document.readyState === 'complete') {
  startFilterWatcher();
} else {
  window.addEventListener('load', startFilterWatcher);
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'HIGHLIGHT_TERMS') {
    loadTerms().then(() => {
      highlightTermsInSheet();
      sendResponse({ success: true });
    });
    return true;
  }
  if (request.type === 'CLEAR_HIGHLIGHTS') {
    clearAllHighlights();
    sendResponse({ success: true });
    return true;
  }
  if (request.type === 'GET_TERMS') {
    sendResponse(terms);
  }
  if (request.type === 'REFRESH_TERMS') {
    loadTerms().then(() => {
      highlightTermsInSheet();
      sendResponse({ success: true });
    });
    return true;
  }
  return true;
});

function findMatchingTerms(text) {
  if (!text) return [];
  return terms.filter(t => {
    if (!t.source) return false;
    if (t.caseSensitive) {
      return text.includes(t.source);
    } else {
      return text.toLowerCase().includes(t.source.toLowerCase());
    }
  });
}

function clearAllHighlights() {
  const cells = document.querySelectorAll('.grid-cell, .cell-input');
  cells.forEach(cell => {
    cell.style.backgroundColor = '';
    cell.style.border = '';
  });
}

function highlightTermsInSheet() {
  clearAllHighlights();
  
  const cells = document.querySelectorAll('.grid-cell, .cell-input');
  
  cells.forEach(cell => {
    const text = cell.textContent?.trim();
    if (!text) return;
    
    const matchedTerms = findMatchingTerms(text);
    if (matchedTerms.length > 0) {
      cell.style.backgroundColor = '#e8f5e9';
      cell.style.border = '2px solid #4caf50';
      cell.title = `术语翻译: ${matchedTerms.map(t => `${t.source} → ${t.target}`).join('; ')}`;
    }
  });
}

document.addEventListener('click', (e) => {
  const cell = e.target.closest('.grid-cell, .cell-input');
  if (!cell) {
    const existing = document.getElementById('term-popup');
    if (existing) existing.remove();
    return;
  }
  
  const text = cell.textContent?.trim();
  if (!text) return;
  
  const matchedTerms = findMatchingTerms(text);
  if (matchedTerms.length > 0) {
    const rect = cell.getBoundingClientRect();
    showTermPopup(matchedTerms, rect);
  }
});

function showTermPopup(matchedTerms, position) {
  const existing = document.getElementById('term-popup');
  if (existing) existing.remove();
  
  const popup = document.createElement('div');
  popup.id = 'term-popup';
  
  const termsHtml = matchedTerms.map(term => `
    <div class="term-item">
      <span class="term-source">${term.source}</span>
      <span class="term-arrow">→</span>
      <span class="term-target">${term.target}</span>
      ${term.count > 1 ? `<span class="term-count">×${term.count}</span>` : ''}
    </div>
  `).join('');
  
  popup.innerHTML = `
    <div class="term-popup-content">
      <div class="term-popup-header">
        <span>术语提醒</span>
        <button class="term-popup-close">×</button>
      </div>
      ${termsHtml}
    </div>
  `;
  
  popup.querySelector('.term-popup-close').addEventListener('click', (e) => {
    e.stopPropagation();
    popup.remove();
  });
  
  popup.style.cssText = `
    position: fixed;
    left: ${position.left + position.width / 2}px;
    top: ${position.top - 10}px;
    transform: translateX(-50%) translateY(-100%);
    background: white;
    border: 1px solid #e0e0e0;
    border-radius: 8px;
    padding: 10px 14px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.15);
    z-index: 10000;
    font-size: 13px;
    max-width: 350px;
    min-width: 150px;
    animation: termPopupFadeIn 0.15s ease-out;
  `;
  
  document.body.appendChild(popup);
}

const style = document.createElement('style');
style.textContent = `
  @keyframes termPopupFadeIn {
    from { opacity: 0; transform: translateX(-50%) translateY(-100%) translateY(5px); }
    to { opacity: 1; transform: translateX(-50%) translateY(-100%); }
  }
  #term-popup .term-popup-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-weight: 600;
    color: #333;
    margin-bottom: 8px;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  #term-popup .term-popup-close {
    background: none;
    border: none;
    font-size: 18px;
    cursor: pointer;
    color: #999;
    padding: 0 4px;
    line-height: 1;
  }
  #term-popup .term-popup-close:hover {
    color: #333;
  }
  #term-popup .term-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 0;
  }
  #term-popup .term-item + .term-item {
    border-top: 1px solid #f0f0f0;
    margin-top: 4px;
    padding-top: 8px;
  }
  #term-popup .term-source {
    color: #1976d2;
    font-weight: 500;
    max-width: 120px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  #term-popup .term-arrow {
    color: #999;
    font-size: 12px;
  }
  #term-popup .term-target {
    color: #2e7d32;
    font-weight: 500;
    flex: 1;
    max-width: 150px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  #term-popup .term-count {
    background: #e3f2fd;
    color: #1976d2;
    font-size: 10px;
    padding: 2px 6px;
    border-radius: 10px;
    flex-shrink: 0;
  }
  #term-popup::after {
    content: '';
    position: absolute;
    top: 100%;
    left: 50%;
    transform: translateX(-50%);
    border: 6px solid transparent;
    border-top-color: white;
  }
`;
document.head.appendChild(style);
