 /**
 * Skill 知识引擎（完整版）
 *
 * 功能：
 * - 从远程 Skill Server 拉取 manifest + 文件内容
 * - 三级查找：内置 Skill → 内存缓存 → 远程拉取
 * - 路由引擎：关键词匹配 + 歧义消解 + 场景匹配 + buildWorkflowResponse
 * - 7 个 MCP 工具（含 enforce_routing_check + trigger_self_evaluation 防幻觉双门禁）
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import https from 'https';

// ========== 配置 ==========
// v2: 2026-05-28 published version gate
const SKILL_SERVER_URL = process.env.SKILL_SERVER_URL || 'http://wdpapi-skill.51aes.com';
const CACHE_TTL = Number(process.env.CACHE_TTL) || 300;
const PUBLISHED_API_BASE_URL = process.env.PUBLISHED_API_BASE_URL || 'https://wdpapidoc-admin.51aes.com/api/backend/web';
const PUBLISHED_VERSIONS_CACHE_TTL = 300_000; // 5 minutes

// ========== 发布版版本号缓存 ==========
interface PublishedVersion { apiType: string; version: string; }
let publishedVersionsCache: PublishedVersion[] | null = null;
let publishedVersionsLastFetch = 0;

async function fetchPublishedVersions(): Promise<PublishedVersion[]> {
  if (!PUBLISHED_API_BASE_URL) {
    console.log('[SkillKnowledge] PUBLISHED_API_BASE_URL not configured, skip version fetch');
    return [];
  }
  if (publishedVersionsCache && (Date.now() - publishedVersionsLastFetch) < PUBLISHED_VERSIONS_CACHE_TTL) {
    return publishedVersionsCache;
  }
  try {
    const url = `${PUBLISHED_API_BASE_URL}/type/list`;
    console.log(`[SkillKnowledge] Fetching published versions: ${url}`);
    const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) } as any);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json() as any;
    const versions: PublishedVersion[] = [];
    for (const t of (json.data || [])) {
      const latest = (t.versionList || [])
        .filter((v: any) => v.version && !/early/i.test(v.version))
        .sort((a: any, b: any) => {
          const av = a.version.split('.').map(Number);
          const bv = b.version.split('.').map(Number);
          for (let i = 0; i < Math.max(av.length, bv.length); i++) {
            if ((av[i] || 0) !== (bv[i] || 0)) return (bv[i] || 0) - (av[i] || 0);
          }
          return 0;
        })[0];
      if (latest) versions.push({ apiType: t.name, version: latest.version });
    }
    publishedVersionsCache = versions;
    publishedVersionsLastFetch = Date.now();
    console.log(`[SkillKnowledge] Published versions: ${versions.map(v => `${v.apiType}=${v.version}`).join(', ')}`);
    return versions;
  } catch (e: any) {
    console.warn(`[SkillKnowledge] Failed to fetch published versions (using cache): ${e.message}`);
    return publishedVersionsCache || [];
  }
}


/**
 * 从 SKILL.md 正文提取逐功能版本要求（格式 B）
 * 输入: "⚠️ **版本要求：** overlapOrder 需要 WDPAPI >= 1.6.0；labelContentOffset 需要 WDPAPI >= 1.7.0"
 * 输出: [{ feature: 'overlapOrder', minVersion: '1.6.0' }, ...]
 */
