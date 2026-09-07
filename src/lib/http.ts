/** Small HTTP helpers */

export function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...headers,
    },
  });
}

export function html(body: string, status = 200, headers: HeadersInit = {}): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      ...headers,
    },
  });
}

export function badRequest(message: string, status = 400): Response {
  return json({ message }, status);
}

export function notFound(message = 'Not found'): Response {
  return json({ message }, 404);
}

export function unauthorized(message = 'Unauthorized'): Response {
  return json({ message }, 401);
}
