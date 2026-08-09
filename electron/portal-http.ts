import https from 'node:https'
import http from 'node:http'
import type { PortalHttpResult } from './shared-types'

/**
 * 포털 감시용 HTTP 요청 — Node 의 http/https 를 직접 쓴다.
 *
 * 렌더러의 fetch 로는 안 되는 이유:
 *   · CORS — 포털은 Electron 앱 출처를 허용하지 않는다
 *   · 사내 자체서명 인증서를 건너뛸 수 없다
 *   · 응답 헤더(X-Envoy-Upstream-Service-Time 등)를 전부 못 읽는다
 *
 * electron 에 의존하지 않게 분리해 두었다 — 이 파일만 따로 돌려 검증할 수 있어야 하기 때문.
 */

/** 본문을 이만큼만 올린다 — 인스턴스 2000건 같은 응답을 통째로 넘길 이유가 없다 */
export const PORTAL_BODY_MAX = 256 * 1024

export function portalRequest(opts: {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
  timeoutMs: number
  insecure: boolean
}): Promise<PortalHttpResult> {
  return new Promise((resolve) => {
    let u: URL
    try {
      u = new URL(opts.url)
    } catch {
      return resolve({ ok: false, error: `주소 형식이 올바르지 않습니다: ${opts.url}` })
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return resolve({ ok: false, error: `http/https 만 감시할 수 있습니다 (${u.protocol})` })
    }
    const mod = u.protocol === 'https:' ? https : http
    const started = Date.now()
    let settled = false
    const done = (r: PortalHttpResult) => {
      if (settled) return
      settled = true
      resolve(r)
    }

    let req: http.ClientRequest
    try {
      req = mod.request(
        {
          protocol: u.protocol,
          hostname: u.hostname,
          port: u.port || (u.protocol === 'https:' ? 443 : 80),
          path: u.pathname + u.search,
          method: opts.method,
          headers: opts.headers,
          // 사내 인증서 검증을 건너뛸지는 **사용자가 설정에서 켠 경우에만**.
          // 기본값은 검증을 한다 — 조용히 꺼두면 감시 대상이 바꿔치기돼도 알 수 없다.
          ...(u.protocol === 'https:' && opts.insecure ? { rejectUnauthorized: false } : {}),
        },
        (res) => {
          const chunks: Buffer[] = []
          let size = 0
          res.on('data', (d: Buffer) => {
            size += d.length
            // 상한을 넘으면 그 뒤는 버린다. 판정은 앞부분(JSON 시작)으로 충분하고,
            // 큰 응답을 통째로 들고 있으면 5초 주기 폴링에서 메모리가 계속 늘어난다.
            if (size <= PORTAL_BODY_MAX) chunks.push(d)
          })
          res.on('end', () => {
            const headers: Record<string, string> = {}
            for (const [k, v] of Object.entries(res.headers)) {
              headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v ?? '')
            }
            const up = parseInt(headers['x-envoy-upstream-service-time'] ?? '', 10)
            done({
              ok: true,
              status: res.statusCode,
              headers,
              body: Buffer.concat(chunks).toString('utf-8'),
              latencyMs: Date.now() - started,
              upstreamMs: Number.isNaN(up) ? undefined : up,
            })
          })
          res.on('error', (e) => done({ ok: false, error: e.message, latencyMs: Date.now() - started }))
        },
      )
    } catch (e) {
      return done({ ok: false, error: e instanceof Error ? e.message : String(e) })
    }

    req.setTimeout(opts.timeoutMs, () => {
      req.destroy()
      done({
        ok: false,
        timedOut: true,
        error: `응답 시간 초과(${Math.round(opts.timeoutMs / 1000)}초)`,
        latencyMs: Date.now() - started,
      })
    })
    req.on('error', (e) => done({ ok: false, error: e.message, latencyMs: Date.now() - started }))
    if (opts.body) req.write(opts.body)
    req.end()
  })
}
