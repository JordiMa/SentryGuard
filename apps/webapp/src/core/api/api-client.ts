import { getToken } from './token-manager';

const DEFAULT_API_URL = 'http://localhost:3001';

let cachedConfig: { apiUrl: string; virtualKeyUrl: string } | null = null;
let fetchPromise: Promise<{ apiUrl: string; virtualKeyUrl: string }> | null = null;

async function resolveRuntimeConfig(): Promise<{ apiUrl: string; virtualKeyUrl: string }> {
  if (cachedConfig) {
    return cachedConfig;
  }

  if (fetchPromise) {
    return fetchPromise;
  }

  fetchPromise = fetch('/api/runtime-config')
    .then((res) => res.json())
    .then((data: { apiUrl?: string; virtualKeyUrl?: string }) => {
      cachedConfig = {
        apiUrl: data.apiUrl || DEFAULT_API_URL,
        virtualKeyUrl: data.virtualKeyUrl || '',
      };
      return cachedConfig;
    })
    .catch(() => {
      cachedConfig = { apiUrl: DEFAULT_API_URL, virtualKeyUrl: '' };
      return cachedConfig;
    })
    .finally(() => {
      fetchPromise = null;
    });

  return fetchPromise;
}

export async function resolveApiUrl(): Promise<string> {
  const config = await resolveRuntimeConfig();
  return config.apiUrl;
}

export async function resolveVirtualKeyUrl(): Promise<string> {
  const config = await resolveRuntimeConfig();
  return config.virtualKeyUrl;
}

export class ApiError extends Error {
  constructor(message: string, public status?: number, public data?: any) {
    super(message);
    this.name = 'ApiError';
  }
}

export class ScopeError extends Error {
  constructor(public missingScopes: string[], public returnUrl?: string) {
    super('Missing required permissions');
    this.name = 'ScopeError';
  }
}

export interface ApiClientRequirements {
  request<T>(endpoint: string, options?: RequestInit): Promise<T>;
}

export class ApiClient implements ApiClientRequirements {
  async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const token = getToken();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...((options.headers as Record<string, string>) || {}),
    };

    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const baseUrl = await resolveApiUrl();
    const url = `${baseUrl}${endpoint}`;

    try {
      const response = await fetch(url, {
        ...options,
        headers,
      });

      if (response.status === 401) {
        let errorData: any = {};
        try {
          errorData = await response.json();
        } catch (e) {
          // Ignore JSON parse errors
        }

        throw new ApiError(
          errorData?.message || 'Authentication expired. Please log in again.',
          401,
          errorData
        );
      }

      if (!response.ok) {
        let errorMessage = `API Error: ${response.statusText}`;
        try {
          const errorData = await response.json();
          errorMessage = errorData.message || errorMessage;

          if (errorData.message?.includes('Missing required permissions')) {
            const missingScopes =
              errorData.message.match(/Missing required permissions: (.+)/)?.[1]?.split(', ') || [];
            throw new ScopeError(missingScopes);
          }

          throw new ApiError(errorMessage, response.status, errorData);
        } catch (e) {
          if (e instanceof ScopeError || e instanceof ApiError) throw e;
          throw new ApiError(errorMessage, response.status);
        }
      }

      const contentType = response.headers.get('content-type');
      let data: T;
      if (contentType && contentType.includes('application/json')) {
        data = await response.json();
      } else {
        data = {} as T;
      }

      return data;
    } catch (error) {
      if (error instanceof ApiError || error instanceof ScopeError) {
        throw error;
      }
      throw new ApiError(error instanceof Error ? error.message : 'Network error occurred');
    }
  }
}
