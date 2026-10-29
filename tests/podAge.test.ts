// kubectl AGE 칸 읽기 — 상태보드 파드 표의 '새 파드' 표시
import { test, eq } from './harness'
import { parseKubeAge } from '../src/lib/podStatus'

test('여러 단위를 더한다', () => {
  eq([parseKubeAge('45s'), parseKubeAge('5m30s'), parseKubeAge('3h20m'), parseKubeAge('6d5h')], [45_000, 330_000, 12_000_000, 536_400_000])
})
test('읽을 수 없으면 null', () => {
  eq([parseKubeAge('<invalid>'), parseKubeAge(''), parseKubeAge(undefined), parseKubeAge('10.0.0.1')], [null, null, null, null])
})
