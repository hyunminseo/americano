# Americano 심플 모드 설계 문서 (컨텍스트 유지용)

> 목적: 지금까지 구현된 전체 기능을 하나의 문서로 정리하고,
> 비개발자용 "매크로 고르고 시작/중지만 하면 되는" 버전을 정의한다.
> 기준 버전: `package.json` 4.2.0 / PRD v2 + MACRO_DESIGN + GOAL 완료분.
> 이 문서는 이후 작업의 컨텍스트 기준이다. 상세 스펙은 PRD.md / MACRO_DESIGN.md / GOAL.md를 따른다.

## 1. 목표

1. 일반 사용자는 매크로 선택 → 시작 → 중지만 한다. 편집/캡처/좌표/임계값 노출 금지.
2. 지금까지 구현된 모든 실행·탐지·라이선스·저장 기능은 그대로 재사용한다. UI만 단순화한다.
3. 에러 발생 시 사용자에게는 `관리자에게 문의하세요` + 에러코드를 보여주고,
   관리자는 로그/원인으로 수정 가능해야 한다 (디버깅 경로 보장).

비목표:

- 새 탐지 알고리즘, 새 액션 타입 추가 없음.
- 기존 편집 UI 삭제 없음. 관리자(개발자) 모드로 보존한다.

## 2. 지금까지 구현된 전체 기능 인벤토리 (4.2.0)

### 2.1 매크로 코어 (`src/macros.ts`, `src/config.ts`)

- version 2 문서: `id(1~64자 영문/숫자/_/-)`, `name`, `enabled`, `hotkey`, `target_window`, `script`, `images(최대 200)`, `actions(최대 1000 노드, 중첩 8)`, `overlay`, `loop{count 1~10000, interval_ms 30~60000}`, `binding`. 매크로 최대 100개.
- 액션 14종: `wait`, `random_wait(min/max 초, 1~3600)`, `key(가상키+조합 정규화, F8/F9 예약)`, `text(최대 10000자, Unicode, 클립보드 미사용)`, `mouse_move`, `click(left/right/middle, client/overlay 좌표계)`, `scroll`, `image_detect`, `image_wait`, `image_click`, `smart_click(탐지-클릭 후 화면변화 검증, expect_image, verify_interval_ms)`, `retry(이미지/condition만 감쌈)`, `repeat`, `condition(test=image_detect + then/else)`, `stop`.
- 이미지 옵션: `threshold(기본 0.9)`, `poll_interval_ms(기본 100)`, `timeout_ms(기본 10000)`, `zone(0~9, 3x3 구역)`, `region`, `roi`, `preprocess(none/normalize)`, `pyramid`, `features(off/fallback/only)`, `alt_images(최대 2, OR 판정)`, `template_scale_percent(25~400, v4.2)`, `monitor(1~16)`.
- 단축키 정규화: 대소문자/공백/modifier 순서/`Control→ctrl` 별칭, 활성 매크로 중복 등록 거부.
- `Americano Script` 텍스트 포맷 보관: `if/elseif/else/endif`, `while/endwhile`, `for/endfor`, `wait/image_wait/image_click/key/text/click/set/break/continue/stop`. 원문+AST 저장, renderer에서 JS 실행 금지.

### 2.2 대상 창·좌표 (`src/windows.ts`, `src/native-windows.ts`, `src/resolution.ts`)

- 조건 AND: `process_name` / `executable_path` / `title_contains(포함, 대소문자 무시)`. 후보 복수면 실행 거부.
- HWND는 세션 보관만. 최소화 시 복원+전경 확인 후 입력. 전경 실패 시 입력 차단.
- 좌표 = 96 DPI 기준 DIP. 매 입력 전 `screen = origin + round(relative * dpi/96)`. 비례 확대 없음, 범위 밖이면 실패.
- v4 게임 해상도 자동 설정: 물리좌표+DPI 가상화 함께 읽어 저장영역 계산. 전경 전환 불필요, 창 크기 안정 시 확정.
- 다중 모니터 음수 좌표 허용. 창 재탐색 timeout 기본 10초.

### 2.3 오버레이·캡처 (`src/overlay.ts`, `electron/capture-overlay.*`, `electron/overlay-outline.*`)

- 오버레이 = client 영역 96 DPI `x/y/width/height`. null 허용, 설정 후 자동 저장.
- 전체 창 자동 설정 / 드래그+Enter 확정 / Esc 취소. 저장 테두리는 클릭 통과(click-through), 창 이동 추적.
- 영역 안 이미지 캡처 → 96 DPI 정규화 → `.aimg` 암호화 자산. 미리보기·참조도 암호화 문서에 저장.
- 캡처는 실제 화면 client 영역만. 가림/잠금/보호 콘텐츠 미지원.

