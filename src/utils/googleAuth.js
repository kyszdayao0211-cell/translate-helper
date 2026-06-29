// 统一的 Google OAuth token 管理 + 带自动刷新重试的 fetch。
//
// 问题背景：Chrome 会缓存 OAuth token，过期后 getAuthToken({interactive:false})
// 仍会返回那个已过期的缓存 token，导致 Sheets API 直接 401，用户被迫重新登录。
// 解决：请求 401/403 时先清掉缓存 token，再静默刷新一次并重试，尽量避免手动登录。

// 获取 token；interactive=false 静默，失败时调用方可重试。
export function getAuthToken(interactive) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError || !token) {
        reject(new Error(chrome.runtime.lastError?.message || '获取授权失败'));
      } else {
        resolve(token);
      }
    });
  });
}

// 从 Chrome 缓存中移除某个 token（通常因为它已过期/失效）。
export function removeCachedToken(token) {
  return new Promise((resolve) => {
    if (!token) return resolve();
    chrome.identity.removeCachedAuthToken({ token }, () => resolve());
  });
}

// 获取一个尽量有效的 token：先静默拿；失败则清缓存后交互式登录。
export async function getFreshToken() {
  try {
    return await getAuthToken(false);
  } catch (e) {
    // 静默失败：清掉可能残留的缓存，再交互式获取
    await removeCachedToken('');
    return await getAuthToken(true);
  }
}

// 带自动刷新重试的 fetch：注入 Bearer token；遇到 401/403 时清缓存→静默刷新→重试一次。
// 仍 401 时再交互式登录重试最后一次。
export async function authedFetch(url, options = {}) {
  let token = await getFreshToken();
  const buildOpts = (t) => ({
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${t}` },
  });

  let response = await fetch(url, buildOpts(token));
  if (response.status !== 401 && response.status !== 403) return response;

  // 第一次失败：清掉这个过期 token，静默刷新后重试
  await removeCachedToken(token);
  try {
    token = await getAuthToken(false);
  } catch (e) {
    token = await getAuthToken(true);
  }
  response = await fetch(url, buildOpts(token));
  if (response.status !== 401 && response.status !== 403) return response;

  // 第二次仍失败：交互式登录后最后重试一次
  await removeCachedToken(token);
  token = await getAuthToken(true);
  return fetch(url, buildOpts(token));
}
