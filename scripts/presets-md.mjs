#!/usr/bin/env node
/**
 * 단일 명령어 프리셋을 **마크다운 ↔ src/presets.ts** 로 오간다.
 *
 * ── 왜 만들었나
 * `명령어_편집.md`(예전에 사람이 고치던 원본)와 `src/presets.ts`(앱이 읽는 것) 두 벌이 있는데
 * 생성 스크립트가 없어 서로 어긋나 있었다 — presets.ts 에만 있는 명령이 여럿이었다.
 * 어느 쪽을 고쳐야 하는지 알 수 없는 상태였으므로, 오갈 수 있게 만들어 둔다.
 *
 *   node scripts/presets-md.mjs to-md   # presets.ts → 명령어_프리셋.md (지금 앱 기준으로 다시 씀)
 *   node scripts/presets-md.mjs to-ts   # 명령어_프리셋.md → presets.ts (md 에서 고친 것을 앱에 반영)
 *   node scripts/presets-md.mjs check   # 둘이 같은지만 확인 (고치지 않음)
 *
 * ── 형식을 왜 이렇게 두나
 * 기존 md 형식(`* 명령어 : …` / `* 라벨 : …` / `* 설명 : …`)을 그대로 유지한다. 이미
 * 그 형식으로 적혀 있고, 명령을 한 줄로 보는 편이 붙여넣기에도 좋다. 설명은 여러 줄이
 * 흔해서(412곳) **더 들여쓴 다음 줄**을 이어지는 설명으로 읽는다.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TS = path.join(ROOT, 'src', 'presets.ts')
/**
 * 앱이 실제로 보여주는 목록을 담는 파일.
 *
 * 예전 `명령어_편집.md` 를 그대로 쓰지 않는다 — 둘은 **양쪽으로** 어긋나 있었다.
 * presets.ts 에만 있는 명령이 있고(예: VM 상태 강제 변경), 그 md 에만 있는 명령도 57개
 * 있었다(fio·LVM·netplan·ip link 등). 한쪽으로 덮어쓰면 어느 쪽이든 사라지므로, 앱 기준의
 * 새 파일을 원본으로 세우고 예전 파일은 손대지 않고 남겨 둔다.
 */
const MD = path.join(ROOT, '명령어_프리셋.md')

const MD_HEADER = `# 단일 명령어 프리셋

**이 파일이 원본입니다.** 여기서 고치고 \`npm run presets:ts\` 를 돌리면 \`src/presets.ts\`
(앱이 읽는 파일)에 반영됩니다. 반대로 \`npm run presets:md\` 는 현재 앱 내용을 이 파일로
다시 씁니다. 둘이 어긋났는지는 \`npm run presets:check\` 로 확인합니다.

## 형식

\`\`\`
* 솔루션 이름
  * 하위분류 이름
    * 명령어 : 실제로 실행할 한 줄
      * 라벨 : 화면에 보이는 이름
      * 설명 : 한 줄 설명
        여러 줄이면 이렇게 더 들여쓴 줄을 이어서 적습니다
    * 안내
      * 라벨 : 실행하지 않는 안내 항목(버튼 없이 글로만 표시)
      * 설명 : 안내 내용
\`\`\`

- 명령 안의 \`<대문자>\` 는 **앱이 실행 전에 값을 물어보는 자리**입니다 (예: \`<SERVER_ID>\`).
  문자·숫자·\`_\`·\`.\`·\`-\` 만 자리 이름으로 인정합니다 — 셸 리다이렉션 \`>\` 을 잘못 잡지 않기 위해서입니다.
- 순서가 그대로 화면 순서가 됩니다.
- 사용자가 앱에서 직접 추가한 명령은 여기 없습니다 — 그것은 각자 PC 의 \`custom-presets.json\` 에 따로 저장됩니다.

`

// ── presets.ts 읽기 ────────────────────────────────────────
// 배열 부분만 떼어 낸다. 그 안은 전부 큰따옴표 JSON 이라 그대로 파싱된다
// (그렇게 유지하는 것이 이 파일의 규칙이다 — to-ts 도 같은 모양으로 다시 쓴다).
function readTs() {
  const text = readFileSync(TS, 'utf-8')
  const marker = 'export const PRESETS: PresetGroup[] = '
  const i = text.indexOf(marker)
  if (i < 0) throw new Error('presets.ts 에서 PRESETS 선언을 찾지 못했습니다.')
  const start = i + marker.length
  const body = text.slice(start).trimEnd().replace(/;?$/, '')
  return { head: text.slice(0, start), groups: JSON.parse(body) }
}

