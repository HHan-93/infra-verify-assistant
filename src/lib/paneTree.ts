/**
 * tmux 스타일 임의 재귀 분할 레이아웃을 표현하는 이진 트리.
 * 리프(leaf)는 탭(세션) 하나를 가리키고, 분할(split) 노드는 두 자식을 가로(row, 좌우)
 * 또는 세로(col, 상하)로 ratio 비율만큼 나눈다. 고정 2/4분할 그리드 대신, 어느 칸이든
 * 다시 나누거나 합칠 수 있게 하기 위한 자료구조.
 */
export type PaneNode =
  | { type: 'leaf'; id: string; tabId: string }
  | { type: 'split'; id: string; dir: 'row' | 'col'; ratio: number; children: [PaneNode, PaneNode] }

export interface Rect {
  left: number
  top: number
  width: number
  height: number
}

/** 트리에 속한 모든 탭 id (중복 가능 — 스페어 탭이 없어 같은 탭을 두 리프에 배정한 경우) */
export function collectLeafTabIds(node: PaneNode): string[] {
  if (node.type === 'leaf') return [node.tabId]
  return [...collectLeafTabIds(node.children[0]), ...collectLeafTabIds(node.children[1])]
}

/** tabId 를 가진 리프 노드 탐색 (먼저 찾은 것 하나만 반환) */
export function findLeaf(node: PaneNode, tabId: string): { type: 'leaf'; id: string; tabId: string } | null {
  if (node.type === 'leaf') return node.tabId === tabId ? node : null
  return findLeaf(node.children[0], tabId) ?? findLeaf(node.children[1], tabId)
}

/** leafId(고유 노드 id) 로 리프의 현재 tabId 조회 */
function tabIdOfLeaf(node: PaneNode, leafId: string): string | null {
  if (node.type === 'leaf') return node.id === leafId ? node.tabId : null
  return tabIdOfLeaf(node.children[0], leafId) ?? tabIdOfLeaf(node.children[1], leafId)
}

/** leafId 리프를 dir 방향으로 분할해 newTabId 를 가리키는 새 리프(newLeafId)를 추가 */
export function splitLeaf(
  node: PaneNode,
  leafId: string,
  dir: 'row' | 'col',
  newLeafId: string,
  newSplitId: string,
  newTabId: string,
): PaneNode {
  if (node.type === 'leaf') {
    if (node.id !== leafId) return node
    return {
      type: 'split',
      id: newSplitId,
      dir,
      ratio: 0.5,
      children: [node, { type: 'leaf', id: newLeafId, tabId: newTabId }],
    }
  }
  return {
    ...node,
    children: [
      splitLeaf(node.children[0], leafId, dir, newLeafId, newSplitId, newTabId),
      splitLeaf(node.children[1], leafId, dir, newLeafId, newSplitId, newTabId),
    ],
  }
}

/** leafId 리프를 제거하고 형제를 그 자리로 승격. 트리 전체가 그 리프 하나뿐이면 null. */
export function closeLeaf(node: PaneNode, leafId: string): PaneNode | null {
  if (node.type === 'leaf') return node.id === leafId ? null : node
  const na = closeLeaf(node.children[0], leafId)
  const nb = closeLeaf(node.children[1], leafId)
  if (na === null) return nb
  if (nb === null) return na
  if (na === node.children[0] && nb === node.children[1]) return node
  return { ...node, children: [na, nb] }
}

/**
 * tabId 를 가진 리프를 모두 제거(중복 배정된 경우 전부) 하고 형제를 승격 — 탭(세션)을 완전히
 * 닫을 때 호출. 이걸 빼먹으면 트리에 더 이상 존재하지 않는 탭을 가리키는 "빈 칸"이 남는다.
 */
export function removeTabId(node: PaneNode, tabId: string): PaneNode | null {
  if (node.type === 'leaf') return node.tabId === tabId ? null : node
  const na = removeTabId(node.children[0], tabId)
  const nb = removeTabId(node.children[1], tabId)
  if (na === null) return nb
  if (nb === null) return na
  if (na === node.children[0] && nb === node.children[1]) return node
  return { ...node, children: [na, nb] }
}