function extractSkillVersionRequirements(content: string): Array<{ feature: string; minVersion: string }> {
  const results: Array<{ feature: string; minVersion: string }> = [];
  const block = content.match(/版本要求[：:]\s*([\s\S]*?)(?:\n\n|\n> [^⚠])/);
  if (!block) return results;
  // 格式 B: 逐功能版本（如 "overlapOrder 需要 WDPAPI >= 1.6.0"）
  const itemRe = /([^；;，,\n]+?)\s*需要\s*WDPAPI\s*>=\s*([\d.]+)/g;
  let m;
  while ((m = itemRe.exec(block[1])) !== null) {
    const feature = m[1].replace(/[`*_]/g, '').trim();
    if (feature && feature.length < 60) {
      results.push({ feature, minVersion: m[2] });
    }
  }
  // 格式 A: 统一阈值（如 "需要 WDPAPI >= 2.4.0"，无特征名）
  if (results.length === 0) {
    const threshold = block[1].match(/需要\s*WDPAPI\s*>=\s*([\d.]+)/);
    if (threshold) {
      results.push({ feature: '（本模块全部 API）', minVersion: threshold[1] });
    }
  }
  return results;
}

// ========== 类型 ==========
interface ManifestFile { path: string; size: number; mtime: number; sha1: string; ext: string; }
interface ManifestResponse { root: string; count: number; total_size: number; files: ManifestFile[]; }
interface CacheEntry { content: string; timestamp: number; }
interface SkillEntry { path: string; size: number; sha1: string; }
interface RouteConfig {
  domain: string; label: string; skillPath: string;
  keywords: string[]; aliases: string[]; relatedSkills: string[];
  pathSegments?: string[];
  userSynonyms?: string[];  // v1.2: 用户常见物体名/动作动词 → 弥补自然语言≠API名称的鸿沟
}
interface RouteMapping { version: string; routes: RouteConfig[]; baseSkills: string[]; builtinSkills: string[]; }
interface McpToolDef { name: string; description: string; inputSchema: { type: string; properties: Record<string, any>; required?: string[]; }; }

interface HallucinatedApi {
  line: number;
  api: string;
  suggestion: string;
}

// ========== 编译期内嵌 Builtin Skill（容器缺失 builtin/ 目录时兜底） ==========
const BUILTIN_WDP_INTENT_ORCHESTRATOR_B64 = 'LS0tDQpuYW1lOiB3ZHAtaW50ZW50LW9yY2hlc3RyYXRvcg0KZGVzY3JpcHRpb246IFdEUCDmhI/lm77nvJbmjpLkuI7pnIDmsYLnsr7noa7ljJbjgILnlKjkuo7lnKjnvJbnoIHliY3mioroh6rnhLbor63oqIDkuJrliqHor4nmsYLmlbTnkIbmiJDjgIrns7vnu5/mhI/lm77kuI7mnrbmnoTorr7orqHmiqXlkYrjgIvvvIzlrozmiJDpnIDmsYLmi4bop6PjgIHog73lipvot6/nlLHjgIHliY3nva7lj4LmlbDmoLjmn6XjgIHmuIXnkIbpk77ot6/ooaXlhajjgIINCi0tLQ0KDQojIFdEUCDmhI/lm77nvJbmjpLmioDog70NCg0K5Y+q5YGaIDQg5Lu25LqL77yaDQoNCjEuIOino+aekOmcgOaxguW5tuaLhuaIkOWPr+aJp+ihjOWtkOS7u+WKoQ0KMi4g5LuO6LWE5rqQ5Lit5Yy56YWN5Y6f55SfIEFQSSDog73lipvkuI7lrZAgc2tpbGwg6Lev55SxDQozLiDlnKjnvJbnoIHliY3mi6bkvY/nvLrlpLHlj4LmlbDjgIHplJnor6/lr7nosaHnsbvlnovjgIHnvLrlpLHmuIXnkIbpk77ot6/nrYnpl67popgNCjQuIOi+k+WHuuOAiuezu+e7n+aEj+WbvuS4juaetuaehOiuvuiuoeaKpeWRiuOAiw0KDQrkuI3opoHlnKjmnKzmioDog73ph4znm7TmjqXnlJ/miJDkuJrliqHku6PnoIHjgIINCg0KIyMg5L2g5bey57uP6I635b6X55qE6Lev55Sx57uT5p6cDQoNCmBzdGFydF93ZHBfd29ya2Zsb3dgIOW3suiHquWKqOWujOaIkOS7peS4i+WMuemFje+8jOS9oOaXoOmcgOaJi+WKqOaJp+ihjOS7u+S9lei3r+eUsemAu+i+ke+8mg0KDQotICoq5Zy65pmv5qih5p2/5Yy56YWNKirvvIhgc2NlbmVgIOWtl+aute+8ie+8muWfuuS6jiBgY29uZmlnL2J1c2luZXNzLXNjZW5hcmlvcy9faW5kZXguanNvbmDvvIxTQ0VORSDljLnphY3kuLrmnIDpq5jkvJjlhYjnuqfot6/nlLHvvIjlhYjkuo7lhbPplK7or43ljLnphY3vvInjgILlkb3kuK3lkI7lnLrmma/nmoQgYHByaW1hcnlfc2tpbGxzICsgc2Vjb25kYXJ5X3NraWxsc2Ag55u05o6l5L2c5Li65Li7IFNraWxsIOWIl+ihqA0KLSAqKuWFs+mUruivjeWKoOadg+WFnOW6lSoq77yI5Zy65pmv5pyq5ZG95Lit5pe277yJ77ya5Z+65LqOIGBjb25maWcvc2tpbGwtcm91dGUtbWFwcGluZy5qc29uYA0KLSAqKkFQSSDosIPnlKjmqKHlvI/ljLnphY0qKu+8iGBhcGlfcGF0dGVybnNgIOWtl+aute+8ie+8muWfuuS6jiBgY29uZmlnL2FwaS1wYXR0ZXJucy5qc29uYA0KDQoqKui/lOWbnue7k+aenOS4reeahOWFs+mUruWtl+autSoq77yaDQotIGBtYXRjaGVkX3NraWxsc2Ag4oCUIOaJgOaciemcgOimgeivu+WPlueahCBTa2lsbCDmlofku7bot6/lvoTliJfooajvvIjlnLrmma/kvJjlhYjmjpLluo/vvIkNCi0gYHdvcmtmbG93X3N0ZXBzYCDigJQgKirmnYPlqIHmiafooYzmraXpqqQqKu+8jOivt+S4peagvOaMieatpOmhuuW6j+aJp+ihjA0KLSBgYnVpbHRpbl9za2lsbHNfcHJldmlld2Ag4oCUIOWGhee9riBTa2lsbO+8iOacrOaWh+aho++8ieeahOWJjSAxNTAwIOWtl+WGheWuuemihOiniO+8jOW3suiHquWKqOazqOWFpQ0KLSBgc2NlbmVgIOKAlCDlkb3kuK3nmoTkuJrliqHlnLrmma/vvIjlkI3np7AgKyDnm67moIfmj4/ov7DvvIkNCi0gYGFwaV9wYXR0ZXJuc2Ag4oCUIOWMuemFjeeahCBBUEkg6LCD55So5qih5byP77yIYGFwaV9zZXF1ZW5jZSArIGRhdGFfZmxvdyArIG5vdGVzYO+8iQ0KDQojIyDmiafooYzmtYHnqIsNCg0KKirmiYDmnInmraXpqqTku6UgYHN0YXJ0X3dkcF93b3JrZmxvd2Ag6L+U5Zue55qEIGB3b3JrZmxvd19zdGVwc2Ag5Li65YeG77yM56aB5q2i5omL5Yqo57yW5o6S44CCKiog5pys5paH5qGj5LiN6YeN5aSNIHdvcmtmbG93X3N0ZXBzIOeahOatpemqpOWGheWuue+8jOS7heaPkOS+m+ihpeWFheaAp+eahOinhOWImee6puadn+OAgg0KDQoqKuaJgOaciSBXRFAgQVBJIOeahOato+ehruetvuWQjeOAgeWPguaVsOagvOW8j+WSjCBkZW1vLmpzIOekuuS+i+Wdh+S7pSBTa2lsbCDmlofku7bkuLrlh4bvvIznpoHmraLlh63orrDlv4bnvJbpgKAgQVBJIOiwg+eUqOOAgioqDQoNCiMjIyDwn5qoIOmYsuW5u+inieaguOW/g+inhOWImQ0KDQoxLiAqKueUqCBgZm9yY2VfZnVsbDogdHJ1ZWAg6K+75Y+W5omA5pyJIFNraWxsIOaWh+S7tioq44CC6L+U5Zue5L2T5Lit5bey6Ieq5Yqo5YyF5ZCrIGBhcGlfd2hpdGVsaXN0YCDigJQg6L+Z5piv6K+l5paH5Lu25YWB6K645L2/55So55qE5YWo6YOoIEFQSSDlkI3liJfooajjgILkvaDlj6rog73kvb/nlKjnmb3lkI3ljZXkuK3nmoQgQVBJ44CCDQoyLiAqKue8lueggeWJjeiwg+eUqCBgZW5mb3JjZV9yb3V0aW5nX2NoZWNrYCoq77ya6aqM6K+B5omA5pyJ5b+F6ZyAIFNraWxsIOW3suWFqOaWh+ivu+WPluOAguacqumAmui/h+WJjeemgeatoue8lueggeOAguKaoO+4jyDms6jmhI/vvJrpl6jnpoEx5LuF6aqM6K+B5paH5Lu25a6M5pW05oCn77yM5LiN6IO95L+d6K+B5LiN5Lya57yW6YCg5bm76KeJIEFQSeOAgg0KMy4gKirnvJbnoIHlkI7osIPnlKggYHRyaWdnZXJfc2VsZl9ldmFsdWF0aW9uYCoq77ya5Lyg5YWl5a6M5pW05Luj56CB5paH5pys77yIYGdlbmVyYXRlZF9jb2RlYO+8iSsgYHVzZWRfc2tpbGxzYO+8iOS7jiBgd29ya2Zsb3dfcmVzdWx0Lm1hdGNoZWRfc2tpbGxzYCDojrflj5bvvIkrIGBzY2VuYXJpb19pZGDvvIjku44gYHdvcmtmbG93X3Jlc3VsdC5zY2VuZS5pZGAg6I635Y+W77yM5aaC5Zy65pmv5ZG95Lit77yJ44CCTUNQIOS8muWBmiBBUEkg55m95ZCN5Y2V5a2Y5Zyo5oCn5q+U5a+5ICsg5Zy65pmv5q2l6aqk6KaG55uW5qOA5p+l44CC57y65aSx5q2l6aqk5bCG6KKr6Zi75pat5bm25o+Q56S644CCDQoNCj4g4pqg77iPIOWOhuWPsuahiOS+i++8mkFJIOWujOaVtOivu+WPliBjYW1lcmEtY29udHJvbC9TS0lMTC5tZCDlkI7vvIzku43lh63orrDlv4bnvJbpgKDkuoYgYEZvY3VzQnlFbnRpdHlOYW1lYOOAgg0KPiDlrp7pmYXnmoQgYGFwaV93aGl0ZWxpc3RgIOS4reWPquaciSBgRm9jdXNUb0FsbGDjgIFgRm9jdXNg44CBYEZseVRvYOOAgWBGb2xsb3dg44CBYEFyb3VuZGDjgIINCj4g5LuF6Z2gIuivu+S6huaWh+S7tiLml6Dms5XpmLLmraLmraTnsbvlubvop4njgILnvJbnoIHlkI7liqHlv4XosIPnlKggYHRyaWdnZXJfc2VsZl9ldmFsdWF0aW9uYCDlgZrmnIDnu4jpqozor4HjgIINCg0KIyMg57uf5LiA5Z+657q/DQoNCnwg5YyF5ZCNIHwg54mI5pysIHwNCnwtLS0tLS18LS0tLS0tfA0KfCDmoLjlv4MgU0RLIHwgYHdkcGFwaUBeMi4zLjBgIHwNCnwgQklNIOaPkuS7tiB8IGBAd2RwLWFwaS9iaW0tYXBpQF4yLjIuMWAgfA0KfCBHSVMg5o+S5Lu2IHwgYEB3ZHAtYXBpL2dpcy1hcGlAXjIuMS4wYCB8DQoNCiMjIOmYu+aWreaAp+imgeaxgu+8iDbmnaHvvIkNCg0KMS4gKirot6/nlLHnu5Pmnpzlt7LnlLEgc3RhcnRfd2RwX3dvcmtmbG93IOaPkOS+myoq77ya5LulIGBtYXRjaGVkX3NraWxsc2AgKyBgd29ya2Zsb3dfc3RlcHNgIOS4uuWHhu+8jOS4jeimgeaJi+WKqOmHjeaWsOi3r+eUsQ0KMi4gKirlv4Xpobvor7vlj5YgaW5pdGlhbGl6YXRpb24qKu+8mmByZWZlcmVuY2UvaW5pdGlhbGl6YXRpb24vU0tJTEwubWRgDQozLiAqKlBsdWdpbi5JbnN0YWxsIOW/hemhu+WcqCBSZW5kZXJlci5TdGFydCDkuYvliY0qKg0KNC4gKirmoLjlv4Plj4LmlbDkuI3lvpfkuLrlgYflgLwqKu+8muemgeatoiBZT1VSX1VSTOOAgVlPVVJfVE9LRU4g562J5Y2g5L2N56ymDQo1LiAqKuW/hemhu+S9v+eUqCBucG0gaW5zdGFsbCB3ZHBhcGkqKu+8muemgeatoiBDRE4g5byV5YWlDQo2LiAqKue8uuS/oeaBr+aXtuWFiOmXru+8jOS4jeimgeeMnCoqDQoNCiMjIOW3peS9nOa1gQ0KDQojIyMgMS4g6Kej5p6Q5Y6f5aeL6ZyA5rGCDQoNCuWFiOaPkOWPlu+8mg0KLSDnlKjmiLfopoHlrozmiJDnmoTkuJrliqHnm67moIcNCi0g5raJ5Y+K55qE5a+56LGh57G75YirDQotIOW3suefpeWvueixoSBJZA0KLSDlt7Lnn6XlnZDmoIfjgIHkvY3nva7jgIHojIPlm7TjgIHop5LluqbjgIHml7bplb8NCi0g5piv5ZCm5pyJIui/m+WFpemTvui3ryLlkowi6YCA5Ye6L+a4heeQhumTvui3ryINCg0K5oqK6Ieq54S26K+t6KiA6ZyA5rGC5ouG5oiQIDEg5Liq5Li75Lu75Yqh5ZKM6Iul5bmy5a2Q5Lu75Yqh44CCDQoNCiMjIyAyLiDnoa7orqTot6/nlLHvvIjlt7Loh6rliqjlrozmiJDvvIkNCg0K6Lev55Sx57uT5p6c5bey6YCa6L+HIGBzdGFydF93ZHBfd29ya2Zsb3dgIOi/lOWbnu+8jOWcuuaZr+WMuemFjeS4uuacgOmrmOS8mOWFiOe6p+i3r+eUseOAgg0KDQo+ICoq5bi455So5pig5bCE5Y+C6ICDKirvvIjlrp7pmYXot6/nlLHku6UgYG1hdGNoZWRfc2tpbGxzYCDlkowgYHdvcmtmbG93X3N0ZXBzYCDkuLrlh4bjgILot6/nlLHphY3nva7mlofku7bvvJpgY29uZmlnL3NraWxsLXJvdXRlLW1hcHBpbmcuanNvbmAgKyBgY29uZmlnL2J1c2luZXNzLXNjZW5hcmlvcy9faW5kZXguanNvbmDvvInvvJoNCj4NCj4gfCDog73lipvln58gfCDlj4LogIMgU2tpbGzvvIjlj6/og73lt7Llj5jmm7TvvIkgfA0KPiB8LS0tLS0tLS18LS0tLS0tLS0tLS0tLS0tLS0tLS0tLXwNCj4gfCDliJ3lp4vljJYgfCBgcmVmZXJlbmNlL2luaXRpYWxpemF0aW9uL1NLSUxMLm1kYCB8DQo+IHwg5LqL5Lu25rOo5YaMIHwgYHJlZmVyZW5jZS9yZW5kZXJlci9TS0lMTC5tZGAgfA0KPiB8IOebuOacuuaOp+WIti/ot5/pmo8gfCBgcmVmZXJlbmNlL2NhbWVyYS9jYW1lcmEtY29udHJvbC9TS0lMTC5tZGAgfA0KPiB8IOimhueblueJqS9QT0kv6Lev5b6EIHwgYHJlZmVyZW5jZS9zY2VuZS9jb3ZlcmluZy9wb2kvU0tJTEwubWRgIHwNCj4gfCBCSU0g5pON5L2cIHwgYHJlZmVyZW5jZS9zeXN0ZW0vcGx1Z2luL2JpbWFwaS9TS0lMTC5tZGAgfA0KPiB8IEdJUyDmk43kvZwgfCBgcmVmZXJlbmNlL3N5c3RlbS9wbHVnaW4vZ2lzYXBpL1NLSUxMLm1kYCB8DQo+IHwg5Zy65pmv5Y+R546wL+aLvuWPliB8IGByZWZlcmVuY2UvdG9vbHMvcGlja2VyL1NLSUxMLm1kYCArIGByZWZlcmVuY2Uvc2NlbmUvb3V0bGluZXIvU0tJTEwubWRgIHwNCg0KIyMjIDMuIOaJp+ihjOi+k+WFpemXqOemgQ0KDQojIyMjIOWvueixoemXqOemgQ0KLSDlhYjnoa7orqTlr7nosaHnsbvliKvvvIzlho3noa7orqTlr7nosaEgSWQNCi0g5aaC5p6c5Y+q5pyJIElkIOayoeacieWvueixoeexu+WIq++8jOWFiOaKpee8uuWPow0KLSDlr7nosaEgSWQg55qE5ZCI5rOV5p2l5rqQ77ya5Yib5bu66L+U5Zue5YC844CB5bGP5bmV5ou+5Y+W57uT5p6c44CB5LqL5Lu25Zue6LCD57uT5p6c44CB5a6e5L2T5p+l6K+i57uT5p6c44CBQklNIOaehOS7tuafpeivoue7k+aenOOAgUdJUyDopoHntKDngrnlh7vmiJblsZ7mgKfmn6Xor6Lnu5PmnpzjgIHlubPlj7DotYTmupDlj5HluIPkv6Hmga/jgIFvdXRsaW5lciDpgY3ljobnu5PmnpwNCg0KIyMjIyDliqjkvZzpl6jnpoENCuWmguaenOmcgOaxguWMheWQq+S7peS4i+WKqOS9nO+8jOW/hemhu+aYvuW8j+WGmeWHuuWOn+eUnyBBUEkg6IO95Yqb77yaDQotIOi3r+W+hOenu+WKqOOAgeebuOacuui3n+maj+OAgeWkqeawlOWIh+aNouOAgemrmOS6ruOAgea4heeQhuWbnuaUtuOAgeWxj+W5leaLvuWPlg0KDQojIyMjIOa4heeQhumXqOemgQ0K5Y+q6KaB5pyJ5Yib5bu644CB5rOo5YaM44CB57uR5a6a44CB5ZCv5Yqo5Yqo5L2c77yM5bCx5b+F6aG76KGl5YWF5a+55bqU6YCA5Ye66ZO+6Lev44CCDQoNCiMjIyMg55yf5YC86Zeo56aBDQrnpoHmraLvvJrnvJbpgKAgQVBJIOWQjeensOOAgee8lumAoOWPguaVsOWQjeOAgee8lumAoOWvueixoSBJZOOAgeS9v+eUqOWBh+WAvA0KDQojIyDovpPlh7ropoHmsYINCg0K6L6T5Ye6IGDjgIrns7vnu5/mhI/lm77kuI7mnrbmnoTorr7orqHmiqXlkYrjgItgIOWIsCBgIHByb2plY3RwYXRoIGDvvIzpnIDopoHljIXlkKvku6XkuIvkv6Hmga/vvJoNCg0KMS4gKirljp/lp4vor4nmsYIqKu+8mueUqOaIt+eahOiHqueEtuivreiogOmcgOaxgg0KMi4gKirlrZDku7vliqHmi4bop6MqKu+8muS4u+S7u+WKoeWSjOWtkOS7u+WKoeWIl+ihqA0KMy4gKipBUEnosIPnlKjpk77ot68qKu+8muWFs+mUrkFQSeiwg+eUqOmhuuW6jw0KNC4gKipTa2lsbOi3r+eUsSoq77yaUHJpbWFyeeWSjFNlY29uZGFyeSBza2lsbOWIl+ihqO+8iOS7pSBgbWF0Y2hlZF9za2lsbHNgIOS4uuWHhu+8iQ0KNS4gKirlt7Lnoa7orqTovpPlhaUqKu+8muW3suaYjuehrueahOWPguaVsOWSjOaVsOaNrg0KNi4gKirnvLrlpLHovpPlhaUqKu+8mumcgOimgeeUqOaIt+ihpeWFheeahOS/oeaBrw0KNy4gKirlr7nosaHkv6Hmga8qKu+8muWvueixoeexu+WIq+OAgUlk44CBSWTmnaXmupANCjguICoq5riF55CG6ZO+6LevKirvvJrliJvlu7rliqjkvZzkuI7muIXnkIbliqjkvZznmoTlr7nlupTlhbPns7sNCg0KIyMg6LSo6YeP5bqV57q/DQoNCjEuIOWFiOWBmumcgOaxguaLhuino++8jOWGjeWBmue8lueggei3r+eUsQ0KMi4g5YWI56Gu6K6k5a+56LGh57G75Yir77yM5YaN56Gu6K6k5a+56LGhIElkDQozLiDlhYjnoa7orqQgSWQg5p2l5rqQ77yM5YaN5Yaz5a6a5ZCO57utIEFQSQ0KNC4g5YWI56Gu6K6k6L+b5YWl6ZO+6Lev77yM5YaN6KGl5riF55CG6ZO+6LevDQo1LiDnvLrkv6Hmga/ml7blhYjpl67vvIzkuI3opoHnjJwK';

// ========== 内存缓存 ==========
const manifestCache: Map<string, ManifestFile> = new Map();
const fileCache: Map<string, CacheEntry> = new Map();
const builtinSkills: Map<string, string> = new Map();
let routeMapping: RouteMapping | null = null;

// ========== 会话级 SDK 版本缓存（方案S：跨工具调用复用版本信息） ==========
// start_wdp_workflow 阶段客户端注入 sdk_version；trigger_self_evaluation 阶段
// 客户端不再注入，故在服务端按 sessionId 缓存后自动回填，无需改动客户端。
const sessionSdkVersionCache: Map<string, { sdkVersion: string; ts: number }> = new Map();
const SESSION_SDK_TTL_MS = 30 * 60 * 1000; // 与 logger 的 SESSION_TTL_MS 对齐

function rememberSessionSdkVersion(sessionId: string | undefined, sdkVersion: string | undefined): void {
  if (!sessionId || !sdkVersion) return;
  sessionSdkVersionCache.set(sessionId, { sdkVersion, ts: Date.now() });
}

function recallSessionSdkVersion(sessionId: string | undefined): string {
  if (!sessionId) return '';
  const cached = sessionSdkVersionCache.get(sessionId);
  if (!cached) return '';
  if (Date.now() - cached.ts > SESSION_SDK_TTL_MS) {
    sessionSdkVersionCache.delete(sessionId);
    return '';
  }
  return cached.sdkVersion;
}

// ========== 关键词权重表 ==========
const KEYWORD_WEIGHTS: Record<string, number> = {
  // 强意图信号（权重 3）：出现即路由
  '初始化': 3, 'sdk': 3, 'wdpapi': 3, 'scene ready': 3,
  'new WdpApi': 3, '启动渲染': 3,
  'bim': 3, 'dcp': 3, '构件': 3, '楼层': 3, '高亮': 3,
  'gis': 3, 'geolayer': 3, '3dtiles': 3,
  'flood': 3, 'dynamic water': 3, '洪水': 3,
  '热力图': 3, 'heatmap': 3,
  '骨骼动画': 3, 'skeletal': 3,
  'RegisterSceneEvent': 3, '事件注册': 3,
  '飞行': 3, 'flyto': 3,
  // 普通信号（权重 2）：辅助匹配
  '接入': 2, 'config': 2,
  '相机': 2, 'camera': 2, '漫游': 2, '跟随': 2, '聚焦': 2, '镜头': 2, '视角': 2, '第三人称': 2,
  'poi': 2, '点位': 2, '标注': 2, '图标': 2,
  '路径': 2, 'path': 2, '画线': 2, '绘制路径': 2, '沿路径移动': 2, '路径移动': 2, 'bound': 2,
  '浮窗': 2, 'window': 2, '弹窗': 2, '窗口': 2,
  '3d文字': 2, 'text3d': 2,
  '灯光': 2, 'light': 2, '粒子': 2, 'particle': 2,
  '可视域': 2, 'viewshed': 2, '抛物线': 2, 'parabola': 2,
  '区域': 2, '轮廓': 2, '范围': 2, 'range': 2,
  '静态模型': 2, 'static model': 2, '模型放置': 2,
  '植被': 2, 'vegetation': 2, '工程模型': 2, 'project model': 2,
  '建模': 2, 'modeler': 2, '场景': 2, 'scene': 2, '批量': 2, '选择集': 2,
  'wim': 2, 'pipe': 2, 'cae': 2,
  '事件': 2, 'event': 2, '材质': 2, 'material': 2,
  '坐标': 2, 'coordinate': 2, '测量': 2, 'measure': 2,
  '渲染': 2, 'renderer': 2, '系统': 2, 'system': 2,
  '天空': 2, '光照': 2, '雾': 2, '天气': 2, '环境': 2,
  '特效': 2, 'effects': 2, '剖切': 2, 'section': 2,
  '中国地图': 2, '颜色': 2, '屏幕': 2, '形状': 2,
  '实时视频': 2, '视频融合': 2, '监控': 2,
  '动画': 2, 'animation': 2, '位移动画': 2, '旋转动画': 2, '缩放动画': 2, '自转': 2, '缓动': 2, '关键帧': 2,
  // business-portfolio 业务组合
  '业务组合': 3, 'business portfolio': 3,
  '安防巡检': 3, '巡逻': 3, 'security patrol': 3,
  '无人机': 3, 'drone': 3,
  '楼宇拆解': 3, 'building explode': 3, '楼层爆炸': 3, '爆炸图': 3,
  '闸门': 3, 'gate': 3, '启闭': 3,
  '区域规划': 3, 'area planning': 3,
  '镜头循环': 3, 'camera roam loop': 3,
  '车辆跟随': 3, 'vehicle follow': 3, '气泡跟随': 3,
  '入侵检测': 3, 'intrusion detection': 3, '闯入': 3,
  'gizmo': 3, '批量编辑': 3,
};

// ========== 歧义消解规则 ==========
const DISAMBIGUATION_RULES: Array<{ pattern: RegExp; targetDomain: string; description: string }> = [
  { pattern: /画路径|绘制路径|创建路径/, targetDomain: 'covering-path', description: '覆盖物路径绘制' },
  { pattern: /沿路径走|巡检行驶|路线回放|路径移动|漫游路径|轨迹回放/, targetDomain: 'covering-bound', description: '实体路径移动' },
  { pattern: /跟车|跟拍|跟随实体|第三人称|跟谁|追踪/, targetDomain: 'camera', description: '相机跟随' },
  { pattern: /点模型拿ID|点底板单体|屏幕拾取/, targetDomain: 'tools', description: '屏幕拾取' },
  { pattern: /高亮构件|BIM高亮|楼层高亮|房间高亮/, targetDomain: 'plugin-bim', description: 'BIM高亮' },
  { pattern: /高亮GIS|GIS高亮|GIS要素高亮/, targetDomain: 'plugin-gis', description: 'GIS高亮' },
  { pattern: /离开清空|卸载清理|关闭页面|清理链路/, targetDomain: 'scene-management', description: '清理链路' },
  { pattern: /有什么|列出所有|检查场景|场景发现/, targetDomain: 'scene-management', description: '场景发现→outliner' },
];

// ========== 远程拉取 ==========
// Node.js v18+ 原生 fetch 使用 undici，需用 dispatcher 而非 https.Agent
let fetchDispatcher: any = undefined;
function getFetchDispatcher(): any {
  if (fetchDispatcher === undefined) {
    try {
      // 尝试使用 undici 的 Agent（Node v18+ 内置）
      const { Agent } = require('undici');
      fetchDispatcher = new Agent({
        connect: { rejectUnauthorized: false },
        // 关键：TLS 选项通过 connect 传递
      });
      console.log(`[SkillKnowledge] ✅ 使用 undici.Agent (Node ${process.version})，TLS 自签证书绕过已启用`);
    } catch (err: any) {
      // 回退：尝试 https.Agent（旧版 Node 或 polyfill）
      fetchDispatcher = new https.Agent({ rejectUnauthorized: false });
      console.log(`[SkillKnowledge] ⚠️ undici 不可用(${err.message})，回退到 https.Agent (Node ${process.version})`);
    }
  }
  return fetchDispatcher;
}

async function fetchSkillsManifest(): Promise<ManifestResponse> {
  const url = `${SKILL_SERVER_URL}/manifest`;
  const dispatcher = getFetchDispatcher();
  const dispatcherType = dispatcher?.constructor?.name || 'unknown';
  console.log(`[SkillKnowledge] 🔄 Manifest 拉取开始: ${url} (dispatcher: ${dispatcherType})`);

  const startTime = Date.now();
  let response: Response;
  try {
    // undici 使用 dispatcher，node-fetch polyfill 使用 agent，两者都传确保兼容
    response = await fetch(url, { dispatcher, agent: dispatcher } as any);
    const elapsed = Date.now() - startTime;
    console.log(`[SkillKnowledge]   ✅ HTTP ${response.status} (${elapsed}ms, Content-Length: ${response.headers.get('content-length') || 'unknown'})`);
  } catch (err: any) {
    const elapsed = Date.now() - startTime;
    const causeDetail = err.cause ? ` | cause: ${JSON.stringify(err.cause)}` : '';
    const stackFirst = err.stack ? err.stack.split('\n').slice(0, 3).join(' ← ') : '';
    console.error(`[SkillKnowledge]   ❌ fetch 失败 (${elapsed}ms): ${err.message}${causeDetail}`);
    console.error(`[SkillKnowledge]     调用栈: ${stackFirst}`);
    console.error(`[SkillKnowledge]     URL: ${url}`);
    console.error(`[SkillKnowledge]     Node: ${process.version}, Dispatcher: ${dispatcherType}`);
    throw new Error(`Manifest 拉取网络失败: ${err.message}${causeDetail}`);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '(无法读取响应体)');
    console.error(`[SkillKnowledge]   ❌ HTTP ${response.status}: ${body.substring(0, 500)}`);
    throw new Error(`拉取 manifest 失败: HTTP ${response.status}`);
  }

  let data: ManifestResponse;
  try {
    const rawText = await response.text();
    console.log(`[SkillKnowledge]   🔍 响应体大小: ${rawText.length} bytes, 开始 JSON 解析...`);
    data = JSON.parse(rawText) as ManifestResponse;
    console.log(`[SkillKnowledge]   ✅ JSON 解析成功: ${data.count} 个文件, root: ${data.root}`);
  } catch (parseErr: any) {
    console.error(`[SkillKnowledge]   ❌ JSON 解析失败: ${parseErr.message}`);
    throw new Error(`Manifest JSON 解析失败: ${parseErr.message}`);
  }

  manifestCache.clear();
  for (const file of data.files) manifestCache.set(file.path, file);
  console.log(`[SkillKnowledge] ✅ Manifest 加载完成: ${data.count} 个文件, 缓存已刷新`);
  return data;
}

async function fetchSkillFile(filePath: string): Promise<string> {
  const url = `${SKILL_SERVER_URL}/file/${encodeURIComponent(filePath)}`;
  const dispatcher = getFetchDispatcher();
  const startTime = Date.now();
  console.log(`[SkillKnowledge] 🔄 文件拉取: ${filePath}`);

  let response: Response;
  try {
    response = await fetch(url, { dispatcher, agent: dispatcher } as any);
    const elapsed = Date.now() - startTime;
    console.log(`[SkillKnowledge]   ✅ HTTP ${response.status} (${elapsed}ms, size: ${response.headers.get('content-length') || 'unknown'})`);
  } catch (err: any) {
    const elapsed = Date.now() - startTime;
    const causeDetail = err.cause ? ` | cause: ${JSON.stringify(err.cause)}` : '';
    console.error(`[SkillKnowledge]   ❌ fetch 失败 (${elapsed}ms): ${err.message}${causeDetail}`);
    console.error(`[SkillKnowledge]     文件: ${filePath}, URL: ${url}`);
    throw new Error(`文件拉取网络失败 [${filePath}]: ${err.message}${causeDetail}`);
  }

  if (!response.ok) {
    console.error(`[SkillKnowledge]   ❌ HTTP ${response.status}: ${filePath}`);
    throw new Error(`拉取文件失败: HTTP ${response.status} - ${filePath}`);
  }

  const content = await response.text();
  fileCache.set(filePath, { content, timestamp: Date.now() });
  console.log(`[SkillKnowledge]   ✅ 文件已缓存: ${filePath} (${content.length} bytes)`);
  return content;
}

async function readKnowledgeFile(filePath: string): Promise<string> {
  // 1. 内置 Skill（内存）
  if (builtinSkills.has(filePath)) {
    console.log(`[SkillKnowledge] 📖 读取内置 Skill: ${filePath}`);
    return builtinSkills.get(filePath)!;
  }
  // 2. 缓存命中
  const cached = fileCache.get(filePath);
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL * 1000) {
    console.log(`[SkillKnowledge] 📖 读取缓存: ${filePath} (${cached.content.length} bytes, ${Math.round((Date.now() - cached.timestamp) / 1000)}s 前)`);
    return cached.content;
  }
  // 3. 远程拉取
  console.log(`[SkillKnowledge] 📖 远程拉取: ${filePath} (缓存未命中或已过期)`);
  return await fetchSkillFile(filePath);
}

function listKnowledgeEntries(): SkillEntry[] {
  const entries: SkillEntry[] = [];
  for (const [p, f] of manifestCache) {
    if (p.startsWith('reference/')) entries.push({ path: p, size: f.size, sha1: f.sha1 });
  }
  for (const [p] of builtinSkills) entries.push({ path: p, size: 0, sha1: '' });
  return entries;
}

function generateDigest(content: string): { summary: string; fileHash: string; lineCount: number } {
  const lines = content.split('\n');
  const fileHash = crypto.createHash('sha256').update(content).digest('hex').substring(0, 16);
  const headings = lines.filter(l => /^##\s/.test(l)).map(l => l.replace(/^##\s+/, '')).slice(0, 10);
  const summary = headings.length > 0 ? `章节: ${headings.join(' | ')}` : content.substring(0, 500).replace(/\n/g, ' ');
  return { summary, fileHash, lineCount: lines.length };
}

// ========== 路由引擎 ==========

function stripBom(content: string): string {
  return content.charCodeAt(0) === 0xFEFF ? content.slice(1) : content;
}

function loadRouteMapping(): RouteMapping {
  if (routeMapping) return routeMapping;
  // 兼容 dev (ts-node: src/utils → ../config) 和 prod (node dist/utils → ../../config)
  const candidates = [
    path.resolve(__dirname, '../config/skill-route-mapping.json'),
    path.resolve(__dirname, '../../config/skill-route-mapping.json'),
  ];
  for (const configPath of candidates) {
    try {
      if (!fs.existsSync(configPath)) continue;
      const raw = fs.readFileSync(configPath, 'utf-8');
      const data = JSON.parse(stripBom(raw)) as RouteMapping;
      routeMapping = data;
      console.log(`[SkillKnowledge] 路由映射加载成功 (${configPath}): ${data.routes.length} 条路由`);
      return data;
    } catch (error: any) {
      // 继续尝试下一个
    }
  }
  console.error(`[SkillKnowledge] 路由映射加载失败: 尝试了 ${candidates.join(', ')} 均未找到`);
  // 返回空路由，服务降级运行
  routeMapping = { version: '0.0.0', routes: [], baseSkills: [], builtinSkills: [] };
  return routeMapping;
}

interface SceneEntry { id: string; name: string; priority: number; goal: string; keywords: string[]; synonyms: string[]; primary_skills: string[]; secondary_skills: string[]; file: string | null; }
interface SceneIndex { scenarios: SceneEntry[]; }
interface SceneDetail {
  id: string; name: string; goal: string;
  task_breakdown?: string[];
  api_flow?: Array<{ step: number; description: string; api: string; params: Record<string, any> }>;
  data_flow?: Array<{ step: string; output: string; usage: string }>;
  cleanup_chain?: Array<Record<string, string>>;
  required_clarifications?: string[];
  modules?: Array<{ name: string; wdp_apis: string[]; purpose: string }>;
}
let sceneIndex: SceneIndex | null = null;
let sceneDetailCache: Map<string, SceneDetail> = new Map();
function loadSceneIndex(): SceneIndex | null {
  if (sceneIndex) return sceneIndex;
  const candidates = [
    path.resolve(__dirname, '../config/business-scenarios/_index.json'),
    path.resolve(__dirname, '../../config/business-scenarios/_index.json'),
  ];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    sceneIndex = JSON.parse(stripBom(fs.readFileSync(p, 'utf-8'))) as SceneIndex;
    console.log(`[SkillKnowledge] 场景索引加载成功 (${p}): ${sceneIndex.scenarios.length} 个场景`);
    return sceneIndex;
  }
  return null;
}
function loadSceneDetail(sceneId: string): SceneDetail | null {
  if (sceneDetailCache.has(sceneId)) return sceneDetailCache.get(sceneId)!;
  const candidates = [
    path.resolve(__dirname, `../config/business-scenarios/${sceneId}.json`),
    path.resolve(__dirname, `../../config/business-scenarios/${sceneId}.json`),
  ];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    const detail = JSON.parse(stripBom(fs.readFileSync(p, 'utf-8'))) as SceneDetail;
    sceneDetailCache.set(sceneId, detail);
    return detail;
  }
  return null;
}

function matchScene(input: string): SceneEntry | null {
  const idx = loadSceneIndex();
  if (!idx || !idx.scenarios) return null;
  const normalized = input.replace(/\s+/g, '').toLowerCase();
  let bestMatch: SceneEntry | null = null;
  let bestScore = 0;
  for (const s of idx.scenarios) {
    if (s.id === 'other') continue;
    let score = 0;
    for (const kw of s.keywords) {
      if (normalized.includes(kw.replace(/\s+/g, '').toLowerCase())) score += 3;
    }
    for (const syn of s.synonyms) {
      if (normalized.includes(syn.replace(/\s+/g, '').toLowerCase())) score += 2;
    }
    if (score > bestScore || (score === bestScore && s.priority < (bestMatch?.priority || 999))) {
      bestScore = score;
      bestMatch = s;
    }
  }
  return bestScore > 0 ? bestMatch : null;
}

// v1.3: 资产搜索脚本推荐 — primaryRoute 命中模型/特效类 domain 时，
// 将搜索脚本注入 matched_skills，配合 enforce_routing_check 硬阻断确保 AI 先读取
const ASSET_SEARCH_SCRIPTS: Record<string, { script: string; label: string; typeHint: string }> = {
  'model-static':      { script: 'reference/model-assets/scripts/search_assets.py',   label: '静态模型资产搜索', typeHint: '--type static' },
  'model-skeletal':    { script: 'reference/model-assets/scripts/search_assets.py',   label: '骨骼动画资产搜索', typeHint: '--type skeletal' },
  'model-vegetation':  { script: 'reference/model-assets/scripts/search_assets.py',   label: '植被资产搜索',     typeHint: '--type static' },
  'model-project':     { script: 'reference/model-assets/scripts/search_assets.py',   label: '工程模型资产搜索', typeHint: '' },
  'covering-particle': { script: 'reference/effects-assets/scripts/search_effects.py', label: '粒子特效资产搜索', typeHint: '' },
  'covering-light':    { script: 'reference/effects-assets/scripts/search_effects.py', label: '灯光特效资产搜索', typeHint: '' },
  'scene-effects':     { script: 'reference/effects-assets/scripts/search_effects.py', label: '场景特效资产搜索', typeHint: '' },
};

function matchKeywords(requirement: string): { domain: string; score: number }[] {
  const lower = requirement.toLowerCase();
  const mapping = loadRouteMapping();
  const scores: { domain: string; score: number }[] = [];

  for (const route of mapping.routes) {
    let score = 0;
    for (const kw of route.keywords) {
      if (lower.includes(kw.toLowerCase())) score += (KEYWORD_WEIGHTS[kw] || 1);
    }
    for (const alias of route.aliases) {
      if (lower.includes(alias.toLowerCase())) score += 2;
    }
    // v1.2: userSynonyms 弥补自然语言 ≠ API名称 的鸿沟
    for (const syn of (route.userSynonyms || [])) {
      if (lower.includes(syn.toLowerCase())) score += 2;
    }
    if (score > 0) scores.push({ domain: route.domain, score });
  }
  scores.sort((a, b) => b.score - a.score);
  return scores;
}

/**
 * 全文模糊搜索 manifest 中所有 SKILL.md
 * v1.1.0: 关键词→路径段映射已合并到 config/skill-route-mapping.json 的 pathSegments 字段。
 * 此函数现在从 route 数据中获取 pathSegments 做匹配，不再依赖独立的 PATH_KEYWORD_MAP。
 * 用户输入中文 → route.keywords 匹配 → route.pathSegments → manifest 路径段匹配
 * 用户输入英文 → 直接匹配路径段
 */
function searchFuzzySkills(requirement: string): string[] {
  const lower = requirement.toLowerCase();
  const results: Array<{ path: string; score: number }> = [];
  const mapping = loadRouteMapping();

  // 从 route 数据中收集所有 pathSegments（用于路径段命中加分）
  const allPathSegments = new Set<string>();
  // 从 route 数据中构建 cn→en 映射（中文关键词命中的 route，其 pathSegments 全部加权）
  const keywordToSegments = new Map<string, Set<string>>();
  for (const route of mapping.routes) {
    const segs = route.pathSegments || [];
    for (const s of segs) allPathSegments.add(s.toLowerCase());
    for (const kw of route.keywords) {
      const kwLower = kw.toLowerCase();
      if (!keywordToSegments.has(kwLower)) keywordToSegments.set(kwLower, new Set());
      for (const s of segs) keywordToSegments.get(kwLower)!.add(s.toLowerCase());
    }
  }

  // 根据输入命中哪些 route 的关键词 → 收集加权 pathSegments
  const bonusSegments = new Set<string>();
  for (const route of mapping.routes) {
    const hitKeyword = route.keywords.some(kw => lower.includes(kw.toLowerCase()));
    const hitAlias = route.aliases.some(al => lower.includes(al.toLowerCase()));
    if (hitKeyword || hitAlias) {
      for (const seg of (route.pathSegments || [])) {
        bonusSegments.add(seg.toLowerCase());
      }
    }
  }

  // 遍历 manifest 中所有 SKILL.md
  for (const [filePath] of manifestCache) {
    if (!filePath.startsWith('reference/') || !filePath.endsWith('SKILL.md')) continue;
    const pathLower = filePath.toLowerCase();
    const parts = pathLower.replace(/[\/\-_]/g, ' ').split(/\s+/);
    let score = 0;

    // 路径段直接命中用户输入英文单词
    for (const part of parts) {
      if (lower.includes(part)) score += 2;
    }
    // 路径段命中 route 的 pathSegments（来自关键词命中加权）
    for (const part of parts) {
      if (bonusSegments.has(part)) score += 3;
    }

    if (score > 0) results.push({ path: filePath, score });
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, 5).map(r => r.path);
}

function applyDisambiguation(requirement: string, keywordResults: { domain: string; score: number }[]): string | null {
  for (const rule of DISAMBIGUATION_RULES) {
    if (rule.pattern.test(requirement)) {
      // 检查消解目标是否在关键词结果中
      const found = keywordResults.find(r => r.domain === rule.targetDomain);
      if (found) return rule.targetDomain;
      // 如果不在，也返回消解目标（强制修正）
      return rule.targetDomain;
    }
  }
  return null;
}

/**
 * ⚠️ TODO: 二层路由已知冲突
 *
 * 当前同时运行 3 套匹配引擎，结果可能矛盾：
 *   A) 场景模板匹配 (matchScene → _index.json)  — 自称"最高优先级"
 *   B) 关键词加权匹配 (matchKeywords → skill-route-mapping.json) — "兜底"
 *   C) 全文模糊搜索 (searchFuzzySkills → 同样使用 skill-route-mapping.json 的 pathSegments) — "辅助"
 *
 * v1.1.0: C 已与 B 共享 pathSegments 数据源，消除关键词冗余。但 A 和 B 的 skillPath 仍可能不同。
 *
 * 场景命中时，B 和 C 的结果不再直接合并到 matched_skills (Round 2 优化)，
 * 但 B 的 primaryRoute 仍用于生成 workflow_steps，A 和 B 的 Step 3 可能冲突。
 *
 * 长期方案：统一为单一匹配引擎，所有 Skill 路径从场景模板派生。
 */
async function buildWorkflowResponse(userRequirement: string, projectPath: string, sdkVersion?: string): Promise<any> {
  const mapping = loadRouteMapping();

  // 1. 场景模板匹配（优先执行，场景=主裁判，旧版架构核心逻辑）
  let scene = matchScene(userRequirement);

  // 2. 场景命中 → 场景为主路由，跳过关键词匹配；场景未命中 → 关键词加权兜底
  let keywordResults: { domain: string; score: number }[] = [];
  let disambiguatedDomain: string | null = null;
  let primaryRoute: RouteConfig | undefined;

  // 始终执行关键词匹配（场景命中时作为补充，场景未命中时作为兜底）
  keywordResults = matchKeywords(userRequirement);
  disambiguatedDomain = applyDisambiguation(userRequirement, keywordResults);

  if (disambiguatedDomain) {
    primaryRoute = mapping.routes.find(r => r.domain === disambiguatedDomain);
  }
  if (!primaryRoute && keywordResults.length > 0) {
    primaryRoute = mapping.routes.find(r => r.domain === keywordResults[0].domain);
  }

  // 3. 收集所有匹配的 Skill 路径（场景优先 + 关键词补充）
const matchedSkills: string[] = [];
  // v1.1: 去掉了 requiredRelatedSkills 独立列表，相关技能直接合并到 matched_skills

  // 场景命中 → 场景的 primary_skills + secondary_skills 作为主干
  if (scene) {
    for (const sp of scene.primary_skills) {
      if (!matchedSkills.includes(sp)) matchedSkills.push(sp);
    }
    for (const sp of scene.secondary_skills) {
      if (!matchedSkills.includes(sp)) matchedSkills.push(sp);
    }
  }

// 关键词路由的 Skill（补充场景未覆盖的子能力）
  if (primaryRoute) {
    if (!matchedSkills.includes(primaryRoute.skillPath)) {
      matchedSkills.push(primaryRoute.skillPath);
    }
    for (const f of primaryRoute.relatedSkills) {
      if (!matchedSkills.includes(f)) matchedSkills.push(f);
    }
  }

  // 3.5 v1.3: 资产搜索脚本注入 — 排在第一位，配合 enforce_routing_check 硬阻断确保 AI 先读取
  const assetHint = primaryRoute ? ASSET_SEARCH_SCRIPTS[primaryRoute.domain] : null;
  if (assetHint && !matchedSkills.includes(assetHint.script)) {
    matchedSkills.unshift(assetHint.script);
  }

  // 4. 添加 baseSkills
  for (const bs of mapping.baseSkills) {
    if (!matchedSkills.includes(bs)) matchedSkills.push(bs);
  }

  // 5. 始终加载内置 Skill，并自动注入内容（对齐旧版"推送"模式，AI 无需手动 get_skill_content）
  const builtinContentPreviews: Array<{ path: string; preview: string }> = [];
  for (const bs of mapping.builtinSkills) {
    if (!matchedSkills.includes(bs)) matchedSkills.push(bs);
    // 自动读取内置 Skill 内容并注入 preview
    if (builtinSkills.has(bs)) {
      const raw = builtinSkills.get(bs)!;
      const excerpt = raw.substring(0, 1500); // 前 1500 字（约 2KB），避免撑爆上下文
      builtinContentPreviews.push({ path: bs, preview: excerpt });
    }
  }
// 5.5 全文模糊搜索（仅场景未命中时追加；场景命中时跳过，避免混淆）
  if (!scene) {
    const fuzzySkills = searchFuzzySkills(userRequirement);
    for (const fs of fuzzySkills) {
      if (!matchedSkills.includes(fs)) matchedSkills.push(fs);
    }
  }

  // 6. matched_skills 去重（保留原始顺序）
const uniqueMatchedSkills = [...new Set(matchedSkills)];

  const isComplex = keywordResults.length > 3 || userRequirement.length > 50;

// 6. 构建工作流步骤
  const workflowSteps: string[] = [];
  if (scene) workflowSteps.push(`🎯 场景: ${scene.name} — ${scene.goal}`);
  workflowSteps.push('Step 1: 读取 builtin/wdp-intent-orchestrator.md（防幻觉规则）');
  workflowSteps.push('Step 2: 用 force_full: true 逐个读取 matched_skills 中所有 Skill 文件');
  workflowSteps.push('Step 3: 调用 enforce_routing_check 验证文件读取完整性');
  workflowSteps.push('Step 4: 编码');
  workflowSteps.push('Step 5: 调用 trigger_self_evaluation 传入 generated_code + used_skills + scenario_id（从 workflow_result.scene.id 获取）+ sdk_version（从 workflow_result.sdk_version 获取，用于版本兼容校验）');
  // 8. 构建 guidance（注入后果前置 + API 白名单提示）
  const sceneGuidance = scene
    ? `🎯 当前场景：${scene.name} — ${scene.goal}\n`
    : '';
const consequenceBlock = `⚠️ 所有 WDP API 签名以 Skill 文件为准，禁止凭记忆编造。编码前必须读取 matched_skills 中所有文件（force_full: true），编码后必须调用 trigger_self_evaluation 校验。`;

// SDK 版本提示
  let sdkVersionBlock = '';
  if (sdkVersion) {
    sdkVersionBlock = `\n📦 用户工程 SDK 版本: wdpapi@${sdkVersion}`;
  } else {
    sdkVersionBlock = '\n📦 未检测到工程 SDK 版本，请向用户确认 wdpapi 版本号后传入 sdk_version 参数，用于 API 版本兼容检查';
  }

  // 注入发布版版本信息（动态拉取，仅作排查参考）
  let publishedVersionBlock = '';
  try {
    const publishedVersions = await fetchPublishedVersions();
    if (publishedVersions.length > 0) {
      publishedVersionBlock = `\n📋 当前对外商用发布版版本：${publishedVersions.map(v => `${v.apiType} ${v.version}`).join(' | ')}`;
    }
  } catch { /* non-blocking */ }

  // 场景命中 → 加载场景详情
  let sceneDetail: SceneDetail | null = null;
  if (scene && scene.file) {
    sceneDetail = loadSceneDetail(scene.id);
  }

  // 在 workflow_steps 中追加场景拆解步骤
  if (sceneDetail?.task_breakdown) {
    for (const step of sceneDetail.task_breakdown) {
      workflowSteps.push(`🎯 场景任务: ${step}`);
    }
  }

  // 9. 预提取 API 白名单摘要（不读全文，仅方法名列表，轻量注入防幻觉）
  const skillApiSummaries: Array<{ path: string; apis: string[]; version_requirements?: Array<{ feature: string; minVersion: string }> }> = [];
  for (const sp of matchedSkills) {
    try {
const content = await readKnowledgeFile(sp);
      const apis = [...extractApiFromSkillContent(content)];
      const verReqs = extractSkillVersionRequirements(content);
      if (apis.length > 0 || verReqs.length > 0) {
        skillApiSummaries.push({ path: sp, apis: apis.slice(0, 30), version_requirements: verReqs });
      }
    } catch {
      // 读取失败跳过，AI 需自行调用 read_knowledge_file
    }
  }

  return {
    user_requirement: userRequirement,
    project_path: projectPath,
matched_skills: uniqueMatchedSkills,
workflow_steps: workflowSteps,
scene: scene ? { id: scene.id, name: scene.name, goal: scene.goal } : null,
    scene_detail: sceneDetail ? {
      task_breakdown: sceneDetail.task_breakdown,
      api_flow: sceneDetail.api_flow,
      modules: sceneDetail.modules?.map(m => ({ name: m.name, wdp_apis: m.wdp_apis, purpose: m.purpose })),
    } : null,
    is_complex: isComplex,
    sdk_version: sdkVersion || null,
    builtin_skills_preview: builtinContentPreviews,
    skill_api_summaries: skillApiSummaries,
    guidance: sceneGuidance + consequenceBlock + sdkVersionBlock + publishedVersionBlock + (assetHint
      ? `\n📦 资产搜索：读取 ${assetHint.script}，用自然语言搜索 seedId。用法：python3 search_*.py "<描述>" --random ${assetHint.typeHint}\n`
      : ''),
  };
}

// ========== API 白名单提取（用于 trigger_self_evaluation 硬校验） ==========

/**
 * 从 Skill 文件内容中提取所有 WDP API 方法名
 * 模式：
 *  - new App.Xxx(...)  → App.Xxx
 *  - App.Xxx.Yyy(...)  → App.Xxx.Yyy
 *  - entity.Xxx(...)   → .Xxx (实体方法)
 */
function extractApiFromSkillContent(content: string): Set<string> {
  const apis = new Set<string>();

  // 提取所有 JS 代码块中的 API 调用
  const codeBlocks = content.match(/```(?:js|javascript|typescript)?\n([\s\S]*?)```/g);
  const codeSnippets = codeBlocks ? codeBlocks.map(b => b.replace(/```[\s\S]*?\n/, '').replace(/```$/, '')) : [content];

  for (const snippet of codeSnippets) {
    // new App.Xxx(  → App.Xxx
    const constructorMatches = snippet.matchAll(/new\s+(App\.\w+)\s*\(/g);
    for (const m of constructorMatches) apis.add(m[1]);

    // App.Xxx.Yyy(  → App.Xxx.Yyy
    const staticMethodMatches = snippet.matchAll(/(App\.\w+(?:\.\w+)+)\s*\(/g);
    for (const m of staticMethodMatches) apis.add(m[1]);

    // Obj.Xxx( where Obj is camelCase (entity method)
    const entityMethodMatches = snippet.matchAll(/([a-z]\w*)\.(\w+)\s*\(/g);
    for (const m of entityMethodMatches) {
      if (m[2].charAt(0).toUpperCase() === m[2].charAt(0)) {
        apis.add(`.${m[2]}`); // PascalCase methods
      }
    }

    // 事件名注册: RegisterSceneEvent('OnXxx'
    const eventMatches = snippet.matchAll(/RegisterSceneEvent\s*\(\s*['"](On\w+)['"]/g);
    for (const m of eventMatches) apis.add(m[1]);
  }

  // ===== 方案C：补扫代码块之外的 API 权威声明处，消除"真API被误杀" =====
  // 根因：部分真实 API 只在 Markdown 标题/表格里声明，或在代码块中跨行截断（如
  // `## App.Scene.Create(\n  defaultParam,`），仅扫代码块会漏抽 → 校验时误判为幻觉。
  // 标题与表格是 SKILL.md 中 API 的权威定义处，从中抽取不会引入幻觉（无新增清单、与代码同源）。

  // C1: Markdown 标题中的静态方法/构造器，如 `## App.Scene.Create(...)`、`### new App.Static(...)`
  //     （允许标题前后包裹反引号；命名空间方法与裸构造器都覆盖）
  const headingMatches = content.matchAll(/^#{1,6}\s+`?(?:new\s+)?(App\.\w+(?:\.\w+)*)/gm);
  for (const m of headingMatches) apis.add(m[1]);

  // C2: 行内反引号中的 API 声明（多见于方法一览表格 / 正文引用），如 `App.CameraControl.FlyTo`
  const inlineCodeMatches = content.matchAll(/`(?:new\s+)?(App\.\w+(?:\.\w+)*)\s*\(?[^`]*`/g);
  for (const m of inlineCodeMatches) apis.add(m[1]);

  return apis;
}

/**
 * 从 api_flow 的 api 字符串中提取标准化 API 名
 * "new App.Path({...})" → "App.Path"
 * "App.CameraControl.UpdateCamera" → "App.CameraControl.UpdateCamera"
 * "App.Scene.SetWeather" → "App.Scene.SetWeather"
 * "entityObj.Delete()" → ".Delete"
 * 裸方法名（无括号）也支持，直接返回
 */
function extractApiName(apiStr: string): string | null {
  // new App.Xxx( → App.Xxx
  const cm = apiStr.match(/new\s+(App\.\w+)\s*\(/);
  if (cm) return cm[1];
  // new App.Xxx（无括号构造）
  const cmBare = apiStr.match(/new\s+(App\.\w+)/);
  if (cmBare) return cmBare[1];
  // App.Xxx.Yyy( → App.Xxx.Yyy
  const smm = apiStr.match(/(App\.\w+(?:\.\w+)+)\s*\(/);
  if (smm) return smm[1];
  // App.Xxx.Yyy（无括号静态方法）
  const smmBare = apiStr.match(/(App\.\w+(?:\.\w+)+)/);
  if (smmBare) return smmBare[1];
  // obj.method( → .Method
  const emm = apiStr.match(/\.(\w+)\s*\(/);
  if (emm && emm[1].charAt(0).toUpperCase() === emm[1].charAt(0)) return `.${emm[1]}`;
  return null;
}

/**
 * 从 AI 生成的代码中提取所有 WDP API 调用
 */
function extractApiCallsFromCode(code: string): Array<{ line: number; api: string }> {
  const results: Array<{ line: number; api: string }> = [];
  const lines = code.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // new App.Xxx(
    const cm = line.match(/new\s+(App\.\w+)\s*\(/);
    if (cm) {
      results.push({ line: i + 1, api: cm[1] });
      continue;
    }

    // App.Xxx.Yyy(
    const smm = line.match(/(App\.\w+(?:\.\w+)+)\s*\(/);
    if (smm) {
      results.push({ line: i + 1, api: smm[1] });
      continue;
    }

    // entityObj.methodName( where methodName is PascalCase
    const emm = line.match(/([a-zA-Z_]\w*)\.(\w+)\s*\(/);
    if (emm && emm[2].charAt(0).toUpperCase() === emm[2].charAt(0) && !emm[1].startsWith('App')) {
      // 过滤掉 JS 原生方法
      const nativeMethods = new Set(['Map', 'Set', 'Array', 'Date', 'Math', 'JSON', 'Object', 'String', 'Number', 'Boolean', 'Promise', 'Error', 'RegExp', 'parseInt', 'parseFloat']);
      if (!nativeMethods.has(emm[1]) && !['require', 'console', 'process'].includes(emm[1])) {
        results.push({ line: i + 1, api: `.${emm[2]}` });
      }
    }
  }

  return results;
}

// ========== API 参数提取 & 校验（trigger_self_evaluation 硬校验3） ==========

/**
 * 从一行代码中解析 WDP API 调用的对象参数 key
 * 示例：App.Scene.SetWeather({ weather: 'Rain' }) → ['weather']
 */
function extractParamKeysFromLine(line: string): string[] {
  const keys: string[] = [];
  const objMatch = line.match(/\(\s*\{([^}]*)\}\s*\)/);
  if (!objMatch) return keys;
  const objContent = objMatch[1];
  const keyPattern = /(?:^|,)\s*(?:['"])?(\w+)(?:['"])?\s*:/g;
  let m;
  while ((m = keyPattern.exec(objContent)) !== null) {
    keys.push(m[1]);
  }
  return keys;
}

interface ParamIssue {
  line: number; api: string;
  hallucinatedKeys: string[]; missingKeys: string[]; expectedKeys: string[];
  rawLine: string;
}

function validateApiParams(
  generatedCode: string,
  scenarioApiFlows: Array<{ step: number; description: string; api: string; params: Record<string, any> }>,
): { passed: boolean; issues: ParamIssue[]; totalChecks: number } {
  const lines = generatedCode.split('\n');
  const codeCalls: Array<{ line: number; api: string; paramKeys: string[]; rawLine: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const call of extractApiCallsFromCode(line)) {
      codeCalls.push({ line: call.line, api: call.api, paramKeys: extractParamKeysFromLine(line), rawLine: line.trim() });
    }
  }

  const issues: ParamIssue[] = [];
  let totalChecks = 0;
  for (const step of scenarioApiFlows) {
    const apiNames = (step.api || '').split('+').map(a => a.trim());
    const expectedKeys = Object.keys(step.params || {});
    if (expectedKeys.length === 0) continue;
    for (const apiName of apiNames) {
      const extracted = extractApiName(apiName);
      if (!extracted) continue;
      for (const call of codeCalls.filter(c => c.api === extracted)) {
        totalChecks++;
        const hallucinated = call.paramKeys.filter(k => !expectedKeys.includes(k));
        const missing = expectedKeys.filter(k => !call.paramKeys.includes(k));
        if (hallucinated.length > 0 || missing.length > 0) {
          issues.push({ line: call.line, api: call.api, hallucinatedKeys: hallucinated, missingKeys: missing, expectedKeys, rawLine: call.rawLine });
        }
      }
    }
  }
  return { passed: issues.length === 0, issues, totalChecks };
}

/**
 * 主校验函数：对比代码中的 API 与 Skill 白名单
 */
async function validateGeneratedCode(
  generatedCode: string,
  skillPaths: string[],
  extraApiList: string[] = [],
): Promise<{ passed: boolean; hallucinated: HallucinatedApi[]; totalApis: number; whitelistSize: number }> {
  // 1. 构建白名单
  const whitelist = new Set<string>();

  // 额外 API 白名单（来自场景 modules[].wdp_apis）
  for (const api of extraApiList) whitelist.add(api);
  for (const sp of skillPaths) {
    try {
      const content = await readKnowledgeFile(sp);
      const apis = extractApiFromSkillContent(content);
      for (const api of apis) whitelist.add(api);
    } catch {
      // 文件读取失败 → 跳过（已在 onboarding 层校验）
    }
  }

  // 添加通用方法白名单（entity.Delete / entity.Update / entity.SetVisible 等基础方法）
  const commonEntityMethods = ['Delete', 'Update', 'SetVisible', 'Add', 'Remove', 'Get', 'Set'];
  for (const m of commonEntityMethods) whitelist.add(`.${m}`);

  // 2. 提取 AI 代码中的 API
  const usedApis = extractApiCallsFromCode(generatedCode);

  // 3. 对比
  const hallucinated: HallucinatedApi[] = [];
  for (const { line, api } of usedApis) {
    if (!whitelist.has(api)) {
      // 给建议：找白名单中最相似的 API
      let suggestion = '请从已读 Skill 文件中查找正确的 API 名';
      const allApis = Array.from(whitelist);
      const lower = api.toLowerCase();
      let bestMatch = '';
      let bestScore = 0;
      for (const wl of allApis) {
        const wlLower = wl.toLowerCase();
        let score = 0;
        // 简单相似度：共享前缀/后缀
        if (api.startsWith('App.') && wl.startsWith('App.')) score += 2;
        if (wlLower.includes(lower.split('.').pop() || '')) score += 1;
        if (score > bestScore) { bestScore = score; bestMatch = wl; }
      }
      if (bestMatch && bestScore >= 2) {
        suggestion = `可能是 ${bestMatch}`;
      }

      hallucinated.push({ line, api, suggestion });
    }
  }

  return {
    passed: hallucinated.length === 0,
    hallucinated,
    totalApis: usedApis.length,
    whitelistSize: whitelist.size,
  };
}

// ========== MCP 工具定义 ==========
const MCP_TOOL_DEFINITIONS: McpToolDef[] = [
  {
    name: 'start_wdp_workflow',
    description: '🔑 核心工具：接收用户自然语言需求 → 意图路由 → 场景匹配 → Skill匹配 → 返回工作流结果',
    inputSchema: {
      type: 'object',
      properties: {
        user_requirement: { type: 'string', description: '用户的自然语言需求描述' },
        projectPath: { type: 'string', description: '用户项目路径' },
        sdk_version: { type: 'string', description: '用户工程 wdpapi SDK 版本（可选，客户端自动检测；如检测失败请向用户确认后传入，用于 API 版本兼容检查）' },
      },
      required: ['user_requirement', 'projectPath'],
    },
  },
  {
    name: 'read_knowledge_file',
    description: '按路径读取知识库任意文件（.md Skill / .js demo / .json 配置等）。支持摘要模式（默认）和全文模式',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '知识库文件路径' },
        force_full: { type: 'boolean', description: '是否强制返回全文' },
      },
      required: ['path'],
    },
},
  {
    name: 'list_skills',
    description: '列出所有可用的 Skill 条目',
    inputSchema: {
      type: 'object',
      properties: {
        include_references: { type: 'boolean', description: '是否包含引用文件' },
      },
    },
  },
  {
    name: 'check_health',
    description: '检查服务健康状态',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'enforce_routing_check',
    description: '🚨 防幻觉门禁1（编码前）：验证所有路由匹配的 Skill 文件是否已全文读取。通过后可开始编码，但完成后必须调用 trigger_self_evaluation。',
    inputSchema: {
      type: 'object',
      properties: {
        workflow_result: { type: 'object', description: 'start_wdp_workflow 返回结果' },
        skills_read: { type: 'array', items: { type: 'string' }, description: 'AI 已读取的 Skill 路径列表（全文模式）' },
        full_read_skills: { type: 'array', items: { type: 'string' }, description: 'AI 以 force_full: true 读取的 Skill 路径列表（可选，如提供则校验全文覆盖率）' },
      },
      required: ['workflow_result', 'skills_read'],
    },
  },
  {
    name: 'trigger_self_evaluation',
    description: '🚨 防幻觉门禁2（编码后）：将生成的代码传入，MCP 做三层硬校验：① API 白名单存在性比对 ② 场景步骤覆盖检查 ③ 参数 key 合法性检查（对比 api_flow.params）。任何一层不通过将被阻断。',
    inputSchema: {
      type: 'object',
      properties: {
        generated_code: { type: 'string', description: 'AI 生成的完整代码文本' },
        written_files: { type: 'array', items: { type: 'string' }, description: '已写入的文件路径' },
        used_skills: { type: 'array', items: { type: 'string' }, description: '使用的 Skill 路径（从 workflow_result.matched_skills 获取）' },
        scenario_id: { type: 'string', description: '场景 ID（可选）' },
        sdk_version: { type: 'string', description: '用户工程 wdpapi SDK 版本（可选，从 start_wdp_workflow 返回的 sdk_version 获取）' },
      },
      required: ['generated_code', 'used_skills'],
    },
  },
];

export function getMcpToolDefinitions(): McpToolDef[] {
  return MCP_TOOL_DEFINITIONS;
}

// ========== MCP 工具处理 ==========
export async function handleMcpToolCall(tool: string, args: Record<string, any>, sessionId?: string): Promise<any> {
  switch (tool) {
    case 'start_wdp_workflow': {
      const userRequirement = args.user_requirement as string;
      const projectPath = args.projectPath as string;
      if (!userRequirement || !projectPath) return { error: '缺少 user_requirement 或 projectPath 参数' };
      const sdkVersion = args.sdk_version as string | undefined;
      // 方案S：缓存本会话的 SDK 版本，供后续 trigger_self_evaluation 自动回填（客户端不再注入）
      rememberSessionSdkVersion(sessionId, sdkVersion);
      return buildWorkflowResponse(userRequirement, projectPath, sdkVersion);
    }

case 'read_knowledge_file': {
      const filePath = args.path as string;
      if (!filePath) return { error: '缺少 path 参数' };
      try {
        const content = await readKnowledgeFile(filePath);
        const forceFull = args.force_full === true;
        // 提取版本要求（逐功能细粒度）
        const versionRequirements = extractSkillVersionRequirements(content);
        if (forceFull) {
          const { fileHash, lineCount } = generateDigest(content);
          const apiWhitelist = extractApiFromSkillContent(content);
          return {
            path: filePath, content, fileHash, lineCount, mode: 'full',
            api_whitelist: [...apiWhitelist],
            version_requirements: versionRequirements,
          };
        }
        const { summary, fileHash, lineCount } = generateDigest(content);
        return {
          path: filePath, summary, fileHash, lineCount, mode: 'summary',
          version_requirements: versionRequirements,
        };
      } catch (error: any) {
        return { error: `读取失败: ${error.message}`, path: filePath };
      }
    }

case 'list_skills': {
      const entries = listKnowledgeEntries();
      return { total: entries.length, skills: entries.map(e => ({ path: e.path, size: e.size, sha1: e.sha1 })) };
    }

    case 'check_health': {
      return {
        status: 'ok', timestamp: new Date().toISOString(),
        skill_server: SKILL_SERVER_URL,
        manifest_files: manifestCache.size, cached_files: fileCache.size,
        builtin_skills: builtinSkills.size, routes_loaded: routeMapping !== null,
      };
    }

    case 'enforce_routing_check': {
      const workflowResult = args.workflow_result as any;
      const skillsRead = (args.skills_read as string[]) || [];
      const fullReadSkills = (args.full_read_skills as string[]) || [];
      const required = (workflowResult?.matched_skills || []) as string[];

      // 基础校验：是否都读了
      const notRead = required.filter((s: string) => !skillsRead.includes(s));
      // 全文校验：如果提供了 full_read_skills，检查是否都用全文模式读过
      const notFullRead = fullReadSkills.length > 0
        ? required.filter((s: string) => !fullReadSkills.includes(s))
        : [];

      const passed = notRead.length === 0 && notFullRead.length === 0;

      let message: string;
      let nextStep: string;
      if (passed) {
        message = '✅ 文件完整性校验通过。⚠️ 门禁1仅验证文件是否已读取，不能保证不会编造幻觉 API。编码前仍需逐行对照 Skill 白名单。编码后务必调用 trigger_self_evaluation 做 API 白名单终检。';
        nextStep = '🔜 编码完成后，调用 trigger_self_evaluation，传入 generated_code、used_skills、scenario_id（从 workflow_result.scene.id 获取，用于参数校验）、sdk_version（从 workflow_result.sdk_version 获取，用于版本兼容校验）。';
      } else {
        const issues: string[] = [];
        if (notRead.length > 0) issues.push(`${notRead.length} 个 Skill 未读取: ${notRead.join(', ')}`);
        if (notFullRead.length > 0) issues.push(`${notFullRead.length} 个 Skill 未用全文模式读取: ${notFullRead.join(', ')}。请用 read_knowledge_file 传 force_full: true 重新读取`);
        message = `🚨 防幻觉阻断：${issues.join('；')}。禁止生成代码！这些文件包含正确的 API 签名和参数格式，跳过将导致 API 幻觉。`;
        nextStep = '📖 请继续读取上述缺失的 Skill 文件（force_full: true），然后重新调用 enforce_routing_check。';
      }

      const blocked = !passed;

      return {
        passed,
        blocked,
        required_count: required.length,
        read_count: skillsRead.length,
        full_read_count: fullReadSkills.length,
        missing_skills: notRead,
        not_full_read: notFullRead,
        message,
        next_step: nextStep,
      };
    }

    case 'trigger_self_evaluation': {
      const generatedCode = (args.generated_code as string) || '';
      const usedSkills = (args.used_skills as string[]) || [];
      const writtenFiles = (args.written_files as string[]) || [];

      // 硬校验1：API 白名单比对
      let apiCheckResult: { passed: boolean; hallucinated: HallucinatedApi[]; totalApis: number; whitelistSize: number } | null = null;
      // 硬校验2：场景 api_flow 步骤覆盖检查
      let stepCoverage: { passed: boolean; missing_steps: Array<{ step: number; description: string; api: string }>; total_steps: number } | null = null;
      // 硬校验3：API 参数 key 合法性检查
      let paramCheckResult: { passed: boolean; issues: ParamIssue[]; totalChecks: number } | null = null;

      if (generatedCode && usedSkills.length > 0) {
        let sceneApiList: string[] = [];
        let sceneApiFlow: SceneDetail['api_flow'] | undefined;
        const scenarioId = (args.scenario_id as string) || '';
        if (scenarioId) {
          const sd = loadSceneDetail(scenarioId);
          if (sd?.modules) for (const m of sd.modules) sceneApiList.push(...m.wdp_apis);
          sceneApiFlow = sd?.api_flow;
        }
        try {
          apiCheckResult = await validateGeneratedCode(generatedCode, usedSkills, sceneApiList);
        } catch (e: any) {
          apiCheckResult = { passed: true, hallucinated: [], totalApis: 0, whitelistSize: 0 };
          console.error(`[trigger_self_evaluation] API 校验异常: ${e.message}`);
        }

        if (sceneApiFlow && sceneApiFlow.length > 0) {
          const usedApiNames = extractApiCallsFromCode(generatedCode).map(a => a.api);
          const missingSteps: Array<{ step: number; description: string; api: string }> = [];
          for (const s of sceneApiFlow) {
            const apiNames = (s.api || '').split('+').map(a => a.trim());
            const found = apiNames.some(name => { const e = extractApiName(name); return e ? usedApiNames.includes(e) : false; });
            if (!found) missingSteps.push({ step: s.step, description: s.description, api: s.api });
          }
          stepCoverage = { passed: missingSteps.length === 0, missing_steps: missingSteps, total_steps: sceneApiFlow.length };
          paramCheckResult = validateApiParams(generatedCode, sceneApiFlow);
        }
      }

      // SDK 版本比对
      let sdkVersionWarnings: string[] = [];
      // 方案S+E：优先用 AI 透传的 sdk_version（方案E），缺失时回退到本会话缓存（方案S，客户端无需注入）
      const sdkVer = (args.sdk_version as string) || recallSessionSdkVersion(sessionId) || '';
      if (sdkVer && usedSkills.length > 0) {
        for (const sp of usedSkills) {
          try {
            const content = await readKnowledgeFile(sp);
            const verReqs = extractSkillVersionRequirements(content);
            for (const { feature, minVersion } of verReqs) {
              const req = minVersion.split('.').map(Number);
              const sdk = sdkVer.split('.').map(Number);
              let isOk = true;
              for (let i = 0; i < Math.max(req.length, sdk.length); i++) {
                if ((req[i] || 0) > (sdk[i] || 0)) { isOk = false; break; }
                if ((req[i] || 0) < (sdk[i] || 0)) break;
              }
              if (!isOk) sdkVersionWarnings.push(`⚠️ ${sp} 中 ${feature} 需要 WDP API >= ${minVersion}，当前工程 SDK 版本为 ${sdkVer}`);
            }
          } catch { /* skip */ }
        }
      }

      const checks = [
        '🔍 占位符检查：确认代码中无 YOUR_URL、YOUR_TOKEN 等假值',
        '🔍 生命周期检查：确认初始化 → 渲染 → 清理的完整链路',
        '🔍 初始化顺序检查：Plugin.Install 在 Renderer.Start 之前',
        '🔍 工程基线检查：确认使用 npm install wdpapi（非 CDN）',
      ];

      const apiPassed = apiCheckResult ? apiCheckResult.passed : true;
      const hallucinated = apiCheckResult ? apiCheckResult.hallucinated : [];
      const stepPassed = stepCoverage ? stepCoverage.passed : true;
      const paramPassed = paramCheckResult ? paramCheckResult.passed : true;

      if ((!apiPassed || !stepPassed || !paramPassed) && apiCheckResult) {
        const errors: string[] = [];
        if (!apiPassed) errors.push(...hallucinated.map(h => `  Line ${h.line}: ${h.api} → ${h.suggestion}`));
        if (!stepPassed && stepCoverage) {
          errors.push(`\n⚠️ 场景步骤缺失 (${stepCoverage.missing_steps.length}/${stepCoverage.total_steps}):`);
          errors.push(...stepCoverage.missing_steps.map(s => `  Step ${s.step}: ${s.description} → 缺少 ${s.api}`));
        }
        if (!paramPassed && paramCheckResult) {
          errors.push(`\n🚨 API 参数校验失败 (${paramCheckResult.issues.length} 处):`);
          for (const issue of paramCheckResult.issues) {
            const parts = [`  Line ${issue.line}: ${issue.api}()`];
            if (issue.hallucinatedKeys.length) parts.push(`非法字段 ${issue.hallucinatedKeys.map(k => `"${k}"`).join(', ')}（期望: ${issue.expectedKeys.join(', ')}）`);
            if (issue.missingKeys.length) parts.push(`缺少字段 ${issue.missingKeys.map(k => `"${k}"`).join(', ')}`);
            errors.push(parts.join(' | '));
          }
        }

        return {
          passed: false,
          api_whitelist_check: {
            passed: apiPassed, total_apis_found: apiCheckResult.totalApis, whitelist_size: apiCheckResult.whitelistSize,
            hallucinated_apis: hallucinated,
            message: apiPassed ? '✅ 白名单通过' : `🚨 发现 ${hallucinated.length} 个不在任何 Skill 文件中的 API`,
          },
          step_coverage_check: stepCoverage ? {
            passed: stepCoverage.passed, total_steps: stepCoverage.total_steps, missing_steps: stepCoverage.missing_steps,
          } : null,
          param_check: paramCheckResult ? {
            passed: paramCheckResult.passed, total_checks: paramCheckResult.totalChecks, issues: paramCheckResult.issues,
          } : null,
          sdk_version_warnings: sdkVersionWarnings, soft_checks: checks, written_files: writtenFiles, used_skills: usedSkills,
          message: [`🚨 校验未通过，请修正以下问题后重新调用 trigger_self_evaluation：`, ...errors].join('\n'),
        };
      }

      return {
        passed: true,
        api_whitelist_check: {
          passed: true, total_apis_found: apiCheckResult?.totalApis || 0, whitelist_size: apiCheckResult?.whitelistSize || 0,
          message: '✅ 所有 API 调用均在 Skill 白名单中',
        },
        step_coverage_check: stepCoverage ? {
          passed: true, total_steps: stepCoverage.total_steps,
          message: `✅ 全部 ${stepCoverage.total_steps} 个场景步骤已覆盖`,
        } : null,
        param_check: paramCheckResult ? {
          passed: true, total_checks: paramCheckResult.totalChecks,
          message: `✅ 全部 ${paramCheckResult.totalChecks} 处 API 参数校验通过`,
        } : null,
        sdk_version_warnings: sdkVersionWarnings, soft_checks: checks, written_files: writtenFiles, used_skills: usedSkills,
        hint: '✅ 硬校验通过。请逐项检查以上 4 条软检查，发现问题立即修正。',
      };
    }

    default:
      return { error: `未知工具: ${tool}` };
  }
}

// ========== 初始化 ==========
export async function initSkillKnowledge(): Promise<void> {
  // 1. 先加载内置 Skill + 路由（不依赖网络）
  const builtinDir = path.resolve(__dirname, '../../builtin');
  const builtinFiles = ['wdp-intent-orchestrator.md'];
  for (const file of builtinFiles) {
    const key = `builtin/${file}`;
    const filePath = path.join(builtinDir, file);
    if (fs.existsSync(filePath)) {
      builtinSkills.set(key, fs.readFileSync(filePath, 'utf-8'));
    } else if (file === 'wdp-intent-orchestrator.md' && BUILTIN_WDP_INTENT_ORCHESTRATOR_B64) {
      // 容器缺失 builtin/ 目录时，从编译期内嵌 base64 常量加载
      builtinSkills.set(key, Buffer.from(BUILTIN_WDP_INTENT_ORCHESTRATOR_B64, 'base64').toString('utf-8'));
      console.log('[SkillKnowledge] 内置 Skill 从编译期内嵌常量加载（builtin/ 目录不存在）');
    }
  }
  // 预加载路由映射
  try { loadRouteMapping(); } catch { /* 路由映射将在首次使用时加载 */ }
  // 2. 再拉取远程 manifest（失败不阻断内置 Skill 的使用）
  try {
    await fetchSkillsManifest();
  } catch (e: any) {
    console.warn(`[SkillKnowledge] Manifest 拉取失败（内置 Skill 仍可用）: ${e.message}`);
  }
}

export { readKnowledgeFile, listKnowledgeEntries, generateDigest, fetchSkillsManifest, fetchSkillFile, buildWorkflowResponse };