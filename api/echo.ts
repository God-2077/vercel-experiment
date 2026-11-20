export const config = { runtime: 'edge' };

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

function applyCors(headers: Headers): void {
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Expose-Headers', '*');
}

function json(data: unknown, status = 200): Response {
  const response = Response.json(data, { status });
  applyCors(response.headers);
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

async function readBody(req: Request): Promise<{ data: string; isBase64Encoded: boolean }> {
  // Same as the Worker's echoMiddleware: no body for GET/HEAD.
  if (req.method === 'GET' || req.method === 'HEAD') {
    return { data: '', isBase64Encoded: false };
  }

  const contentType = req.headers.get('content-type') || '';
  try {
    if (contentType.includes('multipart/form-data')) {
      return {
        data: arrayBufferToBase64(await req.arrayBuffer()),
        isBase64Encoded: true,
      };
    }
    return { data: await req.text(), isBase64Encoded: false };
  } catch {
    return { data: '', isBase64Encoded: false };
  }
}

async function handleEcho(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return corsPreflight();
  }

  const url = new URL(req.url);

  const args: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    args[key] = value;
  });

  const headers: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  const { data, isBase64Encoded } = await readBody(req);

  return json({
    method: req.method,
    args,
    data,
    headers,
    path: url.pathname,
    isBase64Encoded,
  });
}

export default async function handler(req: Request): Promise<Response> {
  try {
    return await handleEcho(req);
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