# Americano Design

## 설계 기준

PRD.md 13절을 구현 계약으로 사용한다. 기존 version 1은 중앙 패턴 기반 화면 감시기이며 version 2로 자동 변환할 수 없다. 기존 config와 watcher/capture/matcher/input 모듈은 보존하지만 새 앱 시작 경로에서 실행하지 않는다.

## 현재 코드 검토 결과

- 기존 controller.start는 initialize 완료 전 잠금이 없어서 중복 시작이 가능하다.
- stop은 watcher 종료를 기다리지 않고 참조를 버린다. 이전 입력과 다음 실행이 겹칠 수 있다.
- state가 설정을 읽을 때 실행 오류를 지워 원인 확인이 어렵다.
- 입력 뒤 대기는 취소할 수 없고 pause가 입력 실행기에 전달되지 않는다.
- matcher는 동기 이중 루프여서 큰 이미지에서 F9 처리도 지연된다.
- 앱 시작 즉시 자동화가 실행된다. 대상 창/권한/라이선스 검증은 없다.
- 저장 위치는 프로젝트 폴더이며 암호화/원자적 저장이 없다.
- renderer는 목록과 토글만 제공한다. version 2 순서 편집은 새로 필요하다.

## 첫 구현 범위

- src/macros.js: version 2 정규화와 엄격한 한도 검사. 우선 wait/key/text/mouse_move/click/repeat/stop을 지원한다. 나머지 DSL은 조용히 무시하지 않고 거부한다.
- src/store.js: userData의 암호화 JSON 저장소. AES-GCM 키는 safeStorage로 보호하고 저장을 직렬화한다.
- src/runner.js: 단일 실행, 복사본, run ID, pause/stop, 단계 진행과 오류 상태. 주입된 어댑터로 실제 입력과 실행 정책을 분리한다.
- electron/main.js: 편집과 미리보기 IPC, F8/F9 및 single-instance. 실제 실행은 준비되지 않은 상태로 명시적으로 거부한다.
- electron/renderer.js: 매크로 생성/복제/삭제/활성화, 순서 추가/복제/삭제/이동과 단계부터 미리보기.

미리보기는 대기/반복/중단과 단계 진행을 실행하지만 키/마우스 입력은 전달하지 않는다. 이미지 검사를 흉내 내어 성공시키지 않는다. 실제 창 선택과 이미지 편집, import/export, 서명 검증은 후속 단계다.

## 검증

Node.js 24 내장 test runner로 스키마, 실행 경쟁, pause/stop, 오류 유지, 저장 암호화와 손상 보호를 검증한다. Electron GUI와 native 입력, NSIS 설치 검증은 별도로 수행해야 한다.
