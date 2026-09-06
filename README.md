# Americano

Windows용 Electron 매크로 편집기입니다. Node.js 24.x와 npm 11.x를 사용합니다.

## 현재 구현

- version 2 매크로 생성, 복제, 삭제, 활성화 설정, 순서 편집
- wait/key/text/mouse_move/click/repeat/stop 정의 검증
- 입력 없는 전체/선택 단계부터 미리보기, F8 일시정지/재개, F9 중지
- 실행 중복 방지, 실행 복사본, 단계 표시와 오류 보존
- 앱 userData/macros-v2에 AES-256-GCM 저장, 키는 Electron safeStorage로 보호

오프라인 라이선스의 서명/MAC/만료/기능 권한 검증, 등록과 갱신, 실행 권한 확인을 지원합니다. 유효한 라이선스가 있으면 선택한 Windows 창에서 키보드/마우스 입력을 실행합니다. 전경 전환에 실패하면 입력을 차단합니다. 시작 단축키는 설정/충돌 검사만 지원하며 아직 등록하지 않습니다. 매크로 import/export는 후속 구현입니다. 반복 내부 단계도 버튼과 입력 폼으로 편집합니다.

처음 실행하면 빈 작업 공간에서 **첫 매크로 만들기**를 선택합니다. 이름과 대상 앱을 설정하고 단계를 추가한 뒤 저장합니다. 별도의 컨피그 파일 작성이나 JSON 편집은 필요하지 않습니다. 개발용 예제 설정과 기존 감시기 모듈은 배포물에서 제외합니다.

## 실행과 검증

Node.js 24와 npm 11이 설치된 Windows에서 다음 명령 하나로 의존성 설치와 앱 빌드를 진행합니다. 별도의 install.bat 실행은 필요하지 않습니다.

```powershell
.\build.bat
```

완료 후 `dist\Americano-Portable.exe` 하나만 배포하고 실행합니다. Windows x64용이며 설치 프로그램과 Node.js 설치가 필요 없습니다. `win-unpacked`는 빌드 중간 산출물입니다.

현재 PC의 MAC 주소를 기준으로 라이선스 비교용 실행 파일 2개를 만들려면 `build-license-comparison.bat`를 실행합니다. 이 파일은 MAC을 자동으로 찾고 `dist\license-comparison\mac-match\Americano-MyMAC.exe`와 `dist\license-comparison\mac-mismatch\Americano-OtherMAC.exe`를 생성합니다. 두 파일은 배포용이 아니라 라이선스 인증 성공/실패 테스트용입니다.

포터블은 실행 파일의 무설치 배포를 뜻합니다. 사용자 설정은 EXE 옆에 노출하지 않고 Windows 사용자 데이터 폴더에 암호화 저장합니다. 같은 Windows 사용자로 다시 실행하면 설정이 유지되며, 다른 PC로 EXE를 복사하면 그 PC의 설정을 사용합니다. 기존 설정이 있는 PC에서 업그레이드해도 설정을 초기화하지 않습니다.

개발 실행과 테스트:

```powershell
npm.cmd start
npm.cmd test
```

Node.js가 PATH에 없다면 설치 경로를 PATH에 추가합니다. 로컬 개발 셸 예시:

```powershell
$env:Path = 'C:\Program Files\nodejs;' + $env:Path
npm.cmd test
```

앱 시작 시 자동 실행하지 않습니다. F8/F9 등록 실패나 보호 저장소 오류는 화면에 표시됩니다. 저장소 복호화 실패 시 원본을 덮어쓰지 않습니다. Windows 사용자 프로필을 잃으면 로컬 키를 복구하지 못할 수 있습니다. 이동용 export는 아직 구현되지 않았습니다.

## 구현 구조

## 오프라인 라이선스 비교

```powershell
npm.cmd run build:license-compare -- --mac XX:XX:XX:XX:XX:XX
```

현재 PC의 MAC을 지정하면 다음 두 파일이 생성됩니다. 비교 라이선스의 유효기간은 빌드 시점부터 30일입니다.

