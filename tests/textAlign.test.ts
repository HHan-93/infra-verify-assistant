// 증적 원문 — 탭 표 정렬(한글 2칸), 탭 없는 줄은 그대로
import { test, eq } from './harness'
import { alignTabBlocks } from '../src/lib/textAlign'

test('연속한 탭 줄을 한 표로 맞춘다', () =>
  eq(alignTabBlocks(['# 제목', 'NAME\tREADY(전환)\tN', 'valkey-0\t-\t0', '', 'a\tb']), ['# 제목', 'NAME      READY(전환)  N', 'valkey-0  -            0', '', 'a  b']))
