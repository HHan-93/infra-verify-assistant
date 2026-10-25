// 판정 로직 검사 — `npm run check`
//
// tests/*.test.ts 를 하나씩 esbuild 로 묶어 node 로 돌린다. 테스트 프레임워크를 들이지 않은 이유:
// 검사 대상이 src/lib 의 순수 함수(파서·판정)뿐이라 assert 몇 개로 충분하고, 의존성을 늘리면 설치본 빌드에
// 신경 쓸 것이 늘어난다. esbuild 는 vite 가 이미 쓰고 있다. 설치본(build.files = dist·dist-electron)에는 안 들어간다.
//
// 견본(tests/fixtures)은 **실제 장비에서 받은 출력**이다 — 추측으로 만든 출력으로 맞춘 파서는 현장에서 틀린다.
// 시각 변환 검사가 PC 시간대에 따라 달라지지 않게 TZ 를 Asia/Seoul 로 고정해 돌린다.
import { build } from 'esbuild'
import { readdirSync, mkdtempSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const testsDir = path.join(root, 'tests')
const only = process.argv[2]
const files = readdirSync(testsDir)
  .filter((f) => f.endsWith('.test.ts') && (!only || f.includes(only)))
  .sort()
const out = mkdtempSync(path.join(tmpdir(), 'qterm-check-'))
let failed = 0
let passed = 0
try {
  for (const f of files) {
    const bundle = path.join(out, f.replace(/\.ts$/, '.cjs'))
    await build({
      entryPoints: [path.join(testsDir, f)],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: bundle,
      logLevel: 'error',
    })
    const r = spawnSync(process.execPath, [bundle], {
      encoding: 'utf8',
      env: { ...process.env, TZ: 'Asia/Seoul', QT_FIXTURES: path.join(testsDir, 'fixtures') },
    })
    const lines = (r.stdout || '').split('\n').filter(Boolean)
    const fails = lines.filter((l) => l.startsWith('FAIL'))
    passed += lines.filter((l) => l.startsWith('PASS')).length
    failed += fails.length + (r.status !== 0 && !fails.length ? 1 : 0)
    console.log(`${fails.length || r.status ? '✗' : '✓'} ${f} — ${lines.length - fails.length}/${lines.length}`)
    for (const l of fails) console.log('   ' + l)
    if (r.stderr?.trim()) console.log(r.stderr.trim().split('\n').map((l) => '   ' + l).join('\n'))
  }
} finally {
  rmSync(out, { recursive: true, force: true })
}
console.log(`\n${failed ? '실패' : '통과'} — ${passed}개 통과${failed ? `, ${failed}개 실패` : ''} (${files.length}개 파일)`)
process.exit(failed ? 1 : 0)
