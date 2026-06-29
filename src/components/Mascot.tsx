import { useEffect, useRef } from 'react'

/**
 * 유휴(idle) 상태에서 등장하는 픽셀 판다 마스코트 (약 30초 시퀀스 반복).
 *  흑백 판다 혼자: 달리기 → 구르기 → 울기 → 자기(Zzz)
 *  → 갈색 판다 등장 → 가운데서 투닥(화난 눈썹) → 쫓고쫓기기 → 같이 폴짝(하트) → 양쪽 퇴장 → 반복
 *  pointer-events 없음 → 터미널 조작 방해 안 함. 외부 에셋 없이 코드 픽셀맵으로 렌더.
 */
interface MascotProps {
  active: boolean
}

interface Palette {
  dark: string
  body: string
  cheek: string
}
const PANDA_A: Palette = { dark: '#2b2b2b', body: '#f7f7f7', cheek: '#f5a9b8' }
const PANDA_B: Palette = { dark: '#7a5230', body: '#efe2c8', cheek: '#e8a0a0' }

// 머리 + 몸통 (16 x 14)
const HEAD = [
  '..BBB......BBB..',
  '.BBBBB....BBBBB.',
  '.BBBBB....BBBBB.',
  '..WWWWWWWWWWWW..',
  '.WWWWWWWWWWWWWW.',
  'WWWWWWWWWWWWWWWW',
  'WWBBBWWWWWWBBBWW',
  'WWBBBWWWWWWBBBWW',
  'WWWWWWWBBWWWWWWW',
  'WWPPWWWWWWWWPPWW',
  '.WWWWWWWWWWWWWW.',
  '.WWWWWWWWWWWWWW.',
  '..WWWWWWWWWWWW..',
  '...WWWWWWWWWW...',
]
const LEGS_A = ['...BB.....BB....', '...BB.....BB....']
const LEGS_B = ['..BB.......BB...', '..BB.......BB...']
const LEGS_SIT = ['.BBBB....BBBB...', '.BBBB....BBBB...']

const COLS = 16
const ROWS = 16
const PX = 4
const SPRITE_W = COLS * PX
const SPRITE_H = ROWS * PX

// 30초 시퀀스 단계 (이름 + 길이초)
const PHASES: { name: string; dur: number }[] = [
  { name: 'runabout', dur: 4 },
  { name: 'roll', dur: 3 },
  { name: 'cry', dur: 3.5 },
  { name: 'sleep', dur: 3.5 },
  { name: 'enter', dur: 3 },
  { name: 'fight', dur: 4 },
  { name: 'chase', dur: 4 },
  { name: 'play', dur: 2.5 },
  { name: 'leave', dur: 2.5 },
]
const SHOW_B = new Set(['enter', 'fight', 'chase', 'play', 'leave'])

interface DrawOpts {
  pal: Palette
  legs: string[]
  rotate: number
  squashX: number
  squashY: number
  bob: number
  crying: boolean
  angry: boolean
  blink: boolean
}
const baseOpts = (pal: Palette): DrawOpts => ({
  pal,
  legs: LEGS_A,
  rotate: 0,
  squashX: 1,
  squashY: 1,
  bob: 0,
  crying: false,
  angry: false,
  blink: false,
})

function paint(ctx: CanvasRenderingContext2D, rows: string[], offsetY: number, pal: Palette) {
  for (let y = 0; y < rows.length; y++) {
    const row = rows[y]
    for (let x = 0; x < row.length; x++) {
      const c = row[x]
      if (c === '.') continue
      ctx.fillStyle = c === 'B' ? pal.dark : c === 'P' ? pal.cheek : pal.body
      ctx.fillRect(x * PX, (y + offsetY) * PX, PX, PX)
    }
  }
}

