// 검사 도우미 — scripts/check.mjs 가 이 출력(PASS/FAIL 줄)을 센다
import { readFileSync } from 'node:fs'
import path from 'node:path'

let fails = 0

export function test(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`PASS ${name}`)
  } catch (e) {
    fails++
    console.log(`FAIL ${name} — ${e instanceof Error ? e.message : String(e)}`)
  }
}

export function eq(actual: unknown, expected: unknown, label = ''): void {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${label ? label + ': ' : ''}기대 ${b} · 실제 ${a}`)
}

export function ok(cond: unknown, label = '조건 불만족'): void {
  if (!cond) throw new Error(label)
}

/** 실제 장비에서 받은 출력 견본 */
export function fixture(name: string): string {
  return readFileSync(path.join(process.env.QT_FIXTURES ?? path.join(__dirname, 'fixtures'), name), 'utf8')
}

process.on('exit', () => {
  if (fails) process.exitCode = 1
})