/** 분할 노드(nodeId)의 비율 변경 (드래그 리사이즈) — 0.1~0.9 로 clamp */
export function patchRatio(node: PaneNode, nodeId: string, ratio: number): PaneNode {
  if (node.type === 'leaf') return node
  const clamped = Math.max(0.1, Math.min(0.9, ratio))
  if (node.id === nodeId) return { ...node, ratio: clamped }
  return { ...node, children: [patchRatio(node.children[0], nodeId, ratio), patchRatio(node.children[1], nodeId, ratio)] }
}

/**
 * targetLeafId 자리에 draggedTabId 를 배정. draggedTabId 가 이미 트리의 다른 리프에 있었다면
 * 그 리프에는 targetLeafId 가 원래 갖고 있던 탭을 배정해 서로 맞바꾼다(탭 하나가 두 리프에
 * 동시에 나타나는 상태를 방지).
 */
export function reassignTab(tree: PaneNode, targetLeafId: string, draggedTabId: string): PaneNode {
  const sourceLeaf = findLeaf(tree, draggedTabId)
  const targetTabId = tabIdOfLeaf(tree, targetLeafId)
  function patch(node: PaneNode): PaneNode {
    if (node.type === 'leaf') {
      if (node.id === targetLeafId) return { ...node, tabId: draggedTabId }
      if (sourceLeaf && node.id === sourceLeaf.id && targetTabId != null) return { ...node, tabId: targetTabId }
      return node
    }
    return { ...node, children: [patch(node.children[0]), patch(node.children[1])] }
  }
  return patch(tree)
}

interface LeafRect extends Rect {
  leafId: string
  tabId: string
}
interface DividerRect extends Rect {
  nodeId: string
  dir: 'row' | 'col'
}

/** 트리를 0~100(%) 좌표계의 리프 사각형 + 분할선(드래그 핸들) 목록으로 변환 */
export function layoutTree(node: PaneNode, rect: Rect = { left: 0, top: 0, width: 100, height: 100 }) {
  const leaves: LeafRect[] = []
  const dividers: DividerRect[] = []
  const nodeRects: Record<string, Rect> = {}

  function walk(n: PaneNode, r: Rect) {
    if (n.type === 'leaf') {
      leaves.push({ leafId: n.id, tabId: n.tabId, ...r })
      return
    }
    nodeRects[n.id] = r
    if (n.dir === 'row') {
      const aw = r.width * n.ratio
      walk(n.children[0], { left: r.left, top: r.top, width: aw, height: r.height })
      walk(n.children[1], { left: r.left + aw, top: r.top, width: r.width - aw, height: r.height })
      dividers.push({ nodeId: n.id, dir: 'row', left: r.left + aw, top: r.top, width: 0, height: r.height })
    } else {
      const ah = r.height * n.ratio
      walk(n.children[0], { left: r.left, top: r.top, width: r.width, height: ah })
      walk(n.children[1], { left: r.left, top: r.top + ah, width: r.width, height: r.height - ah })
      dividers.push({ nodeId: n.id, dir: 'col', left: r.left, top: r.top + ah, width: r.width, height: 0 })
    }
  }
  walk(node, rect)
  return { leaves, dividers, nodeRects }
}

/** ids 목록으로 균형 잡힌 타일 트리 생성(tmux tiled 레이아웃과 유사) — 레벨마다 방향을 번갈아 나눔 */
export function buildBalancedTree(ids: string[], nextId: () => string, dir: 'row' | 'col' = 'row'): PaneNode {
  if (ids.length <= 1) return { type: 'leaf', id: nextId(), tabId: ids[0] }
  const mid = Math.ceil(ids.length / 2)
  const nextDir = dir === 'row' ? 'col' : 'row'
  return {
    type: 'split',
    id: nextId(),
    dir,
    ratio: 0.5,
    children: [
      buildBalancedTree(ids.slice(0, mid), nextId, nextDir),
      buildBalancedTree(ids.slice(mid), nextId, nextDir),
    ],
  }
}