- `dist/license-comparison/mac-match/Americano-MyMAC.exe`: 해당 MAC에서 인증 성공
- `dist/license-comparison/mac-mismatch/Americano-OtherMAC.exe`: 다른 MAC에 묶여 인증 실패
- `dist/license-comparison/comparison.json`: MAC, 만료일, 패키지 검증 결과, EXE SHA-256 기록

앱의 라이선스 상태와 **실행 권한 확인** 버튼으로 비교합니다. 이는 라이선스 권한 검사이며 키/마우스 입력을 발생시키지 않습니다. 일반 매크로 편집과 미리보기는 인증 실패 시에도 가능합니다. F8/F9 충돌 없이 미리보기까지 비교하려면 한 번에 하나씩 실행하세요.

두 비교 앱은 각각 `%APPDATA%/Americano-mac-match`, `%APPDATA%/Americano-mac-mismatch`를 사용하므로 기존 일반 앱 설정과 서로 섞이지 않습니다. **라이선스 등록**으로 유효한 파일을 등록하면 내장 라이선스보다 우선합니다. 등록 후에는 해당 등록 상태를 비교하게 됩니다.

발급/백업/만료 정책과 진단 실행 방법은 [licensing/README.md](licensing/README.md)를 참고하세요.

## 구현 구조

- PRD.md: 제품 요구사항과 확정한 구현 계약
- DESIGN.md: 기존 코드 검토 결과, 첫 구현 범위와 후속 작업
- src/macros.js: version 2 검증과 단축키 정규화
- src/store.js: 암호화 및 직렬화된 원자적 저장
- src/runner.js: 실행 수명, 일시정지/취소와 입력 어댑터 계약
- electron/: 제한된 IPC와 순서 편집 화면
- tests/: Node.js 내장 test runner 기반 회귀 테스트

자동 테스트는 OS 입력을 주입하지 않습니다. Electron GUI, Windows DPAPI 실동작, native 모듈 및 포터블 앱 실행은 별도 실기기 검증이 필요합니다.

## 캔버스 오버레이 자동화

1. 매크로를 만들고 **창 새로고침**에서 프로세스와 대상 창을 선택합니다.
2. **오버레이 영역 설정**에서 드래그하고 Enter를 누릅니다. Esc는 취소입니다. 영역은 client 영역 기준 96 DPI 좌표로 자동 저장합니다.
3. **저장 오버레이 표시**로 클릭을 가로채지 않는 테두리를 표시합니다. 창 이동을 따라가며 **오버레이 숨기기**로 닫습니다.
4. **영역 안에서 이미지 캡처**로 작은 기준 이미지를 선택하고 Enter로 저장합니다. 이미지 파일은 앱 저장소에 AES-256-GCM으로 암호화합니다.
5. 보관함 이미지를 선택하고 일치율과 동작을 정한 뒤 **선택 이미지 조건 추가**를 누릅니다. 아래 true/false 분기의 키, 텍스트, 클릭 좌표와 추가 단계를 편집할 수 있습니다.
6. 전체 반복 횟수(1~10,000)와 간격(30~60,000ms)을 설정하고 **실행**합니다. F8은 일시정지/재개, F9와 중지 버튼은 탐지·반복 대기도 중단합니다. true이면 매 반복마다 해당 분기를 실행합니다.

현재 화면에 보이는 client 영역을 캡처하므로 다른 창에 가려진 화면과 보호 콘텐츠는 지원하지 않습니다. DPI 좌표를 보정하고 캡처 이미지를 96 DPI 크기로 정규화하지만, 앱 테마나 레이아웃 변경은 기준 이미지 재캡처가 필요할 수 있습니다. 저장 영역이 창을 벗어나면 재설정을 요구합니다.

검증: `npm test`는 저장·좌표 변환·분기·반복·취소를 검증합니다. `npm run test:overlay-ui`는 별도 임시 저장소와 고정 캡처 화면을 사용하는 Electron 통합 테스트입니다. 실제 앱의 전경 전환, 다중 모니터와 DPI 조합은 별도 실기기 검증 대상입니다.
