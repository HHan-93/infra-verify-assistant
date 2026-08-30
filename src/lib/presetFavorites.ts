/**
 * 프리셋 즐겨찾기 · 최근 실행 (프리셋 패널과 다중 실행이 같은 목록을 본다).
 *
 * 두 화면이 각자 목록을 들면 "프리셋에서 별을 달았는데 다중 실행에는 없다" 가 된다.
 * 같은 명령을 고르는 일이므로 저장소를 하나로 둔다.
 *
 * 식별자는 `솔루션|하위분류|명령어`. 라벨은 사람이 고칠 수 있어 기준이 못 되고, 같은 명령어라도
 * 솔루션이 다르면 다른 항목이다. 명령어를 고치면 별이 풀린다 — 엉뚱한 항목에 남는 것보다 낫다.
 */
const FAV_KEY = 'preset_favorites'
const RECENT_KEY = 'preset_recent'
export const RECENT_MAX_ITEMS = 12

export const presetId = (solution: string, subgroup: string, command: string) =>
  `${solution}|${subgroup}|${command}`

function readList(key: string): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? '[]')
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return [] // 손상된 값은 빈 목록으로 — 즐겨찾기 때문에 패널이 안 뜨면 안 된다
  }
}
function writeList(key: string, v: string[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(v))
  } catch {
    /* 저장 실패는 무시 — 이번 세션에서만 유지된다 */
  }
}

export const readFavorites = (): string[] => readList(FAV_KEY)
export const readRecents = (): string[] => readList(RECENT_KEY)
export const writeFavorites = (v: string[]): void => writeList(FAV_KEY, v)
export const writeRecents = (v: string[]): void => writeList(RECENT_KEY, v)

/** 실행한 것을 맨 앞으로 (같은 것을 또 실행하면 중복이 아니라 순서만 올라간다) */
export function pushRecent(id: string): string[] {
  const next = [id, ...readRecents().filter((x) => x !== id)].slice(0, RECENT_MAX_ITEMS)
  writeRecents(next)
  return next
}
