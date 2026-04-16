// Thin fetch wrapper for the /api/optimization-data admin endpoints.
// Handles the X-Admin-Token header on writes and normalizes error responses
// into rejected promises so callers can use try/catch.

const API_BASE_URL =
    process.env.REACT_APP_API_URL ||
    (window.location.hostname === 'localhost'
        ? 'http://localhost:3001'
        : 'https://production-scheduler-backend-aepw.onrender.com');

const TOKEN_KEY = 'tegAdminToken';

export const getAdminToken = () => localStorage.getItem(TOKEN_KEY) || '';
export const setAdminToken = (token) => {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
};

async function handleResponse(res) {
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
    if (!res.ok) {
        const err = new Error((body && body.error) || `HTTP ${res.status}`);
        err.status = res.status;
        err.body = body;
        throw err;
    }
    return body;
}

// --- reads (no auth) ---

export const getLatestRaw = () =>
    fetch(`${API_BASE_URL}/api/optimization-data/latest/raw`).then(handleResponse);

export const getLatest = () =>
    fetch(`${API_BASE_URL}/api/optimization-data/latest`).then(handleResponse);

export const getHistory = () =>
    fetch(`${API_BASE_URL}/api/optimization-data/history`).then(handleResponse);

// --- writes (require X-Admin-Token) ---

function writeHeaders() {
    const token = getAdminToken();
    return {
        'Content-Type': 'application/json',
        ...(token ? { 'X-Admin-Token': token } : {}),
    };
}

export const patchTasksCsv = (tasksCsv) =>
    fetch(`${API_BASE_URL}/api/optimization-data/tasks`, {
        method: 'PATCH',
        headers: writeHeaders(),
        body: JSON.stringify({ tasksCsv }),
    }).then(handleResponse);

export const patchDatesCsv = (datesCsv) =>
    fetch(`${API_BASE_URL}/api/optimization-data/dates`, {
        method: 'PATCH',
        headers: writeHeaders(),
        body: JSON.stringify({ datesCsv }),
    }).then(handleResponse);

export const patchStoreDates = (updates) =>
    fetch(`${API_BASE_URL}/api/optimization-data/store-dates`, {
        method: 'PATCH',
        headers: writeHeaders(),
        body: JSON.stringify({ updates }),
    }).then(handleResponse);

// PATCH config supports two modes; we expose them as separate calls for clarity.
export const patchConfigMerge = (mergeFields) =>
    fetch(`${API_BASE_URL}/api/optimization-data/config`, {
        method: 'PATCH',
        headers: writeHeaders(),
        body: JSON.stringify({ merge: mergeFields }),
    }).then(handleResponse);

export const patchConfigReplace = (config) =>
    fetch(`${API_BASE_URL}/api/optimization-data/config`, {
        method: 'PATCH',
        headers: writeHeaders(),
        body: JSON.stringify({ config }),
    }).then(handleResponse);

// Full POST — rarely used from the admin UI but available.
export const postFullUpload = ({ tasksCsv, datesCsv, configJson }) =>
    fetch(`${API_BASE_URL}/api/optimization-data`, {
        method: 'POST',
        headers: writeHeaders(),
        body: JSON.stringify({ tasksCsv, datesCsv, configJson }),
    }).then(handleResponse);
