// ConfigMap 키 이름만 보고 '값을 가려야 하는 항목'인지 판단한다.
//
// 왜 값이 아니라 키 이름으로 판단하는가 — 값은 그냥 문자열이라 그것만 보고는 비밀인지 알 수 없다
// (`"true"` 도 `"7FarIVTI05OODpJ9NXF42CRAjt25zVQHITHBY3/Aap8="` 도 똑같이 문자열이다).
// 반면 키 이름은 사람이 붙인 것이라 의도가 담겨 있다. mask.ts 가 로그·리포트에서
// `password=...` 의 **값만** 가리고 키 이름은 남기는 것과 같은 판단이다.
//
// 실제 ConfigMap 에서 본 예: MAIL_PASSWORD · M2M_SECURITY_AES_SECRET_KEY ·
// BF_SERVICE_CMP_INTEGRATION_ACCESS_TOKEN · EMAIL_GOOGLE_APP_PASSWORD.
// 운영 cm 에 이런 값이 평문으로 들어 있으므로, 화면에 그대로 뿌리면 어깨너머로 새고
// 화면 녹화·캡처에도 남는다.
const SECRET_HINTS = [
  'password',
  'passwd',
  'secret',
  'token',
  'credential',
  'private_key',
  'privatekey',
  'apikey',
  'api_key',
  'access_key',
  'accesskey',
]

/**
 * 이 키의 값을 기본으로 가릴지.
 *
 * `_KEY` 로 끝나는 것을 통째로 비밀로 보면 `MAIL_HOST_KEY` 같은 무해한 것까지 가려져
 * 정작 봐야 할 설정이 안 보인다. 그래서 위 목록에 있는 낱말이 들어간 경우만 가린다.
 * 놓치는 게 있으면 목록에 낱말을 더하면 된다(가리는 판단은 항상 사용자가 뒤집을 수 있다).
 */
export function isSecretKey(key: string): boolean {
  const k = key.toLowerCase()
  return SECRET_HINTS.some((h) => k.includes(h))
}

/** 가릴 때 보여줄 문자열 — 길이를 흘리지 않도록 고정 길이로 */
export function maskedValue(): string {
  return '••••••••••••••••'
}
