# americano manager design

## 1. 범위

이 문서는 현재 구현된 Windows MVP의 내부 설계를 정의한다. 제품 요구사항과 수용 기준은 [prd.md](prd.md)에 기록한다.

현재 실행은 Windows 네이티브 환경에서만 지원한다. Docker는 화면 캡처와 키보드 입력을 실행하지 않고, 설정·매칭·watcher 테스트를 재현하는 용도로 사용한다.

## 2. 시스템 구조

```text
app.py
  |
  +-- config.py ---------------------- JSON 로드/검증
  |
  +-- WindowsScreenCapture ----------- mss 화면 캡처
  |       |
  |       +-- capture_center() -------- 중앙 패턴 게이트용 고정 영역
  |       +-- capture(region) ---------- 타깃별 영역
  |
  +-- CenterPatternGuard -------------- 빌드 고정 패턴 검사
  |       +-- find_template()
  |
  +-- Watcher ------------------------- 주기 실행 및 상태 debounce
          +-- find_template() -------- 타깃 이미지 검사
          +-- execute_actions() ------- 키보드 액션 실행
                  |
                  +-- WindowsKeyboard -- pynput 입력
```

주요 경계는 `ScreenCapture`와 `KeyboardAdapter` 프로토콜이다. watcher는 실제 운영체제 API를 직접 호출하지 않고 이 경계를 통해 접근하므로 가짜 어댑터를 주입할 수 있다.

## 3. 실행 흐름

```text
start
  -> load_config()
  -> WindowsScreenCapture / WindowsKeyboard 초기화
  -> CenterPatternGuard 기준 이미지 로드
  -> F8/F9 전역 단축키 시작
  -> 반복
       -> 중앙 영역 캡처
       -> 허용 패턴 검사
       -> 실패: 모든 target visible 상태 초기화 후 입력 차단
       -> 성공: target 영역 캡처 및 이미지 매칭
       -> on_appear + cooldown 판정
       -> 키보드 액션 실행
  -> 종료 시 hotkey, capture, keyboard 정리
```

중앙 패턴 검사는 타깃 검사보다 먼저 실행한다. 허용되지 않은 화면에서 이전 탐지 상태가 남아 재실행되는 것을 막기 위해 게이트 실패 시 모든 타깃의 `visible` 상태를 `False`로 초기화한다.

## 4. 설정과 불변 정책

### 사용자 설정

`config.json`은 다음을 제어한다.

- 모니터 번호
- 전체 검사 주기
- 타깃 이미지 경로
- 타깃 영역
- 매칭 임계값
- cooldown
- 키보드 액션
- 타깃 활성화 여부

`config.py`는 버전, 경로, 영역, 임계값, 키 이름, 숫자 범위를 실행 전에 검증한다. 이미지가 없거나 잘못된 설정이면 자동 입력을 시작하지 않는다.

### 빌드 고정 정책

`policy/center_patterns.py`의 `ALLOWED_CENTER_PATTERNS`는 설정 파일에서 읽지 않는다. 현재 값은 다음과 같다.

```python
("니플레티", "카시우스")
```

각 항목의 PNG가 `policy/center_patterns/`에 없으면 `CenterPatternGuard` 초기화가 실패한다. 따라서 기준 이미지가 빠진 빌드는 실행되지 않는다. Python 소스와 로컬 파일 자체를 사용자가 수정하는 것을 기술적으로 완전히 막을 수는 없으므로, 배포 시 단일 실행 파일 패키징, 파일 서명, 배포 디렉터리 권한을 함께 사용한다.

## 5. 이미지 매칭 설계

### 5.1 전처리 순서

```text
BGR/BGRA/Gray 입력
  -> Gray 변환
  -> TM_CCOEFF_NORMED
  -> threshold 통과? 반환 : Otsu 이진화
  -> TM_CCOEFF_NORMED 또는 단색이면 TM_SQDIFF_NORMED
  -> 더 높은 confidence 선택
```

- 그레이스케일은 BGR 3채널보다 계산량이 적고 색상 변화에 덜 민감하다.
- 첫 매칭이 임계값을 통과하면 이진화하지 않아 정상 프레임의 비용을 낮춘다.
- 첫 매칭이 실패할 때만 Otsu 이진화를 수행해 밝기·색상 변화에 대응한다.
- 템플릿이 화면보다 크면 즉시 불일치로 반환한다.
- 채널 전체가 일정한 단색 템플릿은 상관계수가 불안정하므로 정규화 제곱차를 사용한다.

### 5.2 결과 계약

`find_template()`은 매칭 성공 시 `score`, `x`, `y`, `width`, `height`를 가진 `MatchResult`를 반환하고 실패 시 `None`을 반환한다. 좌표는 전달된 캡처 영역의 좌상단을 기준으로 한 상대 좌표다.

## 6. Watcher 상태와 안전성

타깃별로 `visible`과 마지막 실행 시각을 보관한다.

- 매칭 성공이며 이전 프레임에서 보이지 않았고 cooldown이 끝났을 때만 실행한다.
- 계속 보이는 동안에는 재실행하지 않는다.
- 보이지 않는 프레임을 거친 뒤 다시 보이면 재실행할 수 있다.
- F8 일시정지 중에는 타깃 visible 상태를 초기화해 재개 시 현재 화면을 새 출현으로 처리한다.
- F9 또는 종료 신호가 액션 순회 중 들어오면 다음 키 입력을 실행하지 않는다.
- 종료 시 캡처 객체, 전역 단축키 리스너, 키보드 어댑터를 정리한다.

## 7. 패키징 및 테스트

### 로컬 실행

```powershell
.\venv\Scripts\python.exe main.py --config config.json validate
.\venv\Scripts\python.exe main.py --config config.json run
```

### Docker 실행

`Dockerfile`은 Python 3.12 이미지에 requirements와 pytest를 설치하고 기본 명령으로 `pytest -q tests`를 실행한다. [build.bat](build.bat)은 다음을 순서대로 수행한다.

1. Docker CLI 존재 확인
2. Docker 데몬 실행 여부 확인
3. `americano-test` 이미지 빌드
4. 일회성 컨테이너에서 테스트 실행
5. 컨테이너 종료 코드를 배치 파일 종료 코드로 전달

`.dockerignore`는 가상환경, 캐시, 개인 설정을 빌드 컨텍스트에서 제외한다.

### 테스트 범위

- 설정 파일 경로 해석과 잘못된 주기 검증
- 그레이스케일/이진화 기반 템플릿 매칭 위치와 크기 조건
- `on_appear` 중복 방지와 재출현 실행
- 중앙 패턴 매칭 정책

현재 로컬 테스트 기준은 6개다. 실제 중앙 패턴 PNG가 추가되면 기준 이미지 로딩과 배포 패키지 검증 테스트를 추가한다.

## 8. 알려진 제약

- 템플릿 매칭은 크기·회전·폰트·DPI 변화에 취약하다.
- 중앙 패턴 PNG가 실제 대상 화면과 다르면 정상 화면도 차단된다.
- 화면 캡처와 키보드 입력은 Docker 컨테이너에서 실행하지 않는다.
- 설정 UI, 다중 스케일 매칭, macOS 구현은 아직 제공하지 않는다.
