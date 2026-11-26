export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  SITE_NAME?: string;
  SITE_URL?: string;
}

type User = { id: string; email: string; display_name: string };
const json = (data: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });
const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const hex = (bytes: Uint8Array) => [...bytes].map(x => x.toString(16).padStart(2, "0")).join("");
const digest = async (value: string) => hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
const randomToken = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return b64(bytes).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};
async function passwordHash(password: string, salt: string) {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: new TextEncoder().encode(salt), iterations: 310000, hash: "SHA-256" }, material, 256);
  return hex(new Uint8Array(bits));
}
function cookie(token: string, maxAge: number) {
  return `hs12_session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}
function readCookie(request: Request, name: string) {
  return request.headers.get("Cookie")?.split(";").map(x => x.trim()).find(x => x.startsWith(name + "="))?.slice(name.length + 1) || "";
}
async function auth(request: Request, env: Env): Promise<User | null> {
  const token = readCookie(request, "hs12_session");
  if (!token) return null;
  const row = await env.DB.prepare(`SELECT u.id,u.email,u.display_name FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?`).bind(await digest(token), now()).first<User>();
  return row || null;
}
const requireUser = (u: User | null) => u || null;
async function body(request: Request) { try { return await request.json() as Record<string, any>; } catch { return {}; } }
const safeSlug = (value: string) => value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9가-힣]+/g, "-").replace(/^-|-$/g, "").slice(0, 70) || crypto.randomUUID().slice(0, 8);
const articleSelect = "id,title,slug,summary,topic,keyword,tone,audience,content_json,image_urls_json,tags_json,status,published_at,created_at,updated_at,revision";
function articleRow(row: any) {
  return { ...row, content: JSON.parse(row.content_json || "{}"), imageUrls: JSON.parse(row.image_urls_json || "[]"), tags: JSON.parse(row.tags_json || "[]"), content_json: undefined, image_urls_json: undefined, tags_json: undefined };
}
async function gemini(env: Env, prompt: string, system: string, jsonMode = true) {
  if (!env.GEMINI_API_KEY) throw new Error("Cloudflare Worker Secret GEMINI_API_KEY가 등록되지 않았습니다.");
  const model = env.GEMINI_MODEL || "gemini-3.8-flash";
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0.7, ...(jsonMode ? { responseMimeType: "application/json" } : {}) } })
  });
  const data: any = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || `Gemini 호출 실패 (${response.status})`);
  const text = data.candidates?.[0]?.content?.parts?.map((p: any) => p.text || "").join("") || "";
  if (!text) throw new Error("Gemini가 빈 응답을 반환했습니다.");
  if (!jsonMode) return text;
  try { return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, "")); } catch { throw new Error("Gemini 응답을 JSON으로 해석하지 못했습니다."); }
}
async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url), path = url.pathname, method = request.method;
  if (path === "/api/health") {
    try {
      const row = await env.DB.prepare("SELECT COUNT(*) AS users FROM users").first<{users:number}>();
      const tables = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all<{name:string}>();
      return json({ ok: true, service: "HS12", storage: "D1", database: "connected", userCount: row?.users ?? null, tables: (tables.results || []).map(x => x.name), aiConfigured: !!env.GEMINI_API_KEY, model: env.GEMINI_MODEL || "gemini-3.8-flash" });
    } catch (error) {
      console.error("HS12 health D1 check failed:", error);
      return json({ ok: false, service: "HS12", database: "error", detail: error instanceof Error ? error.message : "D1 query failed" }, 500);
    }
  }
  if (path === "/api/auth/register" && method === "POST") {
    const b = await body(request), email = String(b.email || "").trim().toLowerCase(), password = String(b.password || ""), displayName = String(b.displayName || email.split("@")[0] || "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "올바른 이메일 주소를 입력하세요." }, 400);
    if (password.length < 8 || password.length > 72) return json({ error: "비밀번호는 8~72자로 입력하세요." }, 400);
    const salt = randomToken(), userId = id(), time = now();
    try {
      await env.DB.prepare("INSERT INTO users(id,email,password_hash,password_salt,display_name,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").bind(userId,email,await passwordHash(password,salt),salt,displayName,time,time).run();
    } catch (error) {
      console.error("HS12 registration insert failed:", error);
      const message = error instanceof Error ? error.message : "unknown database error";
      if (/UNIQUE constraint failed: users.email/i.test(message)) {
        return json({ error: "이미 가입된 이메일입니다." }, 409);
      }
      return json({ error: "회원 정보를 D1에 저장하지 못했습니다. Worker의 DB 바인딩과 users 테이블을 확인하세요." }, 500);
    }
    const token = randomToken();
    await env.DB.prepare("INSERT INTO sessions(id,user_id,token_hash,expires_at,created_at) VALUES(?,?,?,?,?)").bind(id(),userId,await digest(token),new Date(Date.now()+30*86400000).toISOString(),time).run();
    return json({ user: { id:userId,email,display_name:displayName } }, 201, { "set-cookie": cookie(token,30*86400) });
  }
  if (path === "/api/auth/login" && method === "POST") {
    const b = await body(request), email = String(b.email || "").trim().toLowerCase(), password = String(b.password || "");
    const user = await env.DB.prepare("SELECT id,email,password_hash,password_salt,display_name FROM users WHERE email=?").bind(email).first<any>();
    if (!user || await passwordHash(password,user.password_salt) !== user.password_hash) return json({ error: "이메일 또는 비밀번호가 올바르지 않습니다." }, 401);
    const token = randomToken(), time = now();
    await env.DB.prepare("INSERT INTO sessions(id,user_id,token_hash,expires_at,created_at) VALUES(?,?,?,?,?)").bind(id(),user.id,await digest(token),new Date(Date.now()+30*86400000).toISOString(),time).run();
    return json({ user: { id:user.id,email:user.email,display_name:user.display_name } }, 200, { "set-cookie": cookie(token,30*86400) });
  }
  if (path === "/api/auth/logout" && method === "POST") {
    const token = readCookie(request,"hs12_session");
    if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash=?").bind(await digest(token)).run();
    return json({ ok:true },200,{ "set-cookie": cookie("",0) });
  }
  if (path === "/api/public/articles" && method === "GET") {
    const { results } = await env.DB.prepare(`SELECT id,title,slug,summary,topic,keyword,content_json,image_urls_json,tags_json,status,published_at,created_at,updated_at FROM articles WHERE status='published' ORDER BY published_at DESC LIMIT 60`).all();
    return json({ items: results.map(articleRow) }, 200, { "cache-control": "public, max-age=30" });
  }
  const user = await auth(request,env);
  if (path === "/api/auth/me" && method === "GET") return json({ user });
  if (!user) return json({ error: "로그인이 필요합니다." },401);

  if (path === "/api/images" && method === "GET") {
    const { results } = await env.DB.prepare("SELECT * FROM images WHERE user_id=? ORDER BY created_at DESC").bind(user.id).all();
    return json({ items: results });
  }
  if (path === "/api/images" && method === "POST") {
    const b=await body(request), imageUrl=String(b.imageUrl||"").trim(), title=String(b.title||"").trim();
    if (!/^https:\/\//i.test(imageUrl) || !title) return json({error:"제목과 HTTPS 이미지 주소를 입력하세요."},400);
    const imageId=id();
    await env.DB.prepare("INSERT INTO images(id,user_id,title,image_url,category,tags_json,alt_text,created_at) VALUES(?,?,?,?,?,?,?,?)").bind(imageId,user.id,title,imageUrl,String(b.category||"라이프스타일"),JSON.stringify(Array.isArray(b.tags)?b.tags:[]),String(b.altText||title),now()).run();
    return json({id:imageId},201);
  }
  const imageMatch=path.match(/^\/api\/images\/([^/]+)$/);
  if(imageMatch && method==="DELETE"){await env.DB.prepare("DELETE FROM images WHERE id=? AND user_id=?").bind(imageMatch[1],user.id).run();return json({ok:true});}

  if(path==="/api/articles" && method==="GET"){
    const {results}=await env.DB.prepare(`SELECT ${articleSelect} FROM articles WHERE user_id=? ORDER BY updated_at DESC`).bind(user.id).all();
    return json({items:results.map(articleRow)});
  }
  if(path==="/api/articles" && method==="POST"){
    const b=await body(request), articleId=id(), title=String(b.title||"제목 없는 원고"), slug=safeSlug(String(b.slug||title))+"-"+articleId.slice(0,6), time=now();
    await env.DB.prepare("INSERT INTO articles(id,user_id,title,slug,summary,topic,keyword,tone,audience,content_json,image_urls_json,tags_json,status,created_at,updated_at,revision) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)").bind(articleId,user.id,title,slug,String(b.summary||""),String(b.topic||""),String(b.keyword||""),String(b.tone||""),String(b.audience||""),JSON.stringify(b.content||{}),JSON.stringify(b.imageUrls||[]),JSON.stringify(b.tags||[]),"draft",time,time).run();
    return json({id:articleId,slug},201);
  }
  const articleMatch=path.match(/^\/api\/articles\/([^/]+)(\/publish)?$/);
  if(articleMatch){
    const articleId=articleMatch[1], row=await env.DB.prepare(`SELECT ${articleSelect} FROM articles WHERE id=? AND user_id=?`).bind(articleId,user.id).first<any>();
    if(!row)return json({error:"원고를 찾을 수 없습니다."},404);
    if(method==="GET")return json({article:articleRow(row)});
    if(method==="DELETE"){await env.DB.prepare("DELETE FROM articles WHERE id=? AND user_id=?").bind(articleId,user.id).run();return json({ok:true});}
    if(method==="PATCH" && !articleMatch[2]){
      const b=await body(request), revision=Number(b.revision);
      if(revision && revision!==row.revision)return json({error:"다른 변경사항이 먼저 저장됐습니다. 새로고침 후 다시 시도하세요."},409);
      await env.DB.prepare("UPDATE articles SET title=?,summary=?,topic=?,keyword=?,tone=?,audience=?,content_json=?,image_urls_json=?,tags_json=?,updated_at=?,revision=revision+1 WHERE id=? AND user_id=?").bind(String(b.title||row.title),String(b.summary||""),String(b.topic||""),String(b.keyword||""),String(b.tone||""),String(b.audience||""),JSON.stringify(b.content||{}),JSON.stringify(b.imageUrls||[]),JSON.stringify(b.tags||[]),now(),articleId,user.id).run();
      return json({ok:true});
    }
    if(method==="POST" && articleMatch[2]){
      const parsed=articleRow(row);
      if(parsed.content?.review?.verdict==="hold")return json({error:"검수 보류 상태입니다. 문제를 수정한 뒤 발행하세요."},400);
      await env.DB.prepare("UPDATE articles SET status='published',published_at=?,updated_at=?,revision=revision+1 WHERE id=? AND user_id=?").bind(now(),now(),articleId,user.id).run();
      return json({ok:true,slug:row.slug});
    }
  }

  if(path==="/api/agent/threads" && method==="GET"){
    const {results}=await env.DB.prepare("SELECT id,title,created_at,updated_at FROM agent_threads WHERE user_id=? ORDER BY updated_at DESC").bind(user.id).all();
    return json({items:results});
  }
  const threadMatch=path.match(/^\/api\/agent\/threads\/([^/]+)$/);
  if(threadMatch && method==="GET"){
    const thread=await env.DB.prepare("SELECT id,title FROM agent_threads WHERE id=? AND user_id=?").bind(threadMatch[1],user.id).first();
    if(!thread)return json({error:"대화를 찾을 수 없습니다."},404);
    const {results}=await env.DB.prepare("SELECT id,role,content,action_json,created_at FROM agent_messages WHERE thread_id=? AND user_id=? ORDER BY created_at ASC").bind(threadMatch[1],user.id).all();
    return json({thread,messages:results});
  }
  if(path==="/api/agent/run" && method==="POST"){
    const b=await body(request), threadId=String(b.threadId||id()), message=String(b.message||"").trim();
    if(!message)return json({error:"요청 내용을 입력하세요."},400);
    let thread=await env.DB.prepare("SELECT id FROM agent_threads WHERE id=? AND user_id=?").bind(threadId,user.id).first();
    if(!thread){await env.DB.prepare("INSERT INTO agent_threads(id,user_id,title,created_at,updated_at) VALUES(?,?,?,?,?)").bind(threadId,user.id,message.slice(0,70),now(),now()).run();}
    await env.DB.prepare("INSERT INTO agent_messages(id,thread_id,user_id,role,content,created_at) VALUES(?,?,?,?,?,?)").bind(id(),threadId,user.id,"user",message,now()).run();
    const history=await env.DB.prepare("SELECT role,content FROM agent_messages WHERE thread_id=? AND user_id=? ORDER BY created_at DESC LIMIT 16").bind(threadId,user.id).all();
    const instruction=`당신은 HubStudio 12의 편집장 겸 실행형 블로그 에이전트입니다. 사용자의 한국어 요청을 이해하고 아래 JSON으로 답하세요. 가능한 action은 generate, plan, review, rewrite, replace_images, publish, list, reply 입니다. 확실히 원고 생성 요청이면 generate, 기획이면 plan, 검수면 review, 수정이면 rewrite, 이미지 교체면 replace_images, 발행이면 publish, 보관함 조회면 list. 기존 글이 필요하면 articleId를 요청하세요. 형식: {"action":"...","reply":"사용자에게 보여줄 짧은 설명","topic":"주제","articleId":"","instruction":"","tone":"...","audience":"...","keyword":"..."}`;
    let decision:any;
    try{decision=await gemini(env,JSON.stringify((history.results||[]).reverse()),instruction,true);}catch(e){decision={action:"reply",reply:e instanceof Error?e.message:"AI 처리 실패"};}
    let result:any=null, reply=String(decision.reply||"요청을 처리했습니다.");
    const action=String(decision.action||"reply");
    if(action==="generate"||action==="plan"){
      const images=await env.DB.prepare("SELECT title,image_url,category,alt_text FROM images WHERE user_id=? ORDER BY created_at DESC LIMIT 12").bind(user.id).all();
      const prompt=`주제: ${decision.topic||message}\n이미지 참고: ${JSON.stringify(images.results||[])}\n문체: ${decision.tone||"세련된 매거진"}\n독자: ${decision.audience||"일반 독자"}\n키워드: ${decision.keyword||decision.topic||message}\n한국어로 풍부한 SEO 매거진 원고를 생성. 이미지 주소는 제공된 주소만 사용하고 임의 생성하지 마세요. JSON: {"title":"","summary":"","intro":"","sections":[{"heading":"","body":"","imageUrl":"","caption":"","alt":""}],"closing":"","faq":[{"question":"","answer":""}],"tags":[]}`;
      try{
        result=await gemini(env,prompt,"당신은 한국어 프리미엄 매거진의 수석 에디터입니다. 사실을 꾸며내지 말고 구조가 풍부한 완성 원고를 작성하세요.",true);
        if(action==="generate"){
          const articleId=id(),title=String(result.title||decision.topic||message),slug=safeSlug(title)+"-"+articleId.slice(0,6),time=now();
          await env.DB.prepare("INSERT INTO articles(id,user_id,title,slug,summary,topic,keyword,tone,audience,content_json,image_urls_json,tags_json,status,created_at,updated_at,revision) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)").bind(articleId,user.id,title,slug,String(result.summary||""),String(decision.topic||message),String(decision.keyword||""),String(decision.tone||""),String(decision.audience||""),JSON.stringify(result),JSON.stringify([]),JSON.stringify(result.tags||[]),"draft",time,time).run();
          result.articleId=articleId;result.slug=slug;reply+=`\n\n초안을 생성해 내 보관함에 저장했습니다: ${title}`;
        }else reply+=`\n\n기획안: ${result.title||""}`;
      }catch(e){reply=e instanceof Error?e.message:"생성 실패";}
    }else if(["review","rewrite","publish"].includes(action)&&decision.articleId){
      const row=await env.DB.prepare("SELECT * FROM articles WHERE id=? AND user_id=?").bind(decision.articleId,user.id).first<any>();
      if(!row)reply="해당 원고를 찾을 수 없습니다.";
      else if(action==="publish"){await env.DB.prepare("UPDATE articles SET status='published',published_at=?,updated_at=? WHERE id=? AND user_id=?").bind(now(),now(),row.id,user.id).run();reply="원고를 공개 웹진에 발행했습니다.";}
      else if(action==="review"){
        const contentObj=JSON.parse(row.content_json||"{}");
        const review=await gemini(env,JSON.stringify(contentObj),"원고의 논리, 문장, 사실성, SEO, 구성 품질을 엄격히 검수하세요. JSON: {verdict:'pass'|'needs_changes'|'hold',score:0,summary:'',issues:[{section:'',problem:'',suggestion:''}]}");
        contentObj.review=review;await env.DB.prepare("UPDATE articles SET content_json=?,updated_at=?,revision=revision+1 WHERE id=?").bind(JSON.stringify(contentObj),now(),row.id).run();result=review;reply=review.summary||"검수를 완료했습니다.";
      }else{
        const current=JSON.parse(row.content_json||"{}");
        const revised=await gemini(env,JSON.stringify({content:current,instruction:decision.instruction||message}),"사용자 수정 지시를 원고에 반영하세요. 기존 구조와 유효한 이미지 URL을 유지하고 완성된 원고 JSON을 반환하세요.");
        await env.DB.prepare("UPDATE articles SET title=?,summary=?,content_json=?,updated_at=?,revision=revision+1 WHERE id=?").bind(String(revised.title||row.title),String(revised.summary||row.summary),JSON.stringify(revised),now(),row.id).run();result=revised;reply="수정 원고를 저장했습니다.";
      }
    }else if(action==="replace_images"&&decision.articleId){
      const row=await env.DB.prepare("SELECT * FROM articles WHERE id=? AND user_id=?").bind(decision.articleId,user.id).first<any>();
      if(!row)reply="해당 원고를 찾을 수 없습니다.";
      else{
        const assets=await env.DB.prepare("SELECT title,image_url,category,alt_text FROM images WHERE user_id=? ORDER BY created_at DESC LIMIT 30").bind(user.id).all();
        const contentObj=JSON.parse(row.content_json||"{}");
        const mapped=await gemini(env,JSON.stringify({content:contentObj,availableImages:assets.results||[]}),"각 섹션에 가장 어울리는 이미지를 availableImages 목록에서만 선택하세요. URL을 새로 만들지 마세요. JSON 객체의 sections 배열에 index, imageUrl, alt, caption을 반환하세요.");
        for(const item of mapped.sections||[]){const section=(contentObj.sections||[])[Number(item.index)];if(section&&(assets.results||[]).some((x:any)=>x.image_url===item.imageUrl)){section.imageUrl=item.imageUrl;section.alt=item.alt||section.heading;section.caption=item.caption||"";}}
        await env.DB.prepare("UPDATE articles SET content_json=?,updated_at=?,revision=revision+1 WHERE id=?").bind(JSON.stringify(contentObj),now(),row.id).run();
        result=mapped;reply="등록된 이미지 자산을 본문 문맥에 맞춰 배치하고 저장했습니다.";
      }
    }else if(action==="list"){
      const {results}=await env.DB.prepare("SELECT id,title,status,updated_at FROM articles WHERE user_id=? ORDER BY updated_at DESC LIMIT 10").bind(user.id).all();result=results;reply="최근 보관함 원고 목록입니다.";
    }
    const jobId=id(),time=now();
    await env.DB.prepare("INSERT INTO agent_jobs(id,thread_id,user_id,action,status,result_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").bind(jobId,threadId,user.id,action,"done",JSON.stringify(result),time,time).run();
    await env.DB.prepare("INSERT INTO agent_messages(id,thread_id,user_id,role,content,action_json,created_at) VALUES(?,?,?,?,?,?,?)").bind(id(),threadId,user.id,"assistant",reply,JSON.stringify({action,jobId,result}),now()).run();
    await env.DB.prepare("UPDATE agent_threads SET updated_at=? WHERE id=? AND user_id=?").bind(now(),threadId,user.id).run();
    return json({threadId,jobId,action,reply,result});
  }
  return json({error:"요청한 API를 찾을 수 없습니다."},404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url=new URL(request.url);
    try {
      if(url.pathname.startsWith("/api/")) return await handleApi(request,env);
      if(url.pathname.startsWith("/blog/") && request.method==="GET"){
        const slug=decodeURIComponent(url.pathname.slice(6));
        const row=await env.DB.prepare(`SELECT ${articleSelect} FROM articles WHERE slug=? AND status='published'`).bind(slug).first<any>();
        if(!row)return new Response("게시글을 찾을 수 없습니다.",{status:404,headers:{"content-type":"text/plain; charset=utf-8"}});
        const article=articleRow(row), html=await env.ASSETS.fetch(new Request(new URL("/",request.url)));
        const page=await html.text();
        const escaped=String(article.title).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
        const desc=String(article.summary||"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
        return new Response(page.replace("</head>",`<title>${escaped} | HUBSTUDIO 12</title><meta name="description" content="${desc}"><link rel="canonical" href="${env.SITE_URL||url.origin}/blog/${encodeURIComponent(slug)}"><meta property="og:title" content="${escaped}"><meta property="og:description" content="${desc}"></head>`).replace('<body>',`<body><script>window.__HS12_PUBLIC_ARTICLE__=${JSON.stringify(article).replace(/</g,"\\\\u003c")};</script>`),{headers:{"content-type":"text/html; charset=utf-8","cache-control":"public, max-age=60"}});
      }
      return env.ASSETS.fetch(request);
    } catch(error) {
      return json({error:error instanceof Error?error.message:"서버 오류가 발생했습니다."},500);
    }
  }
};
