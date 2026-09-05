# Americano

Windows용 Electron 매크로 편집기입니다. Node.js 24.x와 npm 11.x를 사용합니다.

## 현재 구현

- version 2 매크로 생성, 복제, 삭제, 활성화 설정, 순서 편집
- wait/key/text/mouse_move/click/repeat/stop 정의 검증
- 입력 없는 전체/선택 단계부터 미리보기, F8 일시정지/재개, F9 중지
- 실행 중복 방지, 실행 복사본, 단계 표시와 오류 보존
- 앱 userData/macros-v2에 AES-256-GCM 저장, 키는 Electron safeStorage로 보호

현재 실제 키보드/마우스 입력은 연결하지 않았습니다. 대상 창 native 어댑터, 권한 검사, 라이선스 검증을 연결한 뒤 실제 실행을 지원합니다. 시작 단축키는 설정/충돌 검사만 지원하며 아직 등록하지 않습니다. 이미지 액션, import/export, 화면 좌표 선택도 후속 구현입니다. 반복 내부 단계는 JSON 배열로 편집합니다.

기존 version 1 config.example.json과 감시기 모듈은 보존하지만 새 앱은 자동으로 읽거나 실행하지 않습니다. version 2 예시는 config.v2.example.json을 참고하세요. 기존 설정 파일을 복사할 필요 없이 UI에서 새 매크로를 생성합니다.

## 실행과 검증

```powershell
npm.cmd install
npm.cmd start
npm.cmd test
npm.cmd run build
```

Node.js가 PATH에 없다면 설치 경로를 PATH에 추가합니다. 로컬 개발 셸 예시:

```powershell
$env:Path = 'C:\Program Files\nodejs;' + $env:Path
npm.cmd test
```

앱 시작 시 자동 실행하지 않습니다. F8/F9 등록 실패나 보호 저장소 오류는 화면에 표시됩니다. 저장소 복호화 실패 시 원본을 덮어쓰지 않습니다. Windows 사용자 프로필을 잃으면 로컬 키를 복구하지 못할 수 있습니다. 이동용 export는 아직 구현되지 않았습니다.

## 구현 구조

- PRD.md: 제품 요구사항과 확정한 구현 계약
- DESIGN.md: 기존 코드 검토 결과, 첫 구현 범위와 후속 작업
- src/macros.js: version 2 검증과 단축키 정규화
- src/store.js: 암호화 및 직렬화된 원자적 저장
- src/runner.js: 실행 수명, 일시정지/취소와 입력 어댑터 계약
- electron/: 제한된 IPC와 순서 편집 화면
- tests/: Node.js 내장 test runner 기반 회귀 테스트

자동 테스트는 OS 입력을 주입하지 않습니다. Electron GUI, Windows DPAPI 실동작, native 모듈 및 NSIS 설치 패키지는 별도 실기기 검증이 필요합니다.
