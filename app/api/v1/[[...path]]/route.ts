import { NextRequest, NextResponse } from "next/server";
import { createInternalToken } from "@/lib/mobile-auth";
import { logApiRequest, rateLimit, verifyApiKey } from "@/lib/api-keys";
import { enrichSchedule } from "@/lib/api-v1-enrich";
import { buildOpenApi, checkParams, ENDPOINTS, filterActivities, matchEndpoint } from "@/lib/api-v1-spec";

export const dynamic = "force-dynamic";

// The read-only external API. GET only. /api/v1/openapi.json and /api/v1/docs are public (they describe the API, no data);
// every other path needs an API key (Settings → API access). After the key and rate limit are checked the request is
// answered by calling the app's own route for that data, so the numbers match what the web pages show.

function baseUrl(req: NextRequest): string {
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "localhost:5005";
  const proto = req.headers.get("x-forwarded-proto") ?? (host.startsWith("localhost") || /^\d+\.\d+\.\d+\.\d+/.test(host) ? "http" : "https");
  return `${proto}://${host.split(",")[0].trim()}/api/v1`;
}

function err(status: number, code: string, message: string, headers?: Record<string, string>) {
  return NextResponse.json({ error: { code, message } }, { status, headers });
}

const DOCS_HTML = (spec: string) => `<!doctype html><html><head><meta charset="utf-8"><title>PaceSync API</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css"></head>
<body><div id="ui"></div>
<script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script>window.ui=SwaggerUIBundle({url:${JSON.stringify(spec)},dom_id:"#ui",persistAuthorization:true,tryItOutEnabled:true});</script>
</body></html>`;

export async function GET(req: NextRequest, { params }: { params: { path?: string[] } }) {
  const started = Date.now();
  const path = "/" + (params.path ?? []).join("/");
  const base = baseUrl(req);

  if (path === "/openapi.json") return NextResponse.json(buildOpenApi(base));
  if (path === "/docs") return new NextResponse(DOCS_HTML(`${base}/openapi.json`), { headers: { "Content-Type": "text/html; charset=utf-8" } });
  if (path === "/") {
    return NextResponse.json({
      name: "PaceSync API", version: "1.0.0", auth: "Authorization: Bearer psk_… (or X-API-Key)", openapi: `${base}/openapi.json`, docs: `${base}/docs`,
      endpoints: ENDPOINTS.map(e => ({ path: `${base}${e.path}`, summary: e.summary })),
    });
  }

  const key = verifyApiKey(req.headers);
  if (!key) return err(401, "unauthorized", "Missing or invalid API key. Send it as 'Authorization: Bearer psk_…'.", { "WWW-Authenticate": "Bearer" });
  const rl = rateLimit(key.id);
  if (!rl.ok) {
    logApiRequest(key.id, path, 429, Date.now() - started);
    return err(429, "rate_limited", `Rate limit is 60 requests a minute. Retry in ${rl.retryAfterSec}s.`, { "Retry-After": String(rl.retryAfterSec) });
  }

  const finish = (status: number, res: NextResponse) => { logApiRequest(key.id, path, status, Date.now() - started); return res; };

  const m = matchEndpoint(path);
  if (!m) return finish(404, err(404, "not_found", `No such endpoint. See ${base}/openapi.json.`));
  const q = checkParams(m.ep, m.params, req.nextUrl.searchParams);
  if (!q.ok) return finish(400, err(400, "bad_request", q.error));

  let internal = m.ep.internal;
  for (const [k, v] of Object.entries(m.params)) internal = internal.replace(`{${k}}`, encodeURIComponent(v));
  const qs = q.query.toString();
  try {
    const origin = `http://127.0.0.1:${process.env.PORT ?? 5005}`;
    const token = await createInternalToken();
    const res = await fetch(`${origin}${internal}${qs ? `?${qs}` : ""}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store", signal: AbortSignal.timeout(90_000),
    });
    const text = await res.text();
    let data: unknown; try { data = JSON.parse(text); } catch { data = null; }
    if (!res.ok || data == null) {
      const msg = data && typeof data === "object" && "error" in data ? String((data as { error: unknown }).error) : `Upstream returned ${res.status}.`;
      const status = res.status === 404 ? 404 : res.status >= 500 || data == null ? 502 : res.status;
      return finish(status, err(status, status === 404 ? "not_found" : status === 502 ? "upstream_error" : "error", msg));
    }
    if (m.ep.path === "/schedule") data = await enrichSchedule(data as Record<string, unknown>, origin, token);
    if (m.ep.path === "/activities") data = filterActivities(data as Record<string, unknown>, q.query);
    return finish(200, NextResponse.json(data, { headers: { "Cache-Control": "no-store" } }));
  } catch (e) {
    return finish(504, err(504, "timeout", e instanceof Error ? e.message : "The data source didn't answer."));
  }
}

const notAllowed = () => err(405, "method_not_allowed", "This API is read-only: GET only.", { Allow: "GET" });
export const POST = notAllowed, PUT = notAllowed, PATCH = notAllowed, DELETE = notAllowed;
