/**
 * 검증 알림 — OS 알림(Windows 알림 센터 토스트)을 띄운다.
 *
 * 왜 필요한가: 가용성 검증은 10분 넘게 걸리는 일인데, 그동안 사람이 화면 앞에 붙어 있어야
 * '언제 복구됐는지' 를 안다. 알림은 **창을 보고 있지 않을 때** 그 순간을 알려주는 것이 전부다.
 *
 * 화면을 저절로 움직이는 기능(장애 시 패널 자동 펼침)은 넣었다가 제거한 전례가 있다.
 * 알림은 그와 다르다 — 화면은 그대로 두고 창 밖에서만 말한다.
 */
const KEY = 'notify_enabled'

/** 기본 ON. 끄면 아무 알림도 띄우지 않는다 */
export function notifyEnabled(): boolean {
  return localStorage.getItem(KEY) !== '0'
}
export function setNotifyEnabled(on: boolean): void {
  localStorage.setItem(KEY, on ? '1' : '0')
}

/** 설정이 꺼져 있으면 조용히 넘어간다 — 호출부가 매번 확인하지 않게 */
export function notifyOs(title: string, body: string): void {
  if (!notifyEnabled()) return
  void window.electronAPI.notify(title, body).catch(() => undefined)
}
