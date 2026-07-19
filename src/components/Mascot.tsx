import { useEffect, useRef } from 'react'
import pandaSheetUrl from '../assets/panda3.png'

/**
 * 유휴(idle) 상태에서 등장하는 판다 마스코트. 실제 픽셀 아트 이미지(panda3.png, 스프라이트 시트)에서
 * 자세별로 잘라 그림. 혼자 [걷기/구르기/울기/자기/대나무먹기/오르기/공놀이] 중 랜덤 순서로 가볍게 순환.
 * 터미널 클릭/접속 끊김 등 실제 이벤트가 오면(active 상태일 때만) 잠깐 놀람/슬픔 리액션 재생 후 원래 루프로 복귀.
 * 페이즈가 바뀔 때마다 짧게 스쿼시-핀치 전환을 넣어 컷이 튀지 않고 이어지는 느낌을 줌.
 * pointer-events 없음 → 터미널 조작 방해 안 함.
 */
export type MascotReaction = { type: 'surprised' | 'sad'; nonce: number }

interface MascotProps {
  active: boolean
  /** 터미널 클릭/접속끊김 등에서 오는 일회성 리액션 트리거. active 일 때만 반영됨 */
  reaction?: MascotReaction | null
}

// 스프라이트가 있는 위치(원본 이미지 픽셀 좌표) — panda3.png(가이드선 없는 클린 버전) 기준으로
// 각 자세를 잘라 임시 PNG로 저장 후 육안으로 잘림/여백을 확인해가며 좌표를 잡음.
type PoseKey = 'walk' | 'wave' | 'run' | 'crawl' | 'eatBamboo' | 'sit' | 'climb' | 'sleepReal' | 'ballPlay'
const SPRITE_RECTS: Record<PoseKey, { sx: number; sy: number; sw: number; sh: number }> = {
  walk: { sx: 15, sy: 39, sw: 200, sh: 131 }, // 흑백, 걷는 옆모습
  wave: { sx: 275, sy: 42, sw: 165, sh: 133 }, // 흑백, 점프+손흔들기(놀람 리액션용)
  run: { sx: 475, sy: 42, sw: 190, sh: 128 }, // 흑백, 달리는 옆모습
  crawl: { sx: 715, sy: 50, sw: 210, sh: 125 }, // 흑백, 낮은 자세(구르기용)
  eatBamboo: { sx: 510, sy: 165, sw: 180, sh: 150 }, // 갈색, 앉아서 대나무 먹기
  sit: { sx: 760, sy: 175, sw: 170, sh: 145 }, // 갈색, 정면 앉은 기본자세
  climb: { sx: 20, sy: 320, sw: 140, sh: 105 }, // 흑백, 대나무 타고 오르기
  sleepReal: { sx: 740, sy: 305, sw: 200, sh: 135 }, // 갈색, 옆으로 누워 자는 자세
  ballPlay: { sx: 20, sy: 455, sw: 150, sh: 120 }, // 흑백, 공 차기
}

// 모든 자세의 "실제 캐릭터 크기"(크롭 여백 제외)를 이 박스에 맞춰 정규화 — 자세마다 크롭 여백이
// 달라 크기가 들쭉날쭉해 보이던 문제를, 원본 크롭 크기가 아니라 실제 차지하는 영역 기준으로 통일.
// 높이만 맞추면 기어가기/누워자기처럼 납작하고 가로로 넓은 자세는 높이가 낮은 만큼 배율이 커져
// 오히려 가로로 훨씬 커 보이는 문제가 있어, 가로 폭도 함께 상한을 둬서 둘 중 더 작은 배율을 사용.
const CHAR_H = 100
const CHAR_MAX_W = 130
// 배치용 무대 가로 폭(걷기 이동 범위 계산용) — 세로 크기는 CHAR_H로 정규화되므로 무관
const STAGE_W = 100

// 말풍선 기호는 폰트 대신 픽셀로 직접 그림 (폰트는 그리드에 안 맞아 뭉툭해 보임) — 작고 또렷하게
const PX = 4
const EXCLAIM = ['.B.', '.B.', '.B.', '...', '.B.']
const GLYPH_COLORS = {
  exclaim: { B: '#ffe066' },
}
function paintGlyph(
  ctx: CanvasRenderingContext2D,
  rows: string[],
  colors: Record<string, string>,
  cx: number,
  topY: number,
) {
  const w = rows[0]?.length ?? 0
  const ox = Math.round(cx - (w * PX) / 2)
  const oy = Math.round(topY)
  for (let y = 0; y < rows.length; y++) {
    const row = rows[y]
    for (let x = 0; x < row.length; x++) {
      const color = colors[row[x]]
      if (!color) continue
      ctx.fillStyle = color
      ctx.fillRect(ox + x * PX, oy + y * PX, PX, PX)
    }
  }
}

