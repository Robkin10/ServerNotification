const axios = require('axios');
const { CookieJar } = require('tough-cookie');

const DEFAULT_TIMEOUT_MS = 10_000;
let sharedServicePromise;
let cookieJarWrapperPromise;

class ThreeXuiApiError extends Error {
  constructor(code, message, { status, cause } = {}) {
    super(message);
    this.name = 'ThreeXuiApiError';
    this.code = code;
    this.status = status;
    this.cause = cause;
  }

  /** A safe message for HTTP clients and application logs. */
  toPublicMessage() {
    switch (this.code) {
      case 'CONFIGURATION_ERROR':
        return '3X-UI integration is not configured.';
      case 'REQUEST_TIMEOUT':
        return 'The 3X-UI panel request timed out.';
      case 'NETWORK_ERROR':
        return 'The 3X-UI panel is unavailable.';
      case 'LOGIN_REJECTED':
      case 'AUTHENTICATION_REQUIRED':
        return '3X-UI authentication was rejected.';
      case 'INVALID_RESPONSE':
      case 'INVALID_CSRF_RESPONSE':
        return 'The 3X-UI panel returned an invalid response.';
      default:
        return 'The 3X-UI panel request failed.';
    }
  }
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new ThreeXuiApiError(
      'CONFIGURATION_ERROR',
      `Missing required server configuration: ${name}.`
    );
  }
  return value;
}

function parseTimeout(value) {
  if (value === undefined || value === '') return DEFAULT_TIMEOUT_MS;
  const timeout = Number(value);
  if (!Number.isInteger(timeout) || timeout <= 0 || timeout > 120_000) {
    throw new ThreeXuiApiError(
      'CONFIGURATION_ERROR',
      'THREEXUI_TIMEOUT_MS must be an integer between 1 and 120000.'
    );
  }
  return timeout;
}

/**
 * Normalize a panel root without losing a deployment-specific path prefix.
 * A root ending in /panel is supported and will not yield /panel/panel routes.
 */
function normalizeBaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new ThreeXuiApiError('CONFIGURATION_ERROR', 'THREEXUI_BASE_URL is not a valid URL.');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ThreeXuiApiError('CONFIGURATION_ERROR', 'THREEXUI_BASE_URL must use HTTP or HTTPS.');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new ThreeXuiApiError(
      'CONFIGURATION_ERROR',
      'THREEXUI_BASE_URL must not contain credentials, a query string, or a fragment.'
    );
  }

  parsed.pathname = parsed.pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';
  return parsed.toString().replace(/\/+$/, '');
}

function appendPanelPath(baseUrl, suffix) {
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/+$/, '');
  url.pathname = `${basePath}${suffix}`.replace(/\/{2,}/g, '/');
  return url.toString();
}

function createPanelUrls(baseUrl) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const pathname = new URL(normalizedBaseUrl).pathname.replace(/\/+$/, '');
  const isPanelRoot = /(?:^|\/)panel$/i.test(pathname);
  const apiPath = isPanelRoot ? '/api' : '/panel/api';

  return {
    baseUrl: normalizedBaseUrl,
    csrfToken: appendPanelPath(normalizedBaseUrl, '/csrf-token'),
    login: appendPanelPath(normalizedBaseUrl, '/login'),
    inbounds: appendPanelPath(normalizedBaseUrl, `${apiPath}/inbounds/list`),
    clients: appendPanelPath(normalizedBaseUrl, `${apiPath}/clients/list`),
    clientDetails: appendPanelPath(normalizedBaseUrl, `${apiPath}/clients/get`)
  };
}

