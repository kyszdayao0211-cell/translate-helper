chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'GET_TERMS') {
    chrome.storage.local.get(['terms'], (result) => {
      sendResponse(result.terms || []);
    });
    return true;
  }
  
  if (request.type === 'SAVE_TERM') {
    chrome.storage.local.get(['terms'], (result) => {
      const terms = result.terms || [];
      const existingIndex = terms.findIndex(t => t.source === request.term.source);
      
      if (existingIndex >= 0) {
        terms[existingIndex] = { 
          ...terms[existingIndex], 
          target: request.term.target,
          count: (terms[existingIndex].count || 1) + 1
        };
      } else {
        terms.push(request.term);
      }
      
      chrome.storage.local.set({ terms });
      sendResponse({ success: true });
    });
    return true;
  }

  if (request.type === 'GET_TERM_LIBRARIES') {
    chrome.storage.local.get(['termLibraries'], (result) => {
      sendResponse(result.termLibraries || []);
    });
    return true;
  }
  
  if (request.type === 'SAVE_TERM_LIBRARY') {
    chrome.storage.local.get(['termLibraries'], (result) => {
      const libs = result.termLibraries || [];
      const existingIndex = libs.findIndex(l => l.id === request.library.id);
      
      if (existingIndex >= 0) {
        libs[existingIndex] = { ...request.library, updatedAt: new Date().toISOString() };
      } else {
        libs.push({ ...request.library, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      }
      
      chrome.storage.local.set({ termLibraries: libs });
      sendResponse({ success: true });
    });
    return true;
  }

  if (request.type === 'SET_TABLE_BINDING') {
    chrome.storage.local.get(['sheetSettings'], (result) => {
      const settings = result.sheetSettings || {};
      settings.termLibraryBindingId = request.libraryId;
      chrome.storage.local.set({ sheetSettings: settings });
      sendResponse({ success: true });
    });
    return true;
  }
  
  if (request.type === 'GET_TABLE_BINDING') {
    chrome.storage.local.get(['sheetSettings'], (result) => {
      sendResponse(result.sheetSettings?.termLibraryBindingId || null);
    });
    return true;
  }

  if (request.type === 'GET_FILTERED_ROWS') {
    getFilteredVisibleRows(request.spreadsheetId, request.sheetTitle)
      .then(rows => sendResponse({ visibleRows: rows }))
      .catch(err => sendResponse({ error: err.message, visibleRows: [] }));
    return true;
  }
});

async function getFilteredVisibleRows(spreadsheetId, sheetTitle) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: false }, async (token) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      try {
        const range = sheetTitle ? `&ranges=${encodeURIComponent(sheetTitle)}` : '';
        const res = await fetch(
          `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?includeGridData=true${range}&fields=sheets.data.rowMetadata`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (!res.ok) throw new Error(`API error: ${res.status}`);
        const data = await res.json();
        if (!data.sheets?.[0]?.data?.[0]?.rowMetadata) {
          return [];
        }
        const rowMetadata = data.sheets[0].data[0].rowMetadata;
        const visibleRows = [];
        rowMetadata.forEach((row, index) => {
          if (!row.hiddenByFilter) {
            visibleRows.push(index + 1);
          }
        });
        return visibleRows;
      } catch (e) {
        reject(e);
      }
    });
  });
}