type SoloName = 'walk' | 'crawl' | 'cry' | 'sleep' | 'bamboo' | 'climb' | 'ballPlay'
type ReactName = 'surprised' | 'sad'

// 혼자 구간 후보 풀 — 매 루프 시작 시 랜덤 순서로 섞어 가볍게 순환.
// 제자리 동작(walk/crawl 제외)들은 시작할 때 화면 여기저기의 새 지점으로 먼저 걸어간 뒤 자세를
// 취하므로, 그 이동 시간까지 감안해 기존보다 조금 넉넉하게 잡음.
const SOLO_POOL: { name: SoloName; dur: number }[] = [
  { name: 'walk', dur: 4 },
  { name: 'crawl', dur: 3 },
  { name: 'cry', dur: 5.2 },
  { name: 'sleep', dur: 5.2 },
  { name: 'bamboo', dur: 5.6 },
  { name: 'climb', dur: 5.2 },
  { name: 'ballPlay', dur: 5.2 },
]
const REACT_DUR: Record<ReactName, number> = { surprised: 1.2, sad: 3 }
// 페이즈/리액션이 바뀔 때 짧게 눌렸다 펴지는 전환 길이(초) — 컷이 뚝뚝 끊기지 않도록
const BLEND_DUR = 0.22

// 제자리에서만 자세가 바뀌면 밋밋해 보여서, 이 자세들은 시작할 때 화면의 다른 지점으로
// 걸어간 뒤 그 자리에서 동작하게 함 — "여기저기서 노는" 느낌을 줌
const STATIONARY = new Set<SoloName>(['cry', 'sleep', 'bamboo', 'climb', 'ballPlay'])
const MOVE_SPEED = 130 // 새 지점으로 이동할 때 속도(px/s) — 걷기 페이즈보다 조금 빠르게

/** 현재 위치에서 120~300px 떨어진, 화면 범위 안의 새 지점을 고름(항상 눈에 띄게 이동하도록) */
function pickMoveTarget(cur: number, maxX: number): number {
  const dist = 120 + Math.random() * 180
  let dir: 1 | -1 = Math.random() < 0.5 ? -1 : 1
  if (cur + dir * dist < 0 || cur + dir * dist > maxX) dir = (-dir) as 1 | -1
  return Math.max(0, Math.min(maxX, cur + dir * dist))
}

/** 목표 지점을 향해 걷는 자세/이동 적용. 도착하면 false, 이동 중이면 true 반환 */
function driveWalkTo(aO: DrawOpts, a: { x: number }, dt: number, target: number, tGlobal: number): boolean {
  const d = target - a.x
  const step = MOVE_SPEED * dt
  aO.pose = 'walk'
  aO.facing = d >= 0 ? 1 : -1
  aO.bob = Math.abs(Math.sin(tGlobal * 8)) * -3
  aO.squashX = 1 + Math.sin(tGlobal * 16) * 0.04
  aO.squashY = 1 - Math.sin(tGlobal * 16) * 0.04
  if (Math.abs(d) <= step) {
    a.x = target
    return false
  }
  a.x += Math.sign(d) * step
  return true
}

function shuffledSolo(): { name: SoloName; dur: number }[] {
  const arr = [...SOLO_POOL]
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}
const buildPhases = () => shuffledSolo()
const smoothstep = (p: number) => p * p * (3 - 2 * p)

interface DrawOpts {
  pose: PoseKey
  facing: 1 | -1
  rotate: number
  squashX: number
  squashY: number
  bob: number
  crying: boolean
}
const baseOpts = (pose: PoseKey): DrawOpts => ({
  pose,
  facing: 1,
  rotate: 0,
  squashX: 1,
  squashY: 1,
  bob: 0,
  crying: false,
})

interface PreparedSprite {
  canvas: HTMLCanvasElement
  // 배경을 지운 뒤 실제로 불투명 픽셀이 남아있는 영역(크롭 여백 제외) — 크기 정규화 기준
  bbox: { x: number; y: number; w: number; h: number }
}

