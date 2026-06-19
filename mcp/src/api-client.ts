// HTTP client for the Issue Tracker REST API, plus MCP response helpers.

import { CONFIG } from "./config.js";

type ApiResult<T> = { data?: T; error?: string; status: number };

export async function apiRequest<T>(
  path: string,
  options: RequestInit = {}
): Promise<ApiResult<T>> {
  const response = await fetch(`${CONFIG.issueTrackerUrl}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json" },
  });
  if (response.status === 204) return { status: 204 };
  const data = await response.json();
  if (!response.ok) return { error: data.error ?? "Unknown error", status: response.status };
  return { data: data as T, status: response.status };
}

// MCP tool response helpers — wrap a result or error in the SDK's content format.
export function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

export function err(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: `Error: ${message}` }] };
}