function getConfiguration(overrides = {}) {
  const config = {
    baseUrl: overrides.baseUrl ?? requiredEnvironment('THREEXUI_BASE_URL'),
    bearerToken: overrides.bearerToken ?? requiredEnvironment('THREEXUI_BEARER_TOKEN'),
    username: overrides.username ?? requiredEnvironment('THREEXUI_USERNAME'),
    password: overrides.password ?? requiredEnvironment('THREEXUI_PASSWORD'),
    timeoutMs: overrides.timeoutMs ?? parseTimeout(process.env.THREEXUI_TIMEOUT_MS)
  };

  if (!String(config.bearerToken).trim() || !String(config.username).trim() || !String(config.password)) {
    throw new ThreeXuiApiError('CONFIGURATION_ERROR', '3X-UI credentials are incomplete.');
  }

  return { ...config, ...createPanelUrls(config.baseUrl) };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSessionFailure(error) {
  return error instanceof ThreeXuiApiError && error.code === 'AUTHENTICATION_REQUIRED';
}

async function getCookieJarWrapper() {
  if (!cookieJarWrapperPromise) {
    cookieJarWrapperPromise = import('axios-cookiejar-support').then(({ wrapper }) => wrapper);
  }
  return cookieJarWrapperPromise;
}

class ThreeXuiService {
  constructor({ client, jar, ...configuration }) {
    this.client = client;
    this.jar = jar;
    this.configuration = configuration;
    this.authenticated = false;
    this.sessionVersion = 0;
    this.loginPromise = null;
    this.reauthenticationPromise = null;
  }

  authorizationHeaders() {
    return {
      Accept: 'application/json',
      Authorization: `Bearer ${this.configuration.bearerToken}`
    };
  }

  async request(config) {
    try {
      return await this.client.request(config);
    } catch (error) {
      if (error?.code === 'ECONNABORTED' || error?.code === 'ETIMEDOUT') {
        throw new ThreeXuiApiError('REQUEST_TIMEOUT', '3X-UI request timed out.', { cause: error });
      }
      throw new ThreeXuiApiError('NETWORK_ERROR', '3X-UI request could not be completed.', { cause: error });
    }
  }

  validateApiResponse(response, operation) {
    if (!response || !Number.isInteger(response.status)) {
      throw new ThreeXuiApiError('INVALID_RESPONSE', `3X-UI ${operation} returned no HTTP status.`);
    }

    if (response.status < 200 || response.status >= 300) {
      if (operation === 'login') {
        throw new ThreeXuiApiError('LOGIN_REJECTED', '3X-UI login was rejected.', { status: response.status });
      }
      if (response.status === 401 || response.status === 403) {
        throw new ThreeXuiApiError(
          'AUTHENTICATION_REQUIRED',
          '3X-UI session is no longer authorized.',
          { status: response.status }
        );
      }
      throw new ThreeXuiApiError('HTTP_ERROR', `3X-UI ${operation} returned HTTP ${response.status}.`, {
        status: response.status
      });
    }

    if (!isRecord(response.data)) {
      throw new ThreeXuiApiError('INVALID_RESPONSE', `3X-UI ${operation} did not return JSON.`);
    }

    if (response.data.success !== true) {
      if (operation === 'login') {
        throw new ThreeXuiApiError('LOGIN_REJECTED', '3X-UI login was rejected.', { status: response.status });
      }
      throw new ThreeXuiApiError('API_REJECTED', `3X-UI ${operation} was rejected.`, {
        status: response.status
      });
    }

    return response.data;
  }

  async getCsrfToken() {
    const response = await this.request({
      method: 'GET',
      url: this.configuration.csrfToken,
      headers: this.authorizationHeaders()
    });
    const payload = this.validateApiResponse(response, 'CSRF token request');
    const token = payload.obj;

    if (typeof token !== 'string' || token.trim() === '') {
      throw new ThreeXuiApiError('INVALID_CSRF_RESPONSE', '3X-UI returned an invalid CSRF token.');
    }

    return token;
  }

  async performLogin(twoFactorCode) {
    const csrfToken = await this.getCsrfToken();
    const form = new URLSearchParams({
      username: this.configuration.username,
      password: this.configuration.password
    });

    if (twoFactorCode !== undefined && twoFactorCode !== null && String(twoFactorCode).trim() !== '') {
      form.set('twoFactorCode', String(twoFactorCode).trim());
    }

    const response = await this.request({
      method: 'POST',
      url: this.configuration.login,
      data: form.toString(),
      headers: {
        ...this.authorizationHeaders(),
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-CSRF-Token': csrfToken
      }
    });
    this.validateApiResponse(response, 'login');
    this.authenticated = true;
    this.sessionVersion += 1;
    return this.sessionVersion;
  }

  /** Log in once and share the resulting session with concurrent callers. */
  async login(twoFactorCode) {
    if (this.authenticated) return this.sessionVersion;
    if (!this.loginPromise) {
      this.loginPromise = this.performLogin(twoFactorCode).catch((error) => {
        this.authenticated = false;
        throw error;
      }).finally(() => {
        this.loginPromise = null;
      });
    }
    return this.loginPromise;
  }

  async authenticate(twoFactorCode) {
    return this.login(twoFactorCode);
  }

  async clearSessionCookies() {
    if (this.jar && typeof this.jar.removeAllCookies === 'function') {
      await this.jar.removeAllCookies();
    }
  }

  async reauthenticateAfterExpiry(sessionVersion, twoFactorCode) {
    if (this.authenticated && this.sessionVersion !== sessionVersion) {
      return this.sessionVersion;
    }

    if (!this.reauthenticationPromise) {
      this.reauthenticationPromise = (async () => {
        this.authenticated = false;
        await this.clearSessionCookies();
        return this.authenticate(twoFactorCode);
      })().finally(() => {
        this.reauthenticationPromise = null;
      });
    }

    return this.reauthenticationPromise;
  }

  async requestArray(url, operation) {
    const response = await this.request({
      method: 'GET',
      url,
      headers: this.authorizationHeaders()
    });
    const payload = this.validateApiResponse(response, operation);

    if (!Array.isArray(payload.obj)) {
      throw new ThreeXuiApiError('INVALID_RESPONSE', `3X-UI ${operation} did not contain an array.`);
    }

    return payload.obj;
  }

  async requestInbounds() {
    return this.requestArray(this.configuration.inbounds, 'inbound list');
  }

  async requestClients() {
    return this.requestArray(this.configuration.clients, 'client list');
  }

  async requestClientDetails(email) {
    if (typeof email !== 'string' || email.trim() === '') {
      throw new ThreeXuiApiError('INVALID_RESPONSE', '3X-UI client detail request requires an email.');
    }

    const response = await this.request({
      method: 'GET',
      url: `${this.configuration.clientDetails}/${encodeURIComponent(email.trim())}`,
      headers: this.authorizationHeaders()
    });
    const payload = this.validateApiResponse(response, 'client detail');
    const client = isRecord(payload.obj?.client) ? payload.obj.client : payload.obj;
    if (!isRecord(client)) {
      throw new ThreeXuiApiError('INVALID_RESPONSE', '3X-UI client detail did not contain an object.');
    }

    // Do not retain unrelated, sensitive client fields returned by the panel.
    return {
      email: client.email,
      tgId: client.tgId,
      expiryTime: client.expiryTime,
      enable: client.enable
    };
  }

  async withAuthenticatedSession(requestList, twoFactorCode) {
    const sessionVersion = await this.authenticate(twoFactorCode);
    try {
      return await requestList();
    } catch (error) {
      if (!isSessionFailure(error)) throw error;
      await this.reauthenticateAfterExpiry(sessionVersion, twoFactorCode);
      return requestList();
    }
  }

  /**
   * List inbounds with a shared authenticated session. The only automatic retry is
   * one reauthentication followed by one repeat of this safe GET request.
   */
  async listInbounds({ twoFactorCode } = {}) {
    return this.withAuthenticatedSession(() => this.requestInbounds(), twoFactorCode);
  }

  /** Return the panel's complete client list through the authenticated session. */
  async listClients({ twoFactorCode } = {}) {
    return this.withAuthenticatedSession(() => this.requestClients(), twoFactorCode);
  }

  /**
   * Retrieve one client using the panel's detail route. This is authoritative
   * for tgId because paginated client-list responses intentionally omit it.
   */
  async getClientDetails(email, { twoFactorCode } = {}) {
    return this.withAuthenticatedSession(() => this.requestClientDetails(email), twoFactorCode);
  }
}

async function createThreeXuiService(overrides = {}) {
  const configuration = getConfiguration(overrides);
  const jar = overrides.jar || new CookieJar();
  const wrapper = await getCookieJarWrapper();
  const client = overrides.client || wrapper(axios.create({
    jar,
    withCredentials: true,
    timeout: configuration.timeoutMs,
    validateStatus: () => true
  }));

  return new ThreeXuiService({ client, jar, ...configuration });
}

function getThreeXuiService() {
  if (!sharedServicePromise) {
    sharedServicePromise = createThreeXuiService().catch((error) => {
      sharedServicePromise = null;
      throw error;
    });
  }
  return sharedServicePromise;
}

async function fetchInbounds(options) {
  const service = await getThreeXuiService();
  return service.listInbounds(options);
}

async function fetchClients(options) {
  const service = await getThreeXuiService();
  return service.listClients(options);
}

async function fetchClientDetails(email, options) {
  const service = await getThreeXuiService();
  return service.getClientDetails(email, options);
}

module.exports = {
  ThreeXuiApiError,
  ThreeXuiService,
  createPanelUrls,
  createThreeXuiService,
  fetchClientDetails,
  fetchClients,
  fetchInbounds,
  getThreeXuiService,
  normalizeBaseUrl
};
