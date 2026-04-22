export function createApiClient({ state }) {
  async function getHeaders(authRequired = true) {
    const headers = { "Content-Type": "application/json" };
    if (!authRequired) return headers;
    if (!state.auth?.currentUser) throw new Error("Please login first.");
    headers.Authorization = `Bearer ${await state.auth.currentUser.getIdToken()}`;
    return headers;
  }

  async function api(method, path, body, authRequired = true) {
    const request = async (forceRefreshToken = false) => fetch(path, {
      method,
      cache: "no-store",
      headers: authRequired
        ? {
          "Content-Type": "application/json",
          Authorization: `Bearer ${await state.auth.currentUser.getIdToken(forceRefreshToken)}`,
        }
        : await getHeaders(false),
      body: body ? JSON.stringify(body) : undefined,
    });
    let res = await request(false);
    if (authRequired && res.status === 401 && state.auth?.currentUser) {
      // Retry once with forced token refresh to handle transient auth races.
      res = await request(true);
    }
    const raw = await res.text();
    let data = null;
    if (raw) {
      try {
        data = JSON.parse(raw);
      } catch {
        data = { text: raw };
      }
    } else {
      data = {};
    }
    if (!res.ok) throw new Error(JSON.stringify({ status: res.status, data }, null, 2));
    return data;
  }

  return {
    getHeaders,
    api,
  };
}