### 2.4 탐지 (`src/detect.ts`, `src/matcher.ts`, `src/features.ts`, `src/capture.ts`)

- 그레이스케일 템플릿 매칭. 절반 해상도 선탐색 → 원본 정밀화.
- 탐색 순서: `learned_region(최근 성공, v4.1)` → `region(최초 캡처 위치)` → `zone 구역` → `전체 오버레이`.
- 좌표 힌트만으로 클릭 금지, 매번 일치 확인. 검출 성공 프레임은 `userData/match-shots`에 박스+점수 포함 최대 30장.
- 클릭 직전 0.8초 녹색 링 표시.

### 2.5 실행 (`src/runner.ts`, `src/controller.ts`, `src/input-adapter.ts`, `src/input.ts`, `src/keyboard.ts`, `src/watcher.ts`)

- 전역 단일 실행 잠금. 두 번째 실행 요청은 대기열 없이 거부. 실행은 저장 정의 복사본+run ID 사용.
- 상태: `STOPPED / ARMED(단축키 대기) / RUNNING / PAUSED / ERROR`. 오류는 다음 실행까지 보존.
- F8 일시정지/재개 (timeout에서 pause 시간 제외, 재개 시 창/전경 재확인), F9+중지 버튼이 대기/반복/탐색 즉시 중단. 취소 인지 목표 100ms. 이미 OS 전달된 입력은 취소 불가, 눌린 키/버튼은 해제 후 잠금 해제.
- 전체 반복 `loop.count/interval_ms`(기본 1회/500ms), 마지막 반복 뒤 대기 없음. `repeat` 중첩 반복, `stop`은 정상 중단 기록.
- 입력: 키=Windows 가상키 `SendInput`(조합은 누름순/역순해제 단일 호출), 문자=Unicode 이벤트(한글·이모지, 전경 변경 시 나머지 중단), 마우스=`SetCursorPos`→실패 시 `SendInput` 폴백→실제 커서 확인 후 클릭. 가려짐/이동중 취소/전경 변경 시 클릭 차단.
- 미리보기 모드: 실제 캡처·입력과 라이선스 검사 미수행, 조건은 false 분기로 진행. 참 분기·입력 수신 증명 아님.

### 2.6 저장·import/export (`src/store.ts`, `src/portable.ts`)

- `app.getPath('userData')` 아래 AES-256-GCM (매 쓰기 새 12-byte nonce, 32-byte 키는 `safeStorage`/DPAPI 보호, 없으면 평문 대체 금지), 원자적 rename, 쓰기 직렬화, 복호화 실패 시 원본 보존. 이미지 동일 정책.
- 내보내기 `.amacro`: 설정+PNG 평문 패키지 (암호화 아님 UI 고지), 창기준→오버레이기준 좌표 변환, 실행경로·시작단축키 제거, SHA-256은 손상 검사용. 이미지 미선택 단계 있으면 n번째 단계 고지 후 중단.
- 가져오기: 버전/크기/디코딩/ID중복/자산참조/액션 검증 → 새 ID 발급 → 현 PC 키로 재암호화. 실패 시 기존 매크로 불변, 중간 이미지 롤백. 외부 경로 참조 거부. 이후 대상창 확인+오버레이 재지정 필요. 크기 변경 시 비례 확대 금지, 범위 이탈 시 실행 거부 + 검토 안내.

### 2.7 라이선스·권한 (`src/license.ts`, `licensing/`)

- 오프라인 Ed25519 서명 검증 (정확 payload 바이트). 개인키 미포함, 공개키만 배포.
- 장치 바인딩 = 정규화 MAC의 제품별 SHA-256 해시. Node 네트워크 정보 + `getmac.exe` 비동기 조회, IP 미할당 어댑터 포함. 둘 다 실패 시 거부. 10초 재조회.
- UTC 만료 시각 도달 시 새 실행 거부 + 실행 중 매크로는 다음 단계 경계에서 중단. 유예기간 없음. 만료해도 열람/편집/export 허용, 데이터 자동 삭제 금지.
- 무라이선스/만료 시 실제 입력+단계 테스트 차단, 생성/편집/저장/import/export/미리보기는 허용.
- 관리자 권한 대상 창은 앱도 동등 권한 필요. 권한 거부 시 시작 차단 + 원인/재실행 안내. 권한 상승은 사용자 동의 없이 수행 금지.
- preload allowlist IPC + CSP/sandbox/contextIsolation. renderer 직접 Node/FS 접근 금지.