// 스프라이트 시트는 사각형 배경째로 잘려있어, 두 캐릭터가 겹치면 뒤에 그려진 쪽의
// 사각 배경이 앞쪽을 가려 "깨진" 것처럼 보임 → 자세별로 한 번만 배경을 투명 처리(누끼)해
// 오프스크린 캔버스에 캐시해두고, 매 프레임은 이미 알파가 뚫린 캐시본만 그린다.
// 테두리에서 가장 자주 나온 색 몇 가지(배경 + 자세 경계를 표시하던 가이드 회색선 등)를 후보로 모음
function estimateBgColors(data: Uint8ClampedArray, w: number, h: number, topK = 4): [number, number, number][] {
  const counts = new Map<string, { c: [number, number, number]; n: number }>()
  const consider = (x: number, y: number) => {
    const i = (y * w + x) * 4
    // 약간의 압축 노이즈를 흡수하도록 3비트 단위로 양자화한 값을 버킷 키로 사용
    const key = `${data[i] >> 3},${data[i + 1] >> 3},${data[i + 2] >> 3}`
    const cur = counts.get(key)
    if (cur) cur.n++
    else counts.set(key, { c: [data[i], data[i + 1], data[i + 2]], n: 1 })
  }
  for (let x = 0; x < w; x++) { consider(x, 0); consider(x, h - 1) }
  for (let y = 0; y < h; y++) { consider(0, y); consider(w - 1, y) }
  const sorted = [...counts.values()].sort((a, b) => b.n - a.n)
  const top = sorted.slice(0, topK).map((v) => v.c)
  return top.length ? top : [[30, 30, 45]]
}
// 테두리에서 시작해 "배경/가이드선과 색이 비슷한" 픽셀만 연결된 영역을 따라 투명 처리(플러드필).
// 단순 색-거리 비교와 달리, 캐릭터 내부에 우연히 배경과 비슷한 어두운 색이 있어도 테두리와
// 연결되어 있지 않으면 지워지지 않아 안전 — 자세 경계를 표시하던 네모난 가이드선도 배경에
// 인접해 있어 이 방식으로 함께 제거됨.
function chromaKeyCrop(img: HTMLImageElement, sx: number, sy: number, sw: number, sh: number): PreparedSprite {
  const out = document.createElement('canvas')
  out.width = sw
  out.height = sh
  const octx = out.getContext('2d')!
  octx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh)
  const imgData = octx.getImageData(0, 0, sw, sh)
  const d = imgData.data
  const swatches = estimateBgColors(d, sw, sh)
  const TOL = 42
  const isBgLike = (i: number) => {
    for (const [br, bg, bb] of swatches) {
      const dr = d[i] - br
      const dg = d[i + 1] - bg
      const db = d[i + 2] - bb
      if (Math.sqrt(dr * dr + dg * dg + db * db) <= TOL) return true
    }
    return false
  }
  const w = sw
  const h = sh
  const visited = new Uint8Array(w * h)
  const stack: number[] = []
  for (let x = 0; x < w; x++) { stack.push(x, (h - 1) * w + x) }
  for (let y = 0; y < h; y++) { stack.push(y * w, y * w + w - 1) }
  while (stack.length) {
    const p = stack.pop()!
    if (visited[p]) continue
    const i = p * 4
    if (!isBgLike(i)) continue
    visited[p] = 1
    d[i + 3] = 0
    const px = p % w
    const py = (p - px) / w
    if (px > 0) stack.push(p - 1)
    if (px < w - 1) stack.push(p + 1)
    if (py > 0) stack.push(p - w)
    if (py < h - 1) stack.push(p + w)
  }
  octx.putImageData(imgData, 0, 0)
  // 실제 남은(불투명) 픽셀의 바운딩 박스 계산 — 자세별로 크롭 여백이 달라 보이던 크기 차이를
  // 크롭 크기가 아니라 "실제 캐릭터가 차지하는 영역" 기준으로 정규화하기 위함
  let minX = w
  let minY = h
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] > 0) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  const bbox = maxX >= minX ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } : { x: 0, y: 0, w, h }
  return { canvas: out, bbox }
}
function prepareSprites(img: HTMLImageElement): Partial<Record<PoseKey, PreparedSprite>> {
  const prepared: Partial<Record<PoseKey, PreparedSprite>> = {}
  for (const key of Object.keys(SPRITE_RECTS) as PoseKey[]) {
    const rect = SPRITE_RECTS[key]
    prepared[key] = chromaKeyCrop(img, rect.sx, rect.sy, rect.sw, rect.sh)
  }
  return prepared
}