function writeTs(groups) {
  const { head } = readTs()
  writeFileSync(TS, head + JSON.stringify(groups, null, 2) + '\n', 'utf-8')
}

// ── 마크다운 쓰기 ──────────────────────────────────────────
function toMd(groups) {
  const out = [MD_HEADER]
  for (const g of groups) {
    out.push(`* ${g.solution}`)
    for (const sub of g.subgroups) {
      out.push(`  * ${sub.name}`)
      for (const c of sub.commands) {
        out.push(c.info || !c.command ? '    * 안내' : `    * 명령어 : ${c.command}`)
        out.push(`      * 라벨 : ${c.label}`)
        const lines = String(c.desc ?? '').split('\n')
        out.push(`      * 설명 : ${lines[0]}`)
        for (const extra of lines.slice(1)) out.push(`        ${extra}`)
      }
    }
    out.push('')
  }
  return out.join('\n').replace(/\n+$/, '\n')
}

// ── 마크다운 읽기 ──────────────────────────────────────────
function fromMd(md) {
  const groups = []
  let sub = null
  let cur = null
  let fenced = false
  const lines = md.split(/\r*\n/)
  for (const raw of lines) {
    if (/^\s*```/.test(raw)) {
      fenced = !fenced
      continue
    }
    if (fenced) continue
    if (!raw.trim()) continue

    const m = /^(\s*)\* (.*)$/.exec(raw)
    if (!m) {
      // 들여쓴 이어지는 줄 = 설명의 다음 줄
      if (cur && /^\s{8,}\S/.test(raw)) cur.desc += '\n' + raw.trim()
      continue
    }
    const indent = m[1].length
    const text = m[2].trim()

    if (indent === 0) {
      groups.push({ solution: text, subgroups: [] })
      sub = null
      cur = null
    } else if (indent === 2) {
      if (!groups.length) throw new Error(`솔루션 없이 하위분류가 나왔습니다: ${text}`)
      sub = { name: text, commands: [] }
      groups[groups.length - 1].subgroups.push(sub)
      cur = null
    } else if (indent === 4) {
      if (!sub) throw new Error(`하위분류 없이 명령이 나왔습니다: ${text}`)
      if (text === '안내') cur = { label: '', command: '', desc: '', info: true }
      else {
        const c = /^명령어\s*:\s*([\s\S]*)$/.exec(text)
        if (!c) throw new Error(`알 수 없는 줄: ${raw}`)
        cur = { label: '', command: c[1], desc: '' }
      }
      sub.commands.push(cur)
    } else if (indent >= 6) {
      if (!cur) throw new Error(`명령 없이 속성이 나왔습니다: ${text}`)
      const lab = /^라벨\s*:\s*([\s\S]*)$/.exec(text)
      const des = /^설명\s*:\s*([\s\S]*)$/.exec(text)
      if (lab) cur.label = lab[1]
      else if (des) cur.desc = des[1]
      else throw new Error(`알 수 없는 속성 줄: ${raw}`)
    }
  }
  // info 는 true 일 때만 남긴다 (presets.ts 와 같은 모양이 되도록)
  for (const g of groups)
    for (const s of g.subgroups)
      for (const c of s.commands) if (!c.info) delete c.info
  return groups
}

function count(groups) {
  let subs = 0
  let cmds = 0
  for (const g of groups) {
    subs += g.subgroups.length
    for (const s of g.subgroups) cmds += s.commands.length
  }
  return `솔루션 ${groups.length} · 하위분류 ${subs} · 명령 ${cmds}`
}

// ── 실행 ───────────────────────────────────────────────────
const mode = process.argv[2] ?? 'check'
if (mode === 'to-md') {
  const { groups } = readTs()
  writeFileSync(MD, toMd(groups), 'utf-8')
  console.log(`명령어_프리셋.md 를 다시 썼습니다 — ${count(groups)}`)
} else if (mode === 'to-ts') {
  const groups = fromMd(readFileSync(MD, 'utf-8'))
  writeTs(groups)
  console.log(`src/presets.ts 에 반영했습니다 — ${count(groups)}`)
} else if (mode === 'check') {
  const { groups } = readTs()
  const fromFile = fromMd(readFileSync(MD, 'utf-8'))
  const same = JSON.stringify(groups) === JSON.stringify(fromFile)
  console.log(`presets.ts : ${count(groups)}`)
  console.log(`편집 md    : ${count(fromFile)}`)
  console.log(same ? '두 파일이 같습니다.' : '어긋나 있습니다 — to-md 또는 to-ts 로 맞추세요.')
  process.exit(same ? 0 : 1)
} else {
  console.error('사용법: node scripts/presets-md.mjs [to-md|to-ts|check]')
  process.exit(2)
}