### 2.8 UI·배포·검증 (현재)

- Electron: `main(IPC/캡처/실행연결/single-instance)` / `preload` / `renderer(1360줄 규모 워크플로우 편집기)` / 진행 오버레이(always-on-top 실행위치 표시) / F7 시작.
- 워크플로우 캔버스: 위→아래 실행순, 조건 참/거짓 레인, 반복 컨테이너, 드래그 순서변경/↑↓/복제/삭제/＋추가, 인스펙터 편집, 실행 노드 강조, 가로·세로 스크롤/드래그이동/Ctrl+휠 확대/전체보기.
- 배포: `build.bat` → `dist/Americano-Portable.exe` 단일 포터블. ASAR, 예제컨피그/구감시기 제외. 설정은 EXE 옆이 아닌 userData에 유지.
- 검증: `npm test`(61개: 스키마/실행경쟁/pause·stop/오류유지/암호화/좌표/분기/패키지/키정리), `test:overlay-ui`(캡처/순서변경/패키지왕복/재지정/재시작복원), `test:keyboard-ui`(실수신창 자동 활성화 후 좌표·이미지클릭/한글·이모지·조합·특수키/F8·F9/전경변경·소실 차단/키해제), `build` 패키지 로딩 검증. 확장 실기 테스트 통과 기록은 MACRO_DESIGN 7절.

## 3. 심플 모드 정의

### 3.1 사용자상

- 비개발자. 매크로 제작은 관리자 완료 상태. 사용자는 실행만.
- 사용 흐름 3단계: (1) 목록에서 매크로 고르기 → (2) 시작 누르기 → (3) 중지 누르기 (또는 완료 대기).

### 3.2 화면 spec (SimpleView)

- 구성요소만: 타이틀, 매크로 드롭다운/리스트 (이름+대상앱 표시), 상태 pill (`대기중/실행중/일시정지됨/오류`), 큰 버튼 2개 (`시작`, `중지`), 진행 한 줄 (`3/12단계 · 2/5회`), 에러 박스 (평상시 숨김).
- 숨길 것: 워크플로우 캔버스, 인스펙터, 캡처/오버레이 버튼, import/export, threshold/timeout/zone/좌표, 스크립트 탭, hotkey 편집, 미리보기, 진행 오버레이 토글, F7 언급.
- 키보드: `시작` 버튼 포커스 Enter 동작, F9는 내부적으로 중지에 매핑하되 사용자에게는 "중지 버튼"으로만 안내. F8 일시정지는 심플 모드에서 노출하지 않는다 (오조작 방지). 필요 시 v2에서 옵션화.
- 시작 전 게이트 (자동, 메시지 없이 통과가 정상): 라이선스 유효, 단일실행 잠금空, 대상창 1개 확인, 오버레이·이미지 연결 확인. 실패하면 즉시 3.3 에러 박스로 분기.
- 실행 중: 매크로 변경/재시작 비활성화, 중지만 가능. 완료 시 상태 `대기중` + `완료되었습니다` 한 줄 토스트.

### 3.3 에러 표시 정책

- 사용자 문구 고정: `문제가 발생했습니다. 관리자에게 문의하세요.` + `에러코드: XXX-0000` + `시각` + `복사` 버튼. 기술 스택·경로·이미지명 원문 노출 금지.
- 에러코드 체계 (관리자 매핑용, 코드는 안정 유지):
  - `LIC-xxxx`: 라이선스 없음/만료/장치불일치/서명변조
  - `TGT-xxxx`: 대상창 없음/복수후보/전경실패/최소화복원실패/권한부족
  - `IMG-xxxx`: 탐지실패·timeout·재시도소진/기준이미지없음/영역이탈
  - `INP-xxxx`: 입력전달실패/커서이동실패/가려짐차단
  - `SYS-xxxx`: 저장복호화실패/네이티브모듈·캡처실패/F8·F9등록실패
- 관리자는 에러코드로 아래 3.4를 열어 원인을 수정한다.

### 3.4 관리자 디버깅 경로 (반드시 보장)