function drawSprite(
  ctx: CanvasRenderingContext2D,
  prepared: Partial<Record<PoseKey, PreparedSprite>>,
  x: number,
  groundY: number,
  o: DrawOpts,
) {
  const sprite = prepared[o.pose]
  if (!sprite) return
  const { canvas, bbox } = sprite
  // bbox를 CHAR_H x CHAR_MAX_W 박스 안에 맞추는 배율 — 높이만 맞추면 납작하고 넓은 자세가
  // 상대적으로 훨씬 커 보이므로, 높이/폭 배율 중 더 작은 쪽을 사용해 둘 다 박스 안에 들어오게 함
  const scale = Math.min(CHAR_H / bbox.h, CHAR_MAX_W / bbox.w)
  const dw = canvas.width * scale
  const dh = canvas.height * scale
  const cx = x + STAGE_W / 2
  const cy = groundY + o.bob
  ctx.save()
  ctx.translate(cx, cy)
  if (o.rotate) ctx.rotate(o.rotate)
  ctx.scale(o.squashX * o.facing, o.squashY)
  // bbox 바닥이 groundY(0)에, bbox 가로 중심이 x 중심(0)에 오도록 캔버스 전체를 배치
  const drawX = -(bbox.x + bbox.w / 2) * scale
  const drawY = -(bbox.y + bbox.h) * scale
  ctx.drawImage(canvas, drawX, drawY, dw, dh)
  // 눈물 (팔레트 무관 — 대충 얼굴 중앙 아래쯤에 떨어뜨림, 정확한 눈 위치는 이미지마다 달라 근사치)
  if (o.crying) {
    ctx.fillStyle = '#7ec8ff'
    const ty = ((performance.now() / 1000) * 30) % (CHAR_H * 0.4)
    ctx.fillRect(-CHAR_H * 0.16, -CHAR_H * 0.5 + ty, 5, 5)
    ctx.fillRect(CHAR_H * 0.08, -CHAR_H * 0.45 + ((ty + CHAR_H * 0.2) % (CHAR_H * 0.4)), 5, 5)
  }
  ctx.restore()
}

