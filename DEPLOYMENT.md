# HS12 Cloudflare 배포 가이드

## 1. 사전 준비
- GitHub 저장소: https://github.com/cyber924/hs12
- Cloudflare Workers 프로젝트를 GitHub 저장소에 연결하거나 Wrangler로 배포합니다.
- Cloudflare D1에서 `hs12-db` 데이터베이스를 생성합니다.

## 2. D1 바인딩
Worker 설정 > Bindings > D1 database에서 변수명을 `DB`, 데이터베이스를 `hs12-db`로 지정합니다.
또는 `wrangler.toml`의 `database_id`를 생성한 D1 ID로 교체합니다.

마이그레이션 실행:
```bash
npx wrangler d1 migrations apply hs12-db --remote
```

## 3. Gemini 키
Worker > Settings > Variables and Secrets에서 Secret `GEMINI_API_KEY`를 등록합니다.
일반 변수 `GEMINI_MODEL`은 `gemini-3.8-flash` 또는 계정에서 사용 가능한 `gemini-3.5-flash`로 지정합니다.
키는 브라우저에 노출되지 않고 Worker에서만 사용됩니다.

## 4. 배포
Cloudflare Workers Builds에서 main 브랜치를 연결합니다. 빌드 명령은 비워두고 배포 명령을 `npx wrangler deploy`로 지정합니다.
로컬 배포는 `npm install` 후 `npx wrangler deploy`를 실행합니다.

## 5. 확인 순서
1. `/api/health`에서 ok=true, storage=D1 확인
2. 회원가입 및 로그아웃/로그인
3. 이미지 허브에서 HTTPS 이미지 주소 등록
4. Creator Studio에서 원고 생성
5. 내 보관함에서 수정·삭제·검수·발행
6. 공개 웹진 및 `/blog/{slug}` 비로그인 접근
7. AI 에이전트에서 기획·생성·검수·수정·발행 대화 실행

## 데이터와 보안
- 사용자, 원고, 이미지 메타데이터, 에이전트 대화는 신규 D1에 저장됩니다.
- 이미지 파일은 업로드하지 않습니다. HTTPS 주소만 저장합니다.
- 비밀번호는 PBKDF2-HMAC-SHA256으로 해시하며 세션 토큰은 해시하여 저장합니다.
- Gemini API 키는 Worker Secret으로만 관리합니다.
- 회원가입은 이메일 형식 확인을 수행합니다. 이메일 소유권 확인 및 비밀번호 재설정 메일은 별도 이메일 발송 서비스 연결 전에는 제공되지 않습니다.