1. `상세 보기(관리자용)` 접힘 패널 또는 별도 AdminView에서 원문 표시: `runId`, `macroId`, 단계 인덱스/타입, `score/검색영역/창크기`, 대상창 판정 결과, 라이선스 상태, 예외 메시지. 기존 runner 로그(`성공/중단/timeout/오류`) 재사용.
2. 로그 파일: userData 아래 실행 로그 + `match-shots/` 최근 30장 유지. Simple 모드에서도 기록 계속.
3. 수정 동선: AdminView(=기존 전체 편집 UI) 진입 → 대상창 재선택/오버레이 재지정/이미지 재캡처/임계값·재시도 조정 → 저장 → SimpleView로 복귀해 재실행. 데이터 포맷 변경 없음(v2 호환).
4. 관리자 진입: 설정 파일 플래그 또는 시작 인자/숨은 진입 (예: `simple:false`, `--admin`). 일반 사용자에게 버튼 노출 금지. 구현 시 5절 참조.

## 4. 아키텍처 (재사용, 신규 코드 최소)

- `electron/main.ts`: 기존 IPC·실행·라이선스·single-instance 그대로. Simple IPC는 `list-macros(읽기) / start-macro / stop / get-status` 4개로 제한. 편집 IPC는 AdminView에서만 허용.
- `electron/renderer.ts`: `?simple=1` 또는 설정값으로 SimpleView/AdminView 분기. SimpleView는 신규 경량 컴포넌트 (~200줄 목표), 기존 1360줄 편집기는 AdminView로 격리.
- `src/runner.ts + controller.ts`: 그대로 사용. Simple 시작도 동일 잠금/runID/복사본/F9 취소/오류보존 경로. 미리보기 경로는 Simple에서 호출 금지(실행만).
- `src/license.ts`: 시작 게이트 그대로. 실패는 `LIC-xxxx`로 매핑.
- `src/store.ts / portable.ts`: 읽기 전용으로 사용. Simple에서 저장 쓰기 없음(실행 상태 제외).

## 5. 구현 계획

1. Phase S1: 설정 `ui.mode: simple|admin` + 실행인자, SimpleView 정적 화면 (목록/시작/중지/상태), 기존 runner 연결 없이 mock 상태.
2. Phase S2: 4개 IPC + 시작 게이트 + 실행/중지/완료 흐름 연결, 버튼 활성화 규칙.
3. Phase S3: 에러코드 매핑표 (`src/error-codes.ts` 신규, 모든 runner/controller/license 예외를 5자리 코드로 변환) + 사용자 에러박스 + 복사 버튼 + 관리자 상세 패널.
4. Phase S4: Admin 진입/복귀 + 로그·match-shots 열기 버튼(관리자만) + 회귀테스트 (`simple-ui` smoke: 목록→시작→중지→에러코드 표시, 편집 IPC 차단 확인).
5. 수용 후 `build.bat` 그대로 포터블 빌드. Simple이 기본값인지 여부는 릴리스 결정으로 남김 (권장: 기본 simple, 관리자 플래그로 admin).

## 6. 수용 기준

- [ ] 첫 화면에서 10초 안에 매크로 선택→시작 가능, 설명서 없이 완료 가능.
- [ ] 실행 중 편집 요소 0개. 시작/중지 외 클릭할 것이 없음.
- [ ] 모든 실패가 `관리자에게 문의하세요 + 에러코드`로 표시되고 앱이 멈추지 않음.
- [ ] 관리자가 에러코드+runId로 로그/match-shot/원인 단계를 특정하고, AdminView에서 수정 후 재실행 성공.
- [ ] 기존 매크로(v2, 이미지·오버레이·loop 포함)가 변환 없이 그대로 실행됨.
- [ ] `npm test` + 신규 simple smoke 통과, 포터블에서 userData 암호화 저장·라이선스 게이트 동작.

## 7. 컨텍스트 파일맵 (다음 작업용)

- 요구·계약: `PRD.md` 13절·15절 / `MACRO_DESIGN.md` 1~5절 / `GOAL.md`
- 검증·스키마: `src/macros.ts:234~285(actions)` / `src/runner.ts` / `src/license.ts` / `src/store.ts` / `src/portable.ts`
- 창·입력: `src/windows.ts` / `src/native-windows.ts` / `src/keyboard.ts` / `src/input-adapter.ts`
- 탐지: `src/detect.ts:162~238(zone/learned)` / `src/features.ts`
- UI: `electron/main.ts(786줄)` / `electron/renderer.ts(1361줄)` / `electron/index.html` / `electron/styles.css`
- 본 문서: 심플 모드 기준. 변경 시 본 문서 먼저 갱신.
