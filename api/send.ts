export const config = { runtime: 'edge' };

const STRIPPED_RESPONSE_HEADERS = [
  // hop-by-hop
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  // fetch() decompresses the body but may keep these headers
  'content-encoding',
  'content-length',
];

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

function serializeError(error: unknown, depth = 0): Record<string, unknown> {
  if (depth > 3) {
    return { message: String(error) };
  }
  if (error instanceof Error) {
    const result: Record<string, unknown> = {
      name: error.name,
      message: error.message,
    };
    if (error.stack) {
      result.stack = error.stack;
    }
    const cause = (error as Error & { cause?: unknown }).cause;
    if (cause !== undefined) {
      result.cause = cause instanceof Error ? serializeError(cause, depth + 1) : String(cause);
    }
    return result;
  }
  return { name: typeof error, message: String(error) };
}

function errorReport(error: unknown): Record<string, unknown> {
  const info = serializeError(error);
  return {
    details: String(error),
    name: info.name,
    message: info.message,
    stack: info.stack,
    cause: info.cause,
  };
}

function applyCors(headers: Headers): void {
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Expose-Headers', '*');
}

function json(data: unknown, status = 200): Response {
  const response = Response.json(data, { status });
  applyCors(response.headers);
  return response;
}

function withTiming(response: Response, timing: number): Response {
  response.headers.set('X-S-Timing', String(timing));
  return response;
}

function corsPreflight(): Response {
  return new Response(null, {
    status: 204,
    statusText: 'No Content',
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Expose-Headers': '*',
      'Access-Control-Max-Age': '86400',
    },
  });
}

async function handleSend(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return corsPreflight();
  }

  // The original Worker only registers POST /@/send.
  if (req.method !== 'POST') {
    return json(
      {
        code: 404,
        success: false,
        message: 'Not Found',
        error: '',
        data: null,
      },
      404,
    );
  }

  let config: any;
  try {
    config = await req.json();
  } catch (error) {
    return json({ error: 'Invalid JSON body', ...errorReport(error) }, 400);
  }

  const {
    token,
    method = 'GET',
    url,
    headers = {},
    body = null,
    body_is_base64 = false,
    return_format = 'response',
    json_no_body = false,
  } = config ?? {};

  if (!url) {
    return json({ error: 'URL is required' }, 400);
  }

  if (process.env.TOKEN && process.env.IS_DEV !== 'true') {
    if (!token) {
      return json({ error: 'token is required' }, 400);
    } else if (token != process.env.TOKEN) {
      return json({ error: 'token is invalid' }, 400);
    }
  }

  const startTime = performance.now();

  const fetchOptions: RequestInit = {
    method,
    headers,
  };

  if (body !== null && ['POST', 'PUT', 'PATCH'].includes(String(method).toUpperCase())) {
    fetchOptions.body = body_is_base64 ? base64ToUint8Array(body) : body;
  }

  let response: Response;
  try {
    response = await fetch(url, fetchOptions);
  } catch (error) {
    return json({ error: 'Fetch failed', ...errorReport(error) }, 500);
  }

  const timing = performance.now() - startTime;

  if (return_format === 'response' || return_format === 'res') {
    const newHeaders = new Headers(response.headers);
    for (const name of STRIPPED_RESPONSE_HEADERS) {
      newHeaders.delete(name);
    }
    newHeaders.set('X-S-Timing', String(timing));
    applyCors(newHeaders);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders,
    });
  }

  if (return_format === 'json') {
    const jsonResponse: any = {
      status: response.status,
      statusText: response.statusText,
      timing,
      headers: Object.fromEntries(response.headers),
    };
    if (!json_no_body) {
      jsonResponse.body = arrayBufferToBase64(await response.arrayBuffer());
    }
    return withTiming(json(jsonResponse), timing);
  }

  return withTiming(json({ error: 'Invalid return_format' }, 400), timing);
}

export default async function handler(req: Request): Promise<Response> {
  try {
    return await handleSend(req);
  } catch (error) {
    return json(
      {
        code: 500,
        success: false,
        message: error instanceof Error ? error.message : String(error),
        error: serializeError(error),
        request: {
          method: req.method,
          url: req.url,
        },
      },
      500,
    );
  }
}