function drawPanda(ctx: CanvasRenderingContext2D, x: number, baseY: number, o: DrawOpts, now: number) {
  ctx.save()
  const cx = x + SPRITE_W / 2
  const cy = baseY + SPRITE_H / 2 + o.bob
  ctx.translate(cx, cy)
  if (o.rotate) ctx.rotate(o.rotate)
  ctx.scale(o.squashX, o.squashY)
  ctx.translate(-SPRITE_W / 2, -SPRITE_H / 2)

  paint(ctx, HEAD, 0, o.pal)
  paint(ctx, o.legs, 14, o.pal)

  // 자는 중: 눈 감김(눈 칸에 가로줄) + 표시
  if (o.blink) {
    ctx.fillStyle = o.pal.body
    // 눈동자 영역을 몸통색으로 덮어 '감은 눈'처럼
    ctx.fillRect(2 * PX, 6 * PX, 3 * PX, 2 * PX)
    ctx.fillRect(11 * PX, 6 * PX, 3 * PX, 2 * PX)
    ctx.fillStyle = o.pal.dark
    ctx.fillRect(2 * PX, 7 * PX, 3 * PX, PX)
    ctx.fillRect(11 * PX, 7 * PX, 3 * PX, PX)
  }

  // 화난 눈썹 (안쪽 내려감)
  if (o.angry) {
    ctx.fillStyle = o.pal.dark
    for (const [bx, by] of [
      [2, 4],
      [3, 4],
      [4, 5],
      [13, 4],
      [12, 4],
      [11, 5],
    ]) {
      ctx.fillRect(bx * PX, by * PX, PX, PX)
    }
  }

  // 눈물
  if (o.crying) {
    ctx.fillStyle = '#7ec8ff'
    const ty = ((now / 1000) * 30) % 14
    ctx.fillRect(3 * PX, 8 * PX + ty, PX, PX)
    ctx.fillRect(12 * PX, 8 * PX + ((ty + 7) % 14), PX, PX)
  }
  ctx.restore()
}

