// 심플 모드 에러코드 계약. 사용자 문구는 고정하고, 원문은 관리자 상세에만 노출한다.
export const SIMPLE_USER_MESSAGE = '문제가 발생했습니다. 관리자에게 문의하세요.';

export type SimpleErrorGroup = 'LIC' | 'TGT' | 'IMG' | 'INP' | 'SYS';

const RULES: { group: SimpleErrorGroup; code: string; keywords: string[] }[] = [
  { group: 'LIC', code: 'LIC-0001', keywords: ['라이선스', '서명', '만료', 'MAC', '장치', 'license', 'authorize', '권한 확인'] },
  { group: 'TGT', code: 'TGT-0001', keywords: ['대상 창', '전경', '최소화', '창을 찾', '후보', '재선택', '오버레이 영역을 먼저', '범위를 벗어났습니다', '관리자 권한'] },
  { group: 'IMG', code: 'IMG-0001', keywords: ['이미지', '탐지', '검색 timeout', 'timeout을 초과', '재시도', '기준 이미지', 'match', '찾지 못했습니다', '단계를 찾지'] },
  { group: 'INP', code: 'INP-0001', keywords: ['입력', '키보드', '마우스', '클릭', '커서', '가려져', '중단했습니다', '거부되었습니다', 'SendInput', 'SetCursorPos'] },
  { group: 'SYS', code: 'SYS-0001', keywords: [] },
];

export function classifySimpleError(message: unknown): { code: string; group: SimpleErrorGroup } {
  const text = String(message ?? '');
  for (const rule of RULES) {
    if (rule.keywords.some((keyword) => keyword && text.includes(keyword))) return { code: rule.code, group: rule.group };
  }
  if (/F8\/F9|단축키|저장소|보호 저장소|네이티브|캡처|오버레이를 편집|이미 실행/.test(text)) return { code: 'SYS-0001', group: 'SYS' };
  return { code: 'SYS-0001', group: 'SYS' };
}