export default function Mascot({ active, reaction }: MascotProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef = useRef<number>(0)
  const reactionRef = useRef<MascotReaction | null | undefined>(reaction)
  const preparedRef = useRef<Partial<Record<PoseKey, PreparedSprite>>>({})
  const st = useRef({
    phases: buildPhases(),
    phase: 0,
    pt: 0,
    t: 0,
    a: { x: 12, dir: 1 as 1 | -1, roll: 1 },
    override: null as { type: ReactName; t: number } | null,
    lastReactionNonce: 0,
    blendT: BLEND_DUR,
    // 제자리 동작 전 새 지점으로 이동하는 상태 — phaseInitialized 는 페이즈가 바뀔 때마다 리셋되어
    // (첫 페이즈 포함) 목표 지점을 한 번만 새로 뽑도록 함
    phaseInitialized: false,
    moveTarget: 0,
    arrived: true,
    settleT: 0,
  })

  useEffect(() => {
    reactionRef.current = reaction
  }, [reaction])

  // 스프라이트 이미지는 한 번만 로드해 재사용. 로드되면 자세별로 배경을 누끼 처리해
  // 오프스크린 캐시를 만들어둠 (매 프레임 다시 처리하지 않도록)
  useEffect(() => {
    const img = new Image()
    img.onload = () => {
      preparedRef.current = prepareSprites(img)
    }
    img.src = pandaSheetUrl
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !active) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const parent = canvas.parentElement!

    st.current = {
      phases: buildPhases(),
      phase: 0,
      pt: 0,
      t: 0,
      a: { x: 12, dir: 1, roll: 1 },
      override: null,
      // 지금 막 등장한 시점 이전의 리액션은 무시 — 이후 새로 오는 것만 재생
      lastReactionNonce: reactionRef.current?.nonce ?? 0,
      blendT: BLEND_DUR,
      phaseInitialized: false,
      moveTarget: 0,
      arrived: true,
      settleT: 0,
    }

    let last = performance.now()
    let running = true

    const frame = (now: number) => {
      if (!running) return
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      const s = st.current
      const prepared = preparedRef.current

      const W = parent.clientWidth
      const H = parent.clientHeight
      if (canvas.width !== W || canvas.height !== H) {
        canvas.width = W
        canvas.height = H
      }
      const maxX = Math.max(0, W - STAGE_W)
      const groundY = H - 10
      const a = s.a

      // 새 리액션 트리거 감지 (놀람/슬픔) — active 일 때만 이 루프가 돌므로 자동으로 "사용 안 할 때만" 충족
      const rx = reactionRef.current
      if (rx && rx.nonce !== s.lastReactionNonce) {
        s.lastReactionNonce = rx.nonce
        s.override = { type: rx.type, t: 0 }
        s.blendT = 0
      }

      const aO = baseOpts('walk')
      const glyphs: { rows: string[]; colors: Record<string, string>; cx: number; topY: number }[] = []

      if (s.override) {
        s.override.t += dt
        const dur = REACT_DUR[s.override.type]
        if (s.override.t >= dur) {
          s.override = null
          s.blendT = 0
        }
      }

      if (s.override) {
        const k = s.override.t / REACT_DUR[s.override.type]
        if (s.override.type === 'surprised') {
          aO.pose = 'wave'
          if (k < 0.15) {
            const p = k / 0.15
            aO.squashY = 1 - 0.25 * p
            aO.squashX = 1 + 0.15 * p
          } else if (k < 0.55) {
            const p = (k - 0.15) / 0.4
            aO.bob = -Math.sin(p * Math.PI) * 14
            aO.squashY = 1 + 0.15 * Math.sin(p * Math.PI)
            aO.squashX = 1 - 0.08 * Math.sin(p * Math.PI)
          } else if (k < 0.7) {
            const p = (k - 0.55) / 0.15
            aO.squashY = 1 - 0.3 * (1 - p)
            aO.squashX = 1 + 0.2 * (1 - p)
          }
          glyphs.push({ rows: EXCLAIM, colors: GLYPH_COLORS.exclaim, cx: a.x + STAGE_W / 2, topY: groundY - CHAR_H - 22 })
        } else {
          aO.pose = 'sit'
          aO.crying = true
          aO.bob = Math.sin(s.t * 1.5) * 1
          aO.rotate = -0.05
        }
      } else {
        // 정상 진행 (오버라이드 없을 때만 시퀀스 타이머 진행)
        s.t += dt
        s.pt += dt

        if (s.pt > s.phases[s.phase].dur) {
          s.phase += 1
          s.pt = 0
          s.blendT = 0
          s.phaseInitialized = false
          if (s.phase >= s.phases.length) {
            s.phases = buildPhases()
            s.phase = 0
          }
        }

        const phase = s.phases[s.phase].name

        // 페이즈가 막 시작됐을 때 한 번만: 제자리 동작이면 새로 걸어갈 지점을 뽑아둠
        if (!s.phaseInitialized) {
          s.phaseInitialized = true
          if (STATIONARY.has(phase)) {
            s.moveTarget = pickMoveTarget(a.x, maxX)
            s.arrived = false
            s.settleT = 0
          }
        }

        if (phase === 'walk') {
          a.x += a.dir * 70 * dt
          if (a.x <= 0) { a.x = 0; a.dir = 1 } else if (a.x >= maxX) { a.x = maxX; a.dir = -1 }
          aO.pose = 'walk'
          aO.facing = a.dir
          aO.bob = Math.abs(Math.sin(s.t * 8)) * -3
          aO.squashX = 1 + Math.sin(s.t * 16) * 0.04
          aO.squashY = 1 - Math.sin(s.t * 16) * 0.04
        } else if (phase === 'crawl') {
          a.x += a.roll * 60 * dt
          if (a.x <= 0) { a.x = 0; a.roll = 1 } else if (a.x >= maxX) { a.x = maxX; a.roll = -1 }
          aO.pose = 'crawl'
          aO.facing = a.roll as 1 | -1
          aO.bob = Math.abs(Math.sin(s.t * 5)) * -2
        } else if (phase === 'cry') {
          if (!s.arrived) {
            if (!driveWalkTo(aO, a, dt, s.moveTarget, s.t)) {
              s.arrived = true
              s.blendT = 0 // 도착한 순간 자세로 바뀌므로, 그때 눌렸다 펴지는 착지 연출이 오도록 리셋
            }
          } else {
            s.settleT += dt
            aO.pose = 'sit'
            if (s.settleT < 0.4) {
              const k = s.settleT / 0.4
              aO.squashX = 1 - 0.25 * Math.sin(k * Math.PI)
              aO.squashY = 1 + 0.25 * Math.sin(k * Math.PI)
            } else {
              aO.crying = true
              aO.bob = Math.sin(s.t * 6) * 1.5
              aO.squashY = 1 + Math.sin(s.t * 6) * 0.03
              aO.squashX = 1 - Math.sin(s.t * 6) * 0.03
            }
          }
        } else if (phase === 'sleep') {
          if (!s.arrived) {
            if (!driveWalkTo(aO, a, dt, s.moveTarget, s.t)) {
              s.arrived = true
              s.blendT = 0 // 도착한 순간 자세로 바뀌므로, 그때 눌렸다 펴지는 착지 연출이 오도록 리셋
            }
          } else {
            aO.pose = 'sleepReal'
            aO.bob = Math.sin(s.t * 2) * 1.2
            aO.squashY = 1 + Math.sin(s.t * 2) * 0.04
            aO.squashX = 1 - Math.sin(s.t * 2) * 0.04
            glyphs.push({
              rows: ['.B...', 'BB...', '.B...', '..B..', '..BB.', '..B..', '...B.', '...BB', '...B.'],
              colors: { B: '#9fb6ff' },
              cx: a.x + STAGE_W + 10,
              topY: groundY - CHAR_H - 4,
            })
          }
        } else if (phase === 'bamboo') {
          if (!s.arrived) {
            if (!driveWalkTo(aO, a, dt, s.moveTarget, s.t)) {
              s.arrived = true
              s.blendT = 0 // 도착한 순간 자세로 바뀌므로, 그때 눌렸다 펴지는 착지 연출이 오도록 리셋
            }
          } else {
            aO.pose = 'eatBamboo'
            aO.bob = Math.abs(Math.sin(s.t * 5)) * -1.5
          }
        } else if (phase === 'climb') {
          if (!s.arrived) {
            if (!driveWalkTo(aO, a, dt, s.moveTarget, s.t)) {
              s.arrived = true
              s.blendT = 0 // 도착한 순간 자세로 바뀌므로, 그때 눌렸다 펴지는 착지 연출이 오도록 리셋
            }
          } else {
            aO.pose = 'climb'
            aO.bob = Math.abs(Math.sin(s.t * 3)) * -2
          }
        } else if (phase === 'ballPlay') {
          if (!s.arrived) {
            if (!driveWalkTo(aO, a, dt, s.moveTarget, s.t)) {
              s.arrived = true
              s.blendT = 0 // 도착한 순간 자세로 바뀌므로, 그때 눌렸다 펴지는 착지 연출이 오도록 리셋
            }
          } else {
            aO.pose = 'ballPlay'
            aO.bob = Math.abs(Math.sin(s.t * 7)) * -3
            aO.squashX = 1 + Math.sin(s.t * 14) * 0.06
            aO.squashY = 1 - Math.sin(s.t * 14) * 0.06
          }
        }
      }

      // 페이즈/리액션 전환 직후 짧게 눌렸다 펴지는 핀치 — 자세가 순간 바뀌어도 컷처럼 안 느껴지게 함
      const pinch = Math.max(0, 1 - s.blendT / BLEND_DUR)
      s.blendT += dt
      if (pinch > 0) {
        const ease = smoothstep(1 - pinch)
        aO.squashY *= 0.35 + 0.65 * ease
        aO.squashX *= 1 + (1 - ease) * 0.25
      }

      ctx.clearRect(0, 0, W, H)
      drawSprite(ctx, prepared, a.x, groundY, aO)
      for (const g of glyphs) paintGlyph(ctx, g.rows, g.colors, g.cx, g.topY)

      rafRef.current = requestAnimationFrame(frame)
    }

    rafRef.current = requestAnimationFrame(frame)
    return () => {
      running = false
      cancelAnimationFrame(rafRef.current)
    }
  }, [active])

  if (!active) return null
  return <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 z-40" aria-hidden />
}