export default function Mascot({ active }: MascotProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef = useRef<number>(0)
  const st = useRef({
    phase: 0,
    pt: 0,
    t: 0,
    a: { x: 12, dir: 1, roll: 1 },
    b: { x: -200, dir: -1 },
  })

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !active) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.imageSmoothingEnabled = false
    const parent = canvas.parentElement!

    st.current = {
      phase: 0,
      pt: 0,
      t: 0,
      a: { x: 12, dir: 1, roll: 1 },
      b: { x: -200, dir: -1 },
    }

    let last = performance.now()
    let running = true

    const frame = (now: number) => {
      if (!running) return
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      const s = st.current
      s.t += dt
      s.pt += dt

      const W = parent.clientWidth
      const H = parent.clientHeight
      if (canvas.width !== W || canvas.height !== H) {
        canvas.width = W
        canvas.height = H
        ctx.imageSmoothingEnabled = false
      }
      const maxX = Math.max(0, W - SPRITE_W)
      const baseY = H - SPRITE_H - 10
      const aTarget = W / 2 - SPRITE_W - 2
      const bTarget = W / 2 + 2
      const a = s.a
      const b = s.b

      // 단계 전환 + 진입 셋업
      if (s.pt > PHASES[s.phase].dur) {
        s.phase = (s.phase + 1) % PHASES.length
        s.pt = 0
        const name = PHASES[s.phase].name
        if (name === 'runabout') {
          a.x = 12
          a.dir = 1
          b.x = -200
        } else if (name === 'roll') {
          a.roll = a.x > maxX / 2 ? -1 : 1
        } else if (name === 'enter') {
          b.x = maxX
        } else if (name === 'fight') {
          a.x = aTarget
          b.x = bTarget
        } else if (name === 'chase') {
          a.x = maxX * 0.7
          a.dir = -1
        } else if (name === 'play') {
          a.x = aTarget
          b.x = bTarget
        } else if (name === 'leave') {
          a.dir = -1
          b.dir = 1
        }
      }

      const phase = PHASES[s.phase].name
      const aO = baseOpts(PANDA_A)
      const bO = baseOpts(PANDA_B)
      const showB = SHOW_B.has(phase)
      const runLegs = (off = 0) => (Math.floor(s.t * 8 + off) % 2 === 0 ? LEGS_A : LEGS_B)
      const overlays: { x: number; y: number; word: string; color: string }[] = []

      if (phase === 'runabout') {
        a.x += a.dir * 70 * dt
        if (a.x <= 0) {
          a.x = 0
          a.dir = 1
        } else if (a.x >= maxX) {
          a.x = maxX
          a.dir = -1
        }
        aO.legs = runLegs()
        aO.bob = Math.abs(Math.sin(s.t * 8)) * -3
      } else if (phase === 'roll') {
        a.x += a.roll * 95 * dt
        if (a.x <= 0) {
          a.x = 0
          a.roll = 1
        } else if (a.x >= maxX) {
          a.x = maxX
          a.roll = -1
        }
        aO.rotate = a.roll * s.t * 9
      } else if (phase === 'cry') {
        if (s.pt < 0.4) {
          const k = s.pt / 0.4
          aO.squashX = 1 - 0.25 * Math.sin(k * Math.PI)
          aO.squashY = 1 + 0.25 * Math.sin(k * Math.PI)
        } else {
          aO.legs = LEGS_SIT
          aO.crying = true
          aO.bob = Math.sin(s.t * 6) * 1.5
        }
      } else if (phase === 'sleep') {
        aO.legs = LEGS_SIT
        aO.blink = true
        aO.bob = Math.sin(s.t * 2) * 1.2
        overlays.push({ x: a.x + SPRITE_W, y: baseY, word: 'Z z z', color: '#9fb6ff' })
      } else if (phase === 'enter') {
        const move = (cur: number, target: number) => {
          const d = target - cur
          const step = 90 * dt
          return Math.abs(d) <= step ? target : cur + Math.sign(d) * step
        }
        a.x = move(a.x, aTarget)
        b.x = move(b.x, bTarget)
        aO.legs = runLegs()
        bO.legs = runLegs(1)
        aO.bob = Math.abs(Math.sin(s.t * 8)) * -3
        bO.bob = Math.abs(Math.sin(s.t * 8 + 1)) * -3
      } else if (phase === 'fight') {
        const lunge = Math.max(0, Math.sin(s.t * 13)) * 6
        a.x = aTarget + lunge
        b.x = bTarget - lunge
        aO.angry = bO.angry = true
        aO.bob = bO.bob = Math.sin(s.t * 22) * 1.2
        if (lunge > 4) {
          overlays.push({
            x: W / 2,
            y: baseY - 2,
            word: Math.floor(s.t * 6) % 2 === 0 ? '퍽!' : '툭!',
            color: '#ffec99',
          })
        }
      } else if (phase === 'chase') {
        a.x += a.dir * 110 * dt
        if (a.x <= 0) {
          a.x = 0
          a.dir = 1
        } else if (a.x >= maxX) {
          a.x = maxX
          a.dir = -1
        }
        b.x = Math.max(0, Math.min(maxX, a.x - a.dir * (SPRITE_W + 10)))
        aO.legs = runLegs()
        bO.legs = runLegs(1)
        aO.bob = Math.abs(Math.sin(s.t * 12)) * -4
        bO.bob = Math.abs(Math.sin(s.t * 12 + 1)) * -4
        bO.angry = true
        overlays.push({ x: a.x + SPRITE_W / 2, y: baseY - 2, word: '!', color: '#ffd54a' })
      } else if (phase === 'play') {
        a.x = aTarget
        b.x = bTarget
        aO.bob = -Math.abs(Math.sin(s.t * 6)) * 7
        bO.bob = -Math.abs(Math.sin(s.t * 6 + Math.PI)) * 7
        overlays.push({ x: W / 2, y: baseY - 4, word: '♥', color: '#ff9ec4' })
      } else if (phase === 'leave') {
        a.x -= 130 * dt
        b.x += 130 * dt
        aO.legs = runLegs()
        bO.legs = runLegs(1)
        aO.bob = Math.abs(Math.sin(s.t * 10)) * -3
        bO.bob = Math.abs(Math.sin(s.t * 10 + 1)) * -3
      }

      ctx.clearRect(0, 0, W, H)
      drawPanda(ctx, a.x, baseY, aO, now)
      if (showB) drawPanda(ctx, b.x, baseY, bO, now)
      for (const ov of overlays) {
        ctx.font = 'bold 13px monospace'
        ctx.fillStyle = ov.color
        ctx.fillText(ov.word, ov.x - 8, ov.y)
      }

